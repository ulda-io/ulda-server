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
let errors = 0, asyncErrors = 0, reads = 0, limits = 0, active = false;
const loop = monitorEventLoopDelay({ resolution: 20 });
try {
  const url = new URL(init.url); assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.protocol, 'http:');
  const { Ulda, SocketIoTransport } = await import(pathToFileURL(init.entry).href);
  for (const master of init.masters) {
    const transport = new SocketIoTransport(init.url, { allowInsecureLocalhost: true, timeout: 60000 });
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
  const start = await message('start');
  await new Promise(resolve => setTimeout(resolve, Math.max(0, start.at - Date.now())));
  const begun = performance.now(); const cpu = process.cpuUsage(); active = true; loop.enable();
  await Promise.all(clients.map(async c => {
    const begin = performance.now();
    try {
      await c.ulda.connect(c.master.id, init.password);
      const finished = performance.now();
      assert(c.contentStart > 0);
      const values = c.ulda.snapshot();
      assert.equal(Object.keys(values).length, init.contents);
      assert(Object.values(values).every(value => value.marker === 'synthetic-read-sizing'));
      samples.push({ openMs: finished - begin, contentMs: finished - c.contentStart });
    } catch (error) {
      errors++; samples.push({ code: typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'CHECK_FAILED', stage: c.contentStart > 0 ? 'content' : 'master' });
    }
  }));
  loop.disable(); active = false;
  const used = process.cpuUsage(cpu);
  send({ kind: 'result', errors, asyncErrors, reads, limits, limitsByRequestSize, samples, readAcks, elapsedMs: performance.now() - begun,
    maxRssBytes: process.resourceUsage().maxRSS * 1024, cpuMicros: used.user + used.system, loopP99Ms: loop.percentile(99) / 1e6 });
} catch { process.exitCode = 1; send({ kind: 'failed' }); }
finally { await Promise.allSettled(clients.map(c => c.ulda.close())); if (process.connected) process.disconnect(); }
