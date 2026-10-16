import { io, type Socket } from "socket.io-client";
import { afterEach, expect, it, vi } from "vitest";
import { createUldaServer, type UldaServer } from "../../src/app/create-server.js";
import { loadConfig, type AppConfig } from "../../src/config/config.js";
import { IngressOwner } from "../../src/admission/server-admission.js";
import { DomainError } from "../../src/domain/errors.js";
import { createLogger, type Logger } from "../../src/observability/logger.js";
import type { CreateStoredResource, StoredChange, StorageReadBounds, UldaVerifier, ProofVerifier } from "../../src/domain/ports.js";
import { InMemoryResourceStorage, FakeUldaVerifier } from "../support/fakes.js";

let server: UldaServer | undefined, endpoint = "";
const sockets: Socket[] = [], releases: Array<() => void> = [];
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  releases.push(resolve); return { promise, resolve };
}
const item = (step = 1) => ({ witness: Uint8Array.of(step), payload: Uint8Array.of(91) });
const change = (id = "1", step = 2) => ({ id, ...item(step) });
async function setup(options: {
  storage?: InMemoryResourceStorage; ulda?: UldaVerifier; proof?: ProofVerifier;
  logger?: Logger;
  limits?: Partial<AppConfig["limits"]>;
} = {}) {
  const config = loadConfig({ LOG_LEVEL: "error" }); config.host = "127.0.0.1"; config.port = 0;
  Object.assign(config.limits, options.limits);
  const storage = options.storage ?? new InMemoryResourceStorage();
  server = createUldaServer({ config, storage, ulda: options.ulda ?? new FakeUldaVerifier(),
    ...(options.proof ? { proof: options.proof } : {}), ...(options.logger ? { logger: options.logger } : {}) });
  endpoint = "http://127.0.0.1:" + (await server.start()).port;
  return storage;
}
async function connect() {
  const socket = io(endpoint, { transports: ["websocket"], reconnection: false, forceNew: true }); sockets.push(socket);
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
  return socket;
}
const ack = (socket: Socket, action: string, body: unknown) => socket.timeout(2000).emitWithAck("ulda:" + action, body);
async function idle() {
  await expect.poll(() => {
    const s = server!.admission.snapshot();
    return [s.pending, s.inputBytes, s.readBytes, s.outputBytes, s.outputPackets];
  }).toEqual([0, 0, 0, 0, 0]);
}
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const socket of sockets.splice(0)) socket.close();
  if (server) {
    await server.close(); await idle();
    expect(server.admission.connections.count).toBe(0);
    expect(server.router.subscriptionTotal).toBe(0);
  }
  server = undefined;
});

it("returns only the SDK wire fields and subscribes Create/Read before invoking their ACKs", async () => {
  await setup(); const a = await connect(), b = await connect();
  const seen: string[] = [];
  for (const socket of [a, b]) server!.io.sockets.sockets.get(socket.id!)!.use((event, next) => {
    const reply = event.at(-1);
    event[event.length - 1] = (value: unknown) => {
      if (event[0] === "ulda:create" || event[0] === "ulda:read") {
        expect(server!.router.subscriptions(socket.id!)).toEqual([1n]); seen.push(event[0]);
      }
      reply(value);
    };
    next();
  });
  expect(await ack(a, "create", [item()])).toEqual({ ok: true, data: ["1"] });
  expect(await ack(b, "read", ["1"])).toEqual({ ok: true, data: [{ id: "1", witness: Buffer.from([1]), payload: Buffer.from([91]) }] });
  expect(seen).toEqual(["ulda:create", "ulda:read"]);
  expect(await a.timeout(2000).emitWithAck("resource:read", { id: "1", private: "synthetic" }))
    .toEqual({ ok: false, error: "invalid_request" });
  expect(await ack(a, "hello", {})).toEqual({ ok: true });
  expect(await ack(a, "session.close", {})).toEqual({ ok: true });
  expect(server!.router.subscriptions(a.id!)).toEqual([]);
  await idle();
});

it.each(["update", "delete"])("%s holds locks through commit, subscription, Changed and ACK, then admits an overlapping Read", async action => {
  const order: string[] = [], entered = gate(), release = gate();
  class Storage extends InMemoryResourceStorage {
    override async findManyByIds(ids: readonly bigint[], bounds?: StorageReadBounds) {
      order.push("read:" + ids.join(",")); return super.findManyByIds(ids, bounds);
    }
    override async applyBatch(changes: readonly StoredChange[]) {
      order.push("write"); entered.resolve(); await release.promise;
      await super.applyBatch(changes); order.push("commit");
    }
  }
  const storage = await setup({ storage: new Storage(),
    ulda: { async verify() { order.push("verify"); return true; } },
    proof: { async verify() { order.push("proof"); return true; } },
  });
  await storage.createBatch([item(), item()]);
  const a = await connect(), b = await connect(), outsider = await connect();
  await ack(b, "read", ["1", "2"]); order.length = 0;
  const local = server!.io.sockets.sockets.get(a.id!)!;
  const subscriber = server!.io.sockets.sockets.get(b.id!)!;
  const authored: unknown[] = [], unrelated: unknown[] = [], delivered: unknown[] = [];
  a.on("ulda:changed", value => authored.push(value)); outsider.on("ulda:changed", value => unrelated.push(value));
  b.on("ulda:changed", value => delivered.push(value));
  subscriber.onAnyOutgoing(event => { if (event === "ulda:changed") order.push("changed"); });
  local.use((event, next) => {
    const reply = event.at(-1);
    event[event.length - 1] = (value: unknown) => {
      expect(server!.router.subscriptions(a.id!)).toEqual(action === "delete" ? [2n] : [1n, 2n]);
      order.push("ack"); reply(value);
    }; next();
  });
  const first = action === "delete" ? { id: "1", witness: Uint8Array.of(2) } : change();
  const write = ack(a, action, [first, change("2")]); await entered.promise;
  const read = ack(b, "read", ["2"]);
  // Hello completes independently, providing a wire barrier after the queued Read.
  expect(await ack(b, "hello", {})).toEqual({ ok: true });
  expect(order).toEqual(["read:1,2", "verify", "proof", "verify", "proof", "write"]);
  expect(server!.admission.pending).toBe(2); expect(delivered).toEqual([]);
  release.resolve(); expect(await write).toEqual({ ok: true });
  expect((await read).data[0].witness).toEqual(Buffer.from([2]));
  expect(order).toEqual(["read:1,2", "verify", "proof", "verify", "proof", "write", "commit", "changed", "ack", "read:2"]);
  expect(delivered).toEqual([{ updated: action === "delete"
    ? [{ id: "2", witness: Buffer.from([2]), payload: Buffer.from([91]) }]
    : ["1", "2"].map(id => ({ id, witness: Buffer.from([2]), payload: Buffer.from([91]) })),
  deleted: action === "delete" ? ["1"] : [] }]);
  await ack(outsider, "hello", {}); expect(authored).toEqual([]); expect(unrelated).toEqual([]);
  if (action === "delete") expect(server!.router.subscriberIds(1n)).toEqual([]);
  await idle();
});

it.each(["read", "verify", "proof"])("%s exception before mutation sends a bounded error and releases capacity for the next batch", async phase => {
  let failing = true, writes = 0;
  const failure = new DomainError("internal_error", "synthetic private diagnostic", { cause: { secret: "synthetic" } });
  class Storage extends InMemoryResourceStorage {
    override async findManyByIds(ids: readonly bigint[], bounds?: StorageReadBounds) {
      if (failing && phase === "read") throw failure;
      return super.findManyByIds(ids, bounds);
    }
    override async applyBatch(changes: readonly StoredChange[]) { writes++; await super.applyBatch(changes); }
  }
  const storage = await setup({ storage: new Storage(), limits: { maxSubscriptionsPerSocket: 2, maxSubscriptionsTotal: 2 },
    ulda: { async verify() { if (failing && phase === "verify") throw failure; return true; } },
    proof: { async verify() { if (failing && phase === "proof") throw failure; return true; } },
  });
  await storage.createBatch([item(), item()]); const a = await connect();
  expect(await ack(a, "update", [change(), change("2")])).toEqual({ ok: false, error: "storage_error" });
  expect(writes).toBe(0); expect(server!.router.subscriptionTotal).toBe(0); await idle();
  failing = false;
  expect(await ack(a, "update", [change(), change("2")])).toEqual({ ok: true });
  expect(writes).toBe(1); expect(server!.router.subscriptions(a.id!)).toEqual([1n, 2n]); await idle();
});

it.each(["update", "delete"])("late proof refusal in %s changes no rows or subscriptions and leaves both locks reusable", async action => {
  let failing = true;
  const storage = await setup({ limits: { maxSubscriptionsTotal: 4 },
    proof: { async verify(input) { return !failing || input.current.id !== 2n; } } });
  await storage.createBatch([item(), item()]); const a = await connect(), b = await connect();
  await ack(b, "read", ["1", "2"]); const received: unknown[] = []; b.on("ulda:changed", v => received.push(v));
  const changes = [action === "delete" ? { id: "1", witness: Uint8Array.of(2) } : change(), change("2")];
  expect(await ack(a, action, changes)).toEqual({ ok: false, error: "invalid_proof" });
  expect((await ack(b, "read", ["1", "2"])).data.map((v: { witness: Buffer }) => v.witness[0])).toEqual([1, 1]);
  expect(server!.router.subscriptions(a.id!)).toEqual([]); expect(received).toEqual([]); await idle();
  failing = false; expect(await ack(a, action, changes)).toEqual({ ok: true }); await idle();
});

it.each(["create", "update", "delete"].flatMap(action => [false, true].map(committed => ({ action, committed }))))(
  "$action storage rejection (committed=$committed) closes without ACK/Changed and frees all reservations", async ({ action, committed }) => {
    let failing = false;
    class Storage extends InMemoryResourceStorage {
      override async createBatch(items: readonly CreateStoredResource[]) {
        if (!failing) return super.createBatch(items);
        if (committed) await super.createBatch(items);
        throw new Error("synthetic private storage exception");
      }
      override async applyBatch(changes: readonly StoredChange[]) {
        if (!failing) return super.applyBatch(changes);
        if (committed) await super.applyBatch(changes);
        throw new Error("synthetic private storage exception");
      }
    }
    const warn = vi.fn(() => { throw new Error("synthetic logger failure"); });
    const storage = await setup({ storage: new Storage(), limits: { maxSubscriptionsTotal: 2 },
      logger: { ...createLogger("error"), warn } });
    await storage.createBatch([item()]); const a = await connect(), b = await connect();
    await ack(b, "read", ["1"]); const events: unknown[] = [], replies: unknown[] = [];
    b.on("ulda:changed", value => events.push(value)); failing = true;
    const disconnected = new Promise<void>(resolve => a.once("disconnect", () => resolve()));
    const body = action === "create" ? [item()] : action === "update" ? [change()] : [{ id: "1", witness: Uint8Array.of(2) }];
    a.emit("ulda:" + action, body, (reply: unknown) => replies.push(reply)); await disconnected;
    expect(warn).toHaveBeenCalledOnce();
    await ack(b, "hello", {}); expect(replies).toEqual([]); expect(events).toEqual([]); await idle();
    expect(server!.router.subscriptionTotal).toBe(1);
    if (action === "create") expect(await storage.findById(2n)).toEqual(committed ? { id: 2n, ...item() } : null);
    else if (action === "delete" && committed) expect(await storage.findById(1n)).toBeNull();
    else expect((await storage.findById(1n))!.witness[0]).toBe(committed ? 2 : 1);
    failing = false;
    // Reuse the same resource lock, then the Create queue and the exact remaining global slot.
    const read = await ack(b, "read", ["1"]);
    expect(read.ok).toBe(!(action === "delete" && committed));
    expect((await ack(b, "create", [item()])).ok).toBe(true); await idle();
  },
);

it.each(["update", "delete"])("a failed Changed emit in %s does not stop healthy recipients, ACK or deletion cleanup", async action => {
  const warn = vi.fn(() => { throw new Error("synthetic logger failure"); });
  const storage = await setup({ logger: { ...createLogger("error"), warn } }); await storage.createBatch([item(), item()]);
  const a = await connect(), b = await connect(), c = await connect();
  await ack(b, "read", ["1", "2"]); await ack(c, "read", ["1", "2"]);
  const failed = server!.io.sockets.sockets.get(b.id!)!;
  vi.spyOn(failed, "emit").mockImplementationOnce(() => { throw new Error("synthetic delivery failure"); });
  const pushed = new Promise<any>(resolve => c.once("ulda:changed", resolve));
  const first = action === "delete" ? { id: "1", witness: Uint8Array.of(2) } : change();
  expect(await ack(a, action, [first, change("2")])).toEqual({ ok: true });
  expect(warn).toHaveBeenCalledOnce();
  expect((await pushed).updated.map((v: { id: string }) => v.id)).toEqual(action === "delete" ? ["2"] : ["1", "2"]);
  if (action === "delete") expect(server!.router.subscriberIds(1n)).toEqual([]);
  expect(await ack(a, "update", [change("2", 3)])).toEqual({ ok: true }); await idle();
});

it("a lost Create ACK is attempted once, preserves the row and releases the Create queue", async () => {
  const storage = await setup(); const a = await connect(), attempted = gate();
  let attempts = 0; const replies: unknown[] = [];
  server!.io.sockets.sockets.get(a.id!)!.use((event, next) => {
    if (event[0] === "ulda:create" && attempts === 0) event[event.length - 1] = () => {
      attempts++; attempted.resolve(); throw new Error("synthetic ACK send failure");
    };
    next();
  });
  a.emit("ulda:create", [item()], (value: unknown) => replies.push(value)); await attempted.promise;
  expect(await ack(a, "create", [item()])).toEqual({ ok: true, data: ["2"] });
  expect(await storage.findById(1n)).toEqual({ id: 1n, ...item() });
  expect(attempts).toBe(1); expect(replies).toEqual([]); await idle();
});

it("a rejected event's throwing ACK cannot escape middleware or retain its ingress charge", async () => {
  await setup(); const a = await connect();
  const local = server!.io.sockets.sockets.get(a.id!)!;
  // Inject at the registered middleware boundary, without throwing into Vitest's socket loop.
  const middleware = (local as unknown as { fns: Array<(event: unknown[], next: () => void) => void> }).fns[0]!;
  const owner = new IngressOwner(server!.admission), lease = owner.begin();
  const callback = vi.fn(() => { throw new Error("synthetic ACK send failure"); });
  const event = ["unknown", {}, callback], next = vi.fn(); server!.admission.packets.set(event, lease);
  expect(() => middleware(event, next)).not.toThrow();
  expect(callback).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "invalid_request" });
  expect(next).not.toHaveBeenCalled(); owner.destroy();
  expect(await ack(a, "hello", {})).toEqual({ ok: true }); await idle();
});

it("shutdown rejects new socket commands without releasing the accepted mutation's memory before commit", async () => {
  const entered = gate(), release = gate(); let creates = 0;
  class Storage extends InMemoryResourceStorage {
    override async createBatch(items: readonly CreateStoredResource[]) {
      creates++; entered.resolve(); await release.promise; return super.createBatch(items);
    }
  }
  const storage = await setup({ storage: new Storage() }), a = await connect(), b = await connect();
  const accepted = ack(a, "create", [item()]); await entered.promise;
  const active = server!, held = active.admission.input.used, closing = active.close();
  for (const [action, body] of [["hello", {}], ["read", ["1"]], ["create", [item()]]] as const) {
    expect(await ack(b, action, body)).toEqual({ ok: false, error: "not_ready" });
    expect(active.admission.input.used).toBe(held); expect(active.admission.pending).toBe(1);
  }
  expect(creates).toBe(1); expect(await storage.findById(1n)).toBeNull();
  release.resolve(); expect(await accepted).toEqual({ ok: true, data: ["1"] }); await closing;
  expect(await storage.findById(1n)).toEqual({ id: 1n, ...item() }); await idle();
  expect(active.admission.connections.count).toBe(0); expect(active.router.subscriptionTotal).toBe(0);
  server = undefined;
});
