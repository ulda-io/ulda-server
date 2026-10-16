import { Encoder, PacketType } from "socket.io-parser";
import { io, type Socket } from "socket.io-client";
import { afterEach, expect, it } from "vitest";
import { createUldaServer, type UldaServer } from "../../src/app/create-server.js";
import { loadConfig, type AppConfig } from "../../src/config/config.js";
import { InMemoryResourceStorage } from "../../src/storage/in-memory-resource-storage.js";
import type { CreateStoredResource, StorageReadBounds } from "../../src/domain/ports.js";
import { SDK_LIMITS } from "../../src/protocol/sdk-commands.js";

let server: UldaServer | undefined, endpoint = "";
const sockets: Socket[] = [], gates: Array<() => void> = [];
function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); gates.push(resolve); return { resolve, promise }; }
async function setup(limits: Partial<AppConfig["limits"]> = {}, storage = new InMemoryResourceStorage()) {
  const config = loadConfig({ LOG_LEVEL: "error" }); config.host = "127.0.0.1"; config.port = 0;
  Object.assign(config.limits, limits); server = createUldaServer({ config, storage });
  endpoint = "http://127.0.0.1:" + (await server.start()).port; return storage;
}
async function connect() {
  const socket = io(endpoint, { transports: ["websocket"], reconnection: false, forceNew: true }); sockets.push(socket);
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); }); return socket;
}
const ack = (socket: Socket, action: string, body: unknown) => socket.timeout(2000).emitWithAck("ulda:" + action, body);
const item = (size = 1) => ({ witness: Uint8Array.of(1), payload: new Uint8Array(size) });
afterEach(async () => {
  for (const release of gates.splice(0)) release();
  for (const socket of sockets.splice(0)) socket.close();
  await server?.close(); server = undefined;
});
it("copy reservation fails with a fixed ACK before Create and frees memory for the next request", async () => {
  const storage = await setup({ maxInflightBytes: 5000 }); const a = await connect();
  expect(await ack(a, "create", [item(1000)])).toEqual({ ok: false, error: "too_large" });
  expect(await storage.findById(1n)).toBeNull(); expect(server!.router.subscriptions(a.id!)).toEqual([]);
  expect(server!.admission.input.used).toBe(0);
  expect(await ack(a, "create", [item()])).toEqual({ ok: true, data: ["1"] });
  expect(server!.admission.input.used).toBe(0);
});
it("active read reserve rejects independent extra work before storage, then becomes reusable", async () => {
  const entered = gate(), release = gate(); let blocked = true, calls = 0;
  class Storage extends InMemoryResourceStorage {
    override async findManyByIds(ids: readonly bigint[], bounds?: StorageReadBounds) {
      calls++; if (blocked) { entered.resolve(); await release.promise; }
      return super.findManyByIds(ids, bounds);
    }
  }
  const perRow = SDK_LIMITS.payloadBytes + SDK_LIMITS.witnessBytes;
  await setup({ maxActiveReadBytes: perRow }, new Storage()); const a = await connect(), b = await connect();
  await ack(a, "create", [item(), item()]);
  const read = ack(a, "read", ["1"]); await entered.promise;
  expect(await ack(b, "read", ["2"])).toEqual({ ok: false, error: "too_large" });
  expect(calls).toBe(1); expect(server!.router.subscriptions(b.id!)).toEqual([]);
  blocked = false; release.resolve(); expect((await read).ok).toBe(true);
  expect((await ack(b, "read", ["2"])).ok).toBe(true);
  expect(server!.admission.reads.used).toBe(0); expect(server!.admission.input.used).toBe(0);
});
it("disconnect does not free accepted mutation memory or skip graceful drain", async () => {
  const entered = gate(), release = gate();
  class Storage extends InMemoryResourceStorage {
    override async createBatch(items: readonly CreateStoredResource[]) { entered.resolve(); await release.promise; return super.createBatch(items); }
  }
  const storage = await setup({ maxConnections: 1 }, new Storage()), a = await connect();
  const id = a.id!, pending = ack(a, "create", [item(100)]).catch(() => null);
  await entered.promise; const held = server!.admission.input.used; expect(held).toBeGreaterThan(0);
  a.close(); await expect.poll(() => server!.admission.connections.count).toBe(0);
  expect(server!.admission.input.used).toBe(held); expect(server!.admission.pending).toBe(1);
  let closed = false; const active = server!, close = active.close().then(() => { closed = true; });
  await Promise.resolve(); expect(closed).toBe(false); expect(active.admission.input.used).toBe(held);
  release.resolve(); await close; await pending; server = undefined;
  expect(await storage.findById(1n)).not.toBeNull(); expect(active.router.subscriptions(id)).toEqual([]);
  expect(active.admission.input.used).toBe(0); expect(active.admission.pending).toBe(0);
});
it("a first incomplete binary command times out even before hello, clears budget and frees a connection slot", async () => {
  await setup({ maxConnections: 1, binaryPacketTimeoutMs: 100 }); const a = await connect();
  const frames = new Encoder().encode({ type: PacketType.EVENT, nsp: "/", id: 99, data: ["ulda:create", [item(20)]] });
  const disconnected = new Promise<void>(resolve => a.once("disconnect", () => resolve()));
  a.io.engine.write(frames[0]); a.io.engine.write(frames[1]);
  await disconnected;
  await expect.poll(() => server!.admission.connections.count).toBe(0);
  expect(server!.admission.input.used).toBe(0); expect(server!.admission.pending).toBe(0);
  expect(await server!.storage.findById(1n)).toBeNull();
  const b = await connect(); expect(await ack(b, "hello", {})).toEqual({ ok: true });
});
it("parallel asynchronous handshakes cannot overbook connection capacity", async () => {
  await setup({ maxConnections: 2 }); const entered = gate(), release = gate(); let calls = 0;
  const original = server!.io.engine.generateId.bind(server!.io.engine);
  server!.io.engine.generateId = async req => { if (++calls === 2) entered.resolve(); await release.promise; return original(req); };
  const attempts = Array.from({ length: 3 }, () => connect().then(() => "connected", () => "rejected"));
  await entered.promise; expect(server!.admission.connections.count).toBe(2); release.resolve();
  const results = await Promise.all(attempts);
  expect(results.filter(x => x === "connected")).toHaveLength(2);
  expect(results.filter(x => x === "rejected")).toHaveLength(1);
  expect(calls).toBe(2); expect(server!.io.engine.clientsCount).toBe(2);
});
it("failed asynchronous handshake releases its slot", async () => {
  await setup({ maxConnections: 1 });
  const original = server!.io.engine.generateId.bind(server!.io.engine);
  server!.io.engine.generateId = async () => { throw new Error("synthetic handshake failure"); };
  await expect(connect()).rejects.toBeDefined(); expect(server!.admission.connections.count).toBe(0);
  server!.io.engine.generateId = original; expect((await connect()).connected).toBe(true);
});
it("unknown, missing-ACK, invalid and closed-session events do not retain ingress reservations", async () => {
  await setup(); const a = await connect();
  a.emit("ulda:create", [item()]);
  expect(await a.timeout(1000).emitWithAck("unknown", {})).toEqual({ ok: false, error: "invalid_request" });
  expect(await ack(a, "create", [])).toEqual({ ok: false, error: "invalid_request" });
  expect(await ack(a, "session.close", {})).toEqual({ ok: true });
  expect(await ack(a, "hello", {})).toEqual({ ok: false, error: "invalid_request" });
  expect(server!.admission.input.used).toBe(0); expect(server!.admission.pending).toBe(0);
  expect(await server!.storage.findById(1n)).toBeNull();
});
it("an oversized stored row is refused without publishing a partial read or subscription", async () => {
  const storage = await setup(); const a = await connect();
  await storage.createBatch([item(), item(SDK_LIMITS.payloadBytes + 1)]);
  expect(await ack(a, "read", ["1", "2"])).toEqual({ ok: false, error: "too_large" });
  expect(server!.router.subscriptions(a.id!)).toEqual([]);
  expect(server!.admission.reads.used).toBe(0); expect(server!.admission.input.used).toBe(0);
});

it("polling-to-WebSocket upgrade keeps one physical connection slot", async () => {
  await setup({ maxConnections: 1 });
  const a = io(endpoint, { transports: ["polling", "websocket"], reconnection: false, forceNew: true }); sockets.push(a);
  await new Promise<void>((resolve, reject) => { a.once("connect", resolve); a.once("connect_error", reject); });
  expect(await ack(a, "hello", {})).toEqual({ ok: true });
  if (a.io.engine.transport.name !== "websocket") await new Promise<void>(resolve => a.io.engine.once("upgrade", () => resolve()));
  expect(server!.admission.connections.count).toBe(1);
  await expect(connect()).rejects.toBeDefined();
  expect(await ack(a, "hello", {})).toEqual({ ok: true });
});
it("resource-queue refusal frees only the rejected request charge", async () => {
  const entered = gate(), release = gate(); let block = true;
  class Storage extends InMemoryResourceStorage {
    override async findManyByIds(ids: readonly bigint[], bounds?: StorageReadBounds) {
      if (block) { entered.resolve(); await release.promise; }
      return super.findManyByIds(ids, bounds);
    }
  }
  await setup({ maxQueuedPerResource: 1 }, new Storage()); const a = await connect(), b = await connect();
  await ack(a, "create", [item()]);
  const read = ack(a, "read", ["1"]); await entered.promise; const held = server!.admission.input.used;
  expect(await ack(b, "read", ["1"])).toEqual({ ok: false, error: "too_large" });
  expect(server!.admission.input.used).toBe(held); expect(server!.admission.pending).toBe(1);
  block = false; release.resolve(); expect((await read).ok).toBe(true);
  expect(server!.admission.input.used).toBe(0);
});

it("global subscription capacity rejects before mutation; duplicate read and disconnect release correctly", async () => {
  const storage = await setup({ maxSubscriptionsTotal: 3 }), a = await connect(), b = await connect();
  await ack(a, "create", [item(), item()]); expect(server!.router.subscriptionTotal).toBe(2);
  expect(await ack(a, "create", [item(), item()])).toEqual({ ok: false, error: "too_large" });
  expect(await storage.findById(3n)).toBeNull();
  expect((await ack(b, "read", ["1"])).ok).toBe(true); expect(server!.router.subscriptionTotal).toBe(3);
  expect((await ack(b, "read", ["1"])).ok).toBe(true); expect(server!.router.subscriptionTotal).toBe(3);
  expect(await ack(b, "read", ["2"])).toEqual({ ok: false, error: "too_large" });
  b.close(); await expect.poll(() => server!.router.subscriptionTotal).toBe(2);
  const c = await connect(); expect((await ack(c, "read", ["2"])).ok).toBe(true);
  expect(server!.router.subscriptionTotal).toBe(3); expect(server!.admission.input.used).toBe(0);
});

it("global subscription reservations include independent in-flight reads before any Create mutation", async () => {
  const entered = gate(), release = gate(); let block = true, creates = 0;
  class Storage extends InMemoryResourceStorage {
    override async createBatch(items: readonly CreateStoredResource[]) { creates++; return super.createBatch(items); }
    override async findManyByIds(ids: readonly bigint[], bounds?: StorageReadBounds) {
      if (block) { entered.resolve(); await release.promise; }
      return super.findManyByIds(ids, bounds);
    }
  }
  await setup({ maxSubscriptionsTotal: 2 }, new Storage());
  const a = await connect(), b = await connect(), c = await connect();
  expect((await ack(a, "create", [item()])).ok).toBe(true);
  const pending = ack(b, "read", ["1"]); await entered.promise;
  expect(server!.router.subscriptionTotal).toBe(1);
  expect(await ack(c, "create", [item()])).toEqual({ ok: false, error: "too_large" });
  expect(creates).toBe(1);
  block = false; release.resolve(); expect((await pending).ok).toBe(true);
  expect(server!.router.subscriptionTotal).toBe(2);
  b.close(); await expect.poll(() => server!.router.subscriptionTotal).toBe(1);
  expect(await ack(c, "create", [item()])).toEqual({ ok: true, data: ["2"] });
  expect(server!.admission.input.used).toBe(0); expect(creates).toBe(2);
});
