// Child generator only: public npm SDK, synthetic data, no arbitrary target input.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { Ulda, SocketIoTransport } from "./sdk.mjs";
import { Histogram, loadFailureCode } from "./metrics.mjs";
import { deliverResult } from "./result-delivery.mjs";

assert(process.send, "Run via npm run test:capacity");
const clients = [], latency = new Histogram(), ack = new Histogram();
let stop = false, active = false, attempted = 0, confirmed = 0, failed = 0, pushes = 0, asyncErrors = 0;
let measurementStart = 0, lastCompletion = 0, afterDeadline = 0;
const send = data => { if (process.connected) process.send(data); };
process.on("message", message => { if (message?.action === "stop") stop = true; });
const onceMessage = action => new Promise(resolve => {
  const handler = message => { if (message?.action === action) { process.off("message", handler); resolve(message); } };
  process.on("message", handler);
});
const init = await onceMessage("init");
const target = new URL(init.url);
assert.equal(target.hostname, "127.0.0.1"); assert.equal(target.protocol, "http:");
assert(Number.isInteger(init.clients) && init.clients > 0 && init.clients <= 100);
const text = "x".repeat(1000), password = "synthetic-capacity-" + randomUUID();
const eventLoop = monitorEventLoopDelay({resolution:20});
let exitCode = 0, phase = 'clients';
const abort = (error, origin) => {
  stop = true;
  send({ kind: 'abort', phase: origin, code: loadFailureCode(error), attempted, confirmed, failed, asyncErrors });
};
try {
  for (let i = 0; i < init.clients; i++) {
    const transport = new SocketIoTransport(init.url, { allowInsecureLocalhost:true, timeout:10_000 });
    const ulda = new Ulda(init.url, {transport,reconnect:false});
    const client = {ulda,seq:0}; clients.push(client);
    transport.on("trace", event => {
      if (!active) return;
      if (event.phase === "ack" && event.event === "ulda:update" && Number.isFinite(event.durationMs)) ack.add(event.durationMs);
      if (event.phase === "push") pushes++;
    });
    ulda.on("error", error => { if (active) { asyncErrors++; abort(error, 'async'); } });
    await ulda.register(password);
    await ulda.add("item", {seq:0,text}, "X");
  }
  send({kind:"ready",clients:clients.length});
  const command = await onceMessage("start");
  phase = 'warmup';
  const warmEnd = performance.now() + command.warmup * 1000;
  await Promise.all(clients.map(async c => {
    while (!stop && performance.now() < warmEnd) await c.ulda.update("item", {seq:++c.seq,text});
  }));
  if (stop) throw new Error("Warmup interrupted");
  send({kind:"warmed"});
  const measure = await onceMessage("measure");
  await new Promise(resolve => setTimeout(resolve, Math.max(0, measure.startAt - Date.now())));
  const deadline = performance.now() + measure.seconds * 1000;
  measurementStart = performance.now(); lastCompletion = measurementStart;
  phase = 'measurement';
  const cpuStart = process.cpuUsage(); eventLoop.enable(); active=true;
  const progress = setInterval(() => send({kind:"progress",attempted,confirmed,failed,rss:process.memoryUsage().rss}),5000);
  try {
    await Promise.all(clients.map(async c => {
      while (!stop && performance.now() < deadline) {
        attempted++; const start=performance.now();
        try { await c.ulda.update("item",{seq:++c.seq,text}); confirmed++; }
        catch (error) { failed++; abort(error, 'update'); }
        const end=performance.now(); lastCompletion=Math.max(lastCompletion,end);
        if(end>deadline)afterDeadline++;
        latency.add(end-start);
      }
    }));
  } finally { clearInterval(progress); active=false; eventLoop.disable(); }
  const cpu=process.cpuUsage(cpuStart), durationMs=lastCompletion-measurementStart;
  if (stop || failed || asyncErrors) throw new Error("Measurement failed");
  // Verify remote state using the same 100 connections, outside the timed window.
  phase = 'verification';
  for (const c of clients) { await c.ulda.refresh(); assert.equal(c.ulda.value("item").seq,c.seq); }
  const report={kind:"result",attempted,confirmed,failed,asyncErrors,pushes,afterDeadline,durationMs,
    latency:latency.export(),ack:ack.export(),cpuMicros:cpu.user+cpu.system,
    eventLoopP99Ms:eventLoop.percentile(99)/1e6,maxRss:process.resourceUsage().maxRSS*1024,
    finalVerified:clients.length,jsonBytes:Buffer.byteLength(JSON.stringify({seq:clients[0].seq,text}))};
  phase = 'report';
  await deliverResult(process, report);
} catch (error) { exitCode=1; send({kind:"failed",phase,code:loadFailureCode(error),attempted,confirmed,failed,asyncErrors}); }
finally {
  // No write replay or superDelete after an ambiguous outcome; parent owns the DB.
  await Promise.allSettled(clients.map(c=>c.ulda.close()));
  if(process.connected)process.disconnect(); process.exitCode=exitCode;
}
