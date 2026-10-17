import test from "node:test";
import assert from "node:assert/strict";
import { Histogram, loadOptions, loadFailureCode, loadWorkerStatus } from "./metrics.mjs";
// Keep candidate loading covered by the existing capacity-tool CI entry.
import './sdk.test.mjs';
import './result-delivery.test.mjs';

test('capacity failures expose only fixed codes, never private diagnostics', () => {
  const secret = 'synthetic-private-error-detail';
  assert.equal(loadFailureCode({ code: 'UNKNOWN_OUTCOME', message: secret, stack: secret }), 'UNKNOWN_OUTCOME');
  assert.equal(loadFailureCode({ code: secret }), 'CHECK_FAILED');
  assert.equal(loadFailureCode(new Error(secret)), 'CHECK_FAILED');
  assert.equal(loadFailureCode({ get code() { throw new Error(secret); } }), 'CHECK_FAILED');
  assert.equal(loadFailureCode(null), 'CHECK_FAILED');
  let reads = 0;
  assert.equal(loadFailureCode({ get code() { return ++reads <= 2 ? 'TIMEOUT' : secret; } }), 'TIMEOUT');
  assert.equal(reads, 1);
});

test('capacity worker diagnostics project safe phases, counts and exit state without raw IPC data', () => {
  const secret = 'synthetic-private-error-detail';
  const child = { ready: true, warmed: true, failed: true, exited: true, exitCode: 1,
    report: { privateData: secret }, credentials: secret,
    failure: { phase: 'verification', code: 'TIMEOUT', attempted: 12, confirmed: 12,
      failed: 0, asyncErrors: 0, message: secret, stack: secret } };
  assert.deepEqual(loadWorkerStatus(child, 2), { worker: 2, ready: true, warmed: true, failed: true,
    exited: true, reportReceived: true, exitCode: 1,
    failure: { phase: 'verification', code: 'TIMEOUT', attempted: 12, confirmed: 12, failed: 0, asyncErrors: 0 } });
  child.failure = { phase: secret, code: secret, attempted: secret, confirmed: Infinity, failed: -1, asyncErrors: {} };
  child.exitCode = null; child.report = null;
  const status = loadWorkerStatus(child, 0);
  assert.deepEqual(status.failure, { phase: 'unknown', code: 'CHECK_FAILED', attempted: null, confirmed: null, failed: null, asyncErrors: null });
  assert.equal(status.exitCode, null); assert.equal(status.reportReceived, false);
  assert.equal(JSON.stringify(status).includes(secret), false);
});

test("merged capacity histograms preserve every sample and expose overflow", () => {
  const a = new Histogram(), b = new Histogram();
  for (let i = 1; i <= 100; i++) (i <= 30 ? a : b).add(i);
  a.merge(b.export());
  assert.deepEqual(a.summary(), { count: 100, meanMs: 50.5, p50Ms: 50, p95Ms: 95, p99Ms: 99, maxMs: 100, overflow: 0 });
  a.add(70_000); assert.equal(a.summary().overflow, 1); assert.equal(a.summary().maxMs, 70_000);
  assert.throws(() => a.add(NaN));
});

test("capacity defaults have no request-rate knob and reject unbounded runs", () => {
  assert.deepEqual(loadOptions({}), { clients: 100, workers: 4, seconds: 1800, warmup: 10, profile: "host" });
  for (const bad of [{ULDA_LOAD_CLIENTS:"101"},{ULDA_LOAD_SECONDS:"Infinity"},{ULDA_LOAD_WORKERS:"0"},
    {ULDA_LOAD_SECONDS:"3601"},{ULDA_LOAD_PROFILE:"unsafe"},{ULDA_LOAD_CLIENTS:"1",ULDA_LOAD_WORKERS:"2"}]) assert.throws(() => loadOptions(bad));
});
