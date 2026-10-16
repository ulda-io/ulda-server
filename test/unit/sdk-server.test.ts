import UldaCore from "ulda-core";
import { io, type Socket } from "socket.io-client";
import { afterEach, describe, expect, it } from "vitest";
import { createUldaServer, type UldaServer } from "../../src/app/create-server.js";
import { loadConfig } from "../../src/config/config.js";
import { InMemoryResourceStorage } from "../../src/storage/in-memory-resource-storage.js";
import type { ProofVerifier, StoredChange, UldaVerifier } from "../../src/domain/ports.js";
import { sdkParser } from "../../src/transports/socketio/sdk-parser.js";
import { SDK_LIMITS, parseSdkChanges, parseSdkCreate, parseSdkRead } from "../../src/protocol/sdk-commands.js";
import { UldaCoreVerifier } from "../../src/ulda/ulda-core-verifier.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const core = new UldaCore({ fmt: { export: "bytes" }, sign: { mode: "X" } }) as unknown as {
  New(): Uint8Array; stepUp(value: Uint8Array): Uint8Array; sign(value: Uint8Array): Promise<Uint8Array>;
};
async function chain() {
  const first = core.New(), next = core.stepUp(first);
  return { first: await core.sign(first), next: await core.sign(next),
    later: await core.sign(core.stepUp(next)), other: await core.sign(core.stepUp(first)) };
}
const payload = Uint8Array.of(11, 22, 33);
const sockets: Socket[] = [];
let server: UldaServer | undefined;
let endpoint = "";
async function setup(options: { storage?: InMemoryResourceStorage; ulda?: UldaVerifier; proof?: ProofVerifier; cap?: number; bufferBytes?: number } = {}) {
  const config = loadConfig({ LOG_LEVEL: "error" });
  config.host = "127.0.0.1"; config.port = 0;
  if (options.cap !== undefined) config.limits.maxSubscriptionsPerSocket = options.cap;
  if (options.bufferBytes !== undefined) config.limits.maxBufferedSocketBytes = options.bufferBytes;
  server = createUldaServer({ config, storage: options.storage ?? new InMemoryResourceStorage(),
    ...(options.ulda ? { ulda: options.ulda } : {}), ...(options.proof ? { proof: options.proof } : {}) });
  const address = await server.start();
  endpoint = "http://127.0.0.1:" + address.port;
  return connect();
}
async function connect() {
  const socket = io(endpoint, { transports: ["websocket"], reconnection: false, forceNew: true, parser: sdkParser });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
  return socket;
}
const ack = (socket: Socket, action: string, body: unknown) => socket.timeout(2000).emitWithAck("ulda:" + action, body);
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.disconnect();
  await server?.close(); server = undefined;
});

describe("binary SDK server", () => {
  it("bounds a stalled receiver without rolling back the writer or disturbing healthy subscribers", async () => {
    const a = await setup({ bufferBytes: 4096 }), b = await connect(), c = await connect();
    const x = await chain();
    await ack(a, "create", [{ witness: x.first, payload }]);
    await ack(b, "read", ["1"]); await ack(c, "read", ["1"]);
    const stalled = server!.io.sockets.sockets.get(b.id!)!, stalledId = b.id!;
    stalled.conn.transport.writable = false; // Controlled transport barrier, not a timing race.
    const disconnected = new Promise<void>(resolve => b.once("disconnect", () => resolve()));
    const received: unknown[] = []; c.on("ulda:changed", p => received.push(p));
    for (const witness of [x.next, x.later]) {
      expect(await ack(a, "update", [{ id: "1", witness, payload: new Uint8Array(3000) }])).toEqual({ ok: true });
    }
    await disconnected;
    expect(server!.router.subscriptions(stalledId)).toEqual([]);
    expect(server!.router.subscriberIds(1n)).not.toContain(stalledId);
    const read = await ack(c, "read", ["1"]);
    expect([...read.data[0].witness]).toEqual([...x.later]); expect(received).toHaveLength(2);
    expect(a.connected).toBe(true); expect(c.connected).toBe(true);
  });
  it("defaults to SDK protocol; create/read/update subscribe, other devices get one batch, author gets only ACK", async () => {
    const a = await setup(), b = await connect(), outsider = await connect();
    const x = await chain(), y = await chain();
    expect(await ack(a, "hello", {})).toEqual({ ok: true });
    const made = await ack(a, "create", [{ witness: x.first, payload }, { witness: y.first, payload }]);
    expect(made).toEqual({ ok: true, data: ["1", "2"] });
    expect(server!.router.subscriptions(a.id!)).toEqual([1n, 2n]);
    const read = await ack(b, "read", ["2", "1"]);
    expect(read.data.map((v: { id: string }) => v.id)).toEqual(["2", "1"]);
    expect(read.data[0].payload).toBeInstanceOf(Uint8Array);
    const authored: unknown[] = [], unrelated: unknown[] = [];
    a.on("ulda:changed", value => authored.push(value));
    outsider.on("ulda:changed", value => unrelated.push(value));
    const pushed = new Promise<any>(resolve => b.once("ulda:changed", resolve));
    expect(await ack(a, "update", [
      { id: "2", witness: y.next, payload: Uint8Array.of(7) },
      { id: "1", witness: x.next, payload: Uint8Array.of(8) },
    ])).toEqual({ ok: true });
    expect((await pushed).updated.map((v: { id: string }) => v.id)).toEqual(["2", "1"]);
    await ack(b, "read", ["1"]); // wire barrier after the committed publication
    expect(authored).toEqual([]); expect(unrelated).toEqual([]);
    expect([...server!.io.sockets.sockets.values()].every(s => s.rooms.size === 1)).toBe(true);
    const c = await connect();
    expect(await ack(c, "update", [{ id: "1", witness: x.later, payload }])).toEqual({ ok: true });
    expect(server!.router.subscriptions(c.id!)).toEqual([1n]);
  });

  it.each(["update", "delete"])("rejects invalid last %s item without changing first or sending any event", async action => {
    const a = await setup(), b = await connect(), x = await chain(), y = await chain();
    await ack(a, "create", [{ witness: x.first, payload }, { witness: y.first, payload }]);
    await ack(b, "read", ["1", "2"]);
    const events: unknown[] = []; b.on("ulda:changed", value => events.push(value));
    const first = action === "delete" ? { id: "1", witness: x.next } : { id: "1", witness: x.next, payload: Uint8Array.of(99) };
    expect(await ack(a, action, [first, { id: "2", witness: x.next, payload }])).toEqual({ ok: false, error: "conflict" });
    const read = await ack(b, "read", ["1", "2"]);
    expect([...read.data[0].witness]).toEqual([...x.first]);
    expect([...read.data[1].witness]).toEqual([...y.first]);
    expect(events).toEqual([]);
  });

  it("mixed delete commits together and removes deleted subscription on every connection", async () => {
    const a = await setup(), b = await connect(), x = await chain(), y = await chain();
    await ack(a, "create", [{ witness: x.first, payload }, { witness: y.first, payload }]);
    await ack(b, "read", ["1", "2"]);
    const pushed = new Promise<any>(resolve => b.once("ulda:changed", resolve));
    expect(await ack(a, "delete", [{ id: "1", witness: x.next }, { id: "2", witness: y.next, payload }])).toEqual({ ok: true });
    const changed = await pushed;
    expect(changed.deleted).toEqual(["1"]); expect(changed.updated[0].id).toBe("2");
    expect(server!.router.subscriptions(a.id!)).toEqual([2n]);
    expect(server!.router.subscriptions(b.id!)).toEqual([2n]);
    expect(await server!.storage.findById(1n)).toBeNull();
  });

  it("holds overlapping locks across await; first valid write wins, different IDs still run", async () => {
    const entered = gate(), release = gate();
    const verifier = new UldaCoreVerifier({ originSize: 256, pack: "compactV1" });
    let count = 0;
    const a = await setup({ ulda: { async verify(p, c) {
      if (++count === 1) { entered.resolve(); await release.promise; }
      return verifier.verify(p, c);
    } } }), b = await connect();
    const x = await chain(), y = await chain();
    await ack(a, "create", [{ witness: x.first, payload }, { witness: y.first, payload }]);
    const win = ack(a, "update", [{ id: "1", witness: x.next, payload }]);
    await entered.promise;
    const lose = ack(b, "update", [{ id: "1", witness: x.other, payload }]);
    expect(await ack(b, "update", [{ id: "2", witness: y.next, payload }])).toEqual({ ok: true });
    release.resolve();
    expect(await win).toEqual({ ok: true });
    expect(await lose).toEqual({ ok: false, error: "conflict" });
  });

  it("proof rejection occurs before any write, and invalid ULDA never reaches proof", async () => {
    let proofCalls = 0;
    const a = await setup({ proof: { async verify() { proofCalls++; return false; } } });
    const x = await chain();
    await ack(a, "create", [{ witness: x.first, payload }]);
    expect(await ack(a, "update", [{ id: "1", witness: x.first, payload }])).toEqual({ ok: false, error: "conflict" });
    expect(proofCalls).toBe(0);
    expect(await ack(a, "update", [{ id: "1", witness: x.next, payload }])).toEqual({ ok: false, error: "invalid_proof" });
    expect(proofCalls).toBe(1);
    expect((await server!.storage.findById(1n))!.witness).toEqual(x.first);
  });

  it("subscription limit is checked before create; failed read leaves no registrations", async () => {
    const a = await setup({ cap: 1 });
    const x = await chain();
    expect(await ack(a, "create", [{ witness: x.first, payload }, { witness: x.first, payload }])).toEqual({ ok: false, error: "too_large" });
    expect(await server!.storage.findById(1n)).toBeNull();
    expect(await ack(a, "read", ["999"])).toEqual({ ok: false, error: "not_found" });
    expect(server!.router.subscriptions(a.id!)).toEqual([]);
  });

  it.each(["disconnect", "session.close"])("%s during accepted mutation never leaves ghost subscriptions or cancels commit", async ending => {
    const entered = gate(), release = gate();
    class PausedStorage extends InMemoryResourceStorage {
      override async createBatch(items: Parameters<InMemoryResourceStorage["createBatch"]>[0]) {
        entered.resolve(); await release.promise; return super.createBatch(items);
      }
    }
    const a = await setup({ storage: new PausedStorage() }), socketId = a.id!;
    const x = await chain();
    const pending = ack(a, "create", [{ witness: x.first, payload }]).catch(() => undefined);
    await entered.promise;
    if (ending === "session.close") expect(await ack(a, "session.close", {})).toEqual({ ok: true });
    else {
      const disconnected = new Promise<void>(resolve => server!.io.sockets.sockets.get(socketId)!.once("disconnect", () => resolve()));
      a.disconnect(); await disconnected;
    }
    release.resolve();
    await pending;
    expect(await server!.storage.findById(1n)).not.toBeNull();
    expect(server!.router.subscriptions(socketId)).toEqual([]);
  });

  it("uncertain storage completion closes the socket instead of sending false rollback ACK", async () => {
    class LostCommit extends InMemoryResourceStorage {
      override async applyBatch(changes: readonly StoredChange[]) {
        await super.applyBatch(changes);
        throw new Error("private database exception must not appear in ACK");
      }
    }
    const a = await setup({ storage: new LostCommit() }), x = await chain();
    await ack(a, "create", [{ witness: x.first, payload }]);
    await expect(ack(a, "update", [{ id: "1", witness: x.next, payload }])).rejects.toThrow();
    expect((await server!.storage.findById(1n))!.witness).toEqual(x.next);
    expect(a.connected).toBe(false);
  });

  it("reserves per-socket capacity across concurrently executing disjoint requests", async () => {
    const entered = gate(), release = gate();
    class PausedRead extends InMemoryResourceStorage {
      override async findManyByIds(ids: readonly bigint[]) {
        if (ids[0] === 1n) { entered.resolve(); await release.promise; }
        return super.findManyByIds(ids);
      }
    }
    const storage = new PausedRead(), x = await chain();
    await storage.createBatch([{ witness: x.first, payload }, { witness: x.first, payload }]);
    const a = await setup({ storage, cap: 1 });
    const first = ack(a, "read", ["1"]); await entered.promise;
    expect(await ack(a, "read", ["2"])).toEqual({ ok: false, error: "too_large" });
    release.resolve(); expect((await first).ok).toBe(true);
    expect(server!.router.subscriptions(a.id!)).toEqual([1n]);
  });

  it("handles a 64-item binary batch with 128 attachments", async () => {
    const a = await setup(), x = await chain();
    const made = await ack(a, "create", Array.from({ length: 64 }, () => ({ witness: x.first, payload })));
    expect(made.data).toHaveLength(64);
    expect((await ack(a, "read", made.data)).data).toHaveLength(64);
  });
});

describe("SDK wire admission", () => {
  it("rejects names, secrets, base witness, duplicate/out-of-range IDs, base64 and update-only delete", () => {
    for (const value of [
      [{ id: "1", witness: payload, payload, name: "private" }],
      [{ id: "1", witness: payload, payload, origin: payload }],
      [{ id: "1", witness: payload, payload, baseWitness: payload }],
      [{ id: "1", witness: "base64", payload }],
      [{ id: "1", witness: payload, payload }, { id: "1", witness: payload, payload }],
    ]) expect(() => parseSdkChanges(value, false)).toThrow();
    expect(() => parseSdkChanges([{ id: "1", witness: payload, payload }], true)).toThrow();
    for (const ids of [[], ["01"], ["9223372036854775808"], ["1", "1"]]) expect(() => parseSdkRead(ids)).toThrow();
  });
  it("bounds individual and aggregate bytes", () => {
    expect(() => parseSdkCreate([{ witness: payload, payload: new Uint8Array(SDK_LIMITS.payloadBytes + 1) }])).toThrow();
    expect(() => parseSdkCreate(Array.from({ length: 8 }, () => ({ witness: payload, payload: new Uint8Array(SDK_LIMITS.payloadBytes) })))).toThrow();
  });
  it("decoder rejects excessive attachments and aggregate frames before dispatch", () => {
    const decoder = new sdkParser.Decoder();
    expect(() => decoder.add('5129-["ulda:create",[]]')).toThrow();
    const tooLarge = new sdkParser.Decoder();
    tooLarge.add('58-["x",' + JSON.stringify(Array.from({ length: 8 }, (_, num) => ({ _placeholder: true, num }))) + ']');
    for (let i = 0; i < 7; i++) tooLarge.add(new Uint8Array(SDK_LIMITS.payloadBytes));
    expect(() => tooLarge.add(new Uint8Array(SDK_LIMITS.payloadBytes))).toThrow();
  });
});
