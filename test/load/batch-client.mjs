// Synthetic read benchmark worker. Imports the public ESM entry of an isolated
// candidate; it never attaches to a user's SDK, database or browser session.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
assert(process.send);
const message = action => new Promise(resolve => {
  const listener = m => { if (m.action === action) { process.off('message', listener); resolve(m); } };
  process.on('message', listener);
});
const send = value => { if (process.connected) process.send(value); };
const init = await message('init');
const clients = [], samples = [], readAcks = [];
const limitsByRequestSize = {};
let errors = 0, skipped = 0, asyncErrors = 0, reads = 0, limits = 0, active = false;
const measurements = [];
const loop = monitorEventLoopDelay({ resolution: 20 });
try {
  const url = new URL(init.url); assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.protocol, 'http:');
  const { Ulda, SocketIoTransport } = await import(pathToFileURL(init.entry).href);
  for (const master of init.masters) {
    const transport = new SocketIoTransport(init.url, { allowInsecureLocalhost: true });
    const ulda = new Ulda(init.url, { transport, reconnect: false });
    const c = { ulda, master, contentStart: 0 }, pendingReads = new Map();
    ulda.on('error', () => { if (active) asyncErrors++; });
    ulda.on('trace', event => {
      if (!active) return;
      if (event.phase === 'client' && event.event === 'master.catalog') c.contentStart = performance.now();
    });
    transport.on('trace', event => {
      if (!active || event.event !== 'ulda:read') return;
      if (event.phase === 'send') { reads++; pendingReads.set(event.request, event.ids.length); }
      if (event.phase === 'ack' && event.code === 'LIMIT') {
        limits++;
        const size = pendingReads.get(event.request); assert(size > 0);
        limitsByRequestSize[size] = (limitsByRequestSize[size] ?? 0) + 1;
      }
      if (event.phase === 'ack' && event.event === 'ulda:read' && !event.code && Number.isFinite(event.durationMs)) readAcks.push(event.durationMs);
      if (event.phase === 'ack' || event.phase === 'failure') pendingReads.delete(event.request);
    });
    await ulda.ready; clients.push(c);
  }
  send({ kind: 'ready' });
  for (const phase of ['connect', 'refresh']) {
    const start = await message(phase === 'connect' ? 'start' : 'refresh');
    await new Promise(resolve => setTimeout(resolve, Math.max(0, start.at - Date.now())));
    errors = 0; skipped = 0; asyncErrors = 0; reads = 0; limits = 0; samples.length = 0; readAcks.length = 0;
    for (const key of Object.keys(limitsByRequestSize)) delete limitsByRequestSize[key];
    loop.reset();
    const begun = performance.now(), cpu = process.cpuUsage(); active = true; loop.enable();
    await Promise.all(clients.map(async c => {
      c.contentStart = 0; const begin = performance.now();
      if (phase === 'refresh' && !c.open) { skipped++; samples.push({ skipped: true, stage: 'connect-failed' }); return; }
      try {
        if (phase === 'connect') { await c.ulda.connect(c.master.id, init.password); c.open = true; }
        else await c.ulda.refresh();
        const finished = performance.now();
        const values = c.ulda.snapshot();
        assert.equal(Object.keys(values).length, init.contents);
        assert(Object.values(values).every(value => value.marker === 'synthetic-read-sizing'));
        samples.push({ openMs: finished - begin, ...(c.contentStart ? { contentMs: finished - c.contentStart } : {}) });
      } catch (error) {
        errors++; samples.push({ code: typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'CHECK_FAILED', stage: c.contentStart > 0 ? 'content' : 'master-or-refresh' });
      }
    }));
    loop.disable(); active = false;
    const used = process.cpuUsage(cpu);
    measurements.push({ phase, errors, skipped, asyncErrors, reads, limits, limitsByRequestSize: { ...limitsByRequestSize }, samples: [...samples], readAcks: [...readAcks], elapsedMs: performance.now() - begun,
      maxRssBytes: process.resourceUsage().maxRSS * 1024, cpuMicros: used.user + used.system, loopP99Ms: loop.percentile(99) / 1e6 });
    if (phase === 'connect') send({ kind: 'connected' });
  }
  send({ kind: 'result', measurements });
} catch { process.exitCode = 1; send({ kind: 'failed' }); }
finally { await Promise.allSettled(clients.map(c => c.ulda.close())); if (process.connected) process.disconnect(); }
