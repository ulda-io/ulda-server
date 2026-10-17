import test from "node:test";
import assert from "node:assert/strict";
import { Histogram, loadOptions } from "./metrics.mjs";
// Keep candidate loading covered by the existing capacity-tool CI entry.
import './sdk.test.mjs';

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
