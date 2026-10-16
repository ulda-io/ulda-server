import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { Socket } from "socket.io";
import { Encoder, PacketType, type Packet } from "socket.io-parser";
import { afterEach, expect, it, vi } from "vitest";
import { ByteBudget } from "../../src/admission/byte-budget.js";
import { ConnectionLimit } from "../../src/admission/connection-limit.js";
import { ServerAdmission } from "../../src/admission/server-admission.js";
import { loadConfig } from "../../src/config/config.js";
import { createSdkParser } from "../../src/transports/socketio/sdk-parser.js";
import { limitOutboundBuffer } from "../../src/transports/socketio/outbound-limit.js";
import { parseSdkCreate, SDK_LIMITS } from "../../src/protocol/sdk-commands.js";

afterEach(() => vi.useRealTimers());
function admission(overrides: Partial<ReturnType<typeof loadConfig>["limits"]> = {}) {
  return new ServerAdmission({ ...loadConfig({}).limits, ...overrides });
}
function packet(size: number) {
  return new Encoder().encode({ type: PacketType.EVENT, nsp: "/", id: 1,
    data: ["ulda:create", [{ witness: new Uint8Array(1), payload: new Uint8Array(size) }]] });
}
function request() {
  const socket = Object.assign(new EventEmitter(), { destroyed: false,
    destroy(this: EventEmitter & { destroyed: boolean }) { this.destroyed = true; this.emit("close"); } });
  const req = Object.assign(new EventEmitter(), { socket });
  return req as unknown as IncomingMessage;
}
function connection(req: IncomingMessage) {
  return Object.assign(new EventEmitter(), { request: req, closed: false,
    close(this: EventEmitter & { closed: boolean }) { this.closed = true; this.emit("close"); } }) as unknown as Socket["conn"];
}
it("budget refuses overflow without changing counters and rejects invalid accounting", () => {
  const b = new ByteBudget(100); expect(b.acquire(80)).toBe(true);
  expect(b.acquire(21)).toBe(false); expect(b.used).toBe(80);
  b.release(80); expect(b.used).toBe(0); expect(b.peak).toBe(80);
  expect(() => b.release(1)).toThrow(); expect(() => b.acquire(-1)).toThrow();
});
it("pending handshakes reserve capacity atomically; HTTP socket close after adoption does not free a live session", () => {
  const cap = new ConnectionLimit(1), a = request(), b = request(), cb = vi.fn();
  cap.allow(a, cb); cap.allow(b, cb);
  expect(cb.mock.calls).toEqual([[null, true], ["overloaded", false]]);
  const conn = connection(a); cap.connected(conn); a.socket.emit("close");
  expect(cap.count).toBe(1); cap.failed(a); expect(cap.count).toBe(1);
  conn.emit("close"); conn.emit("close"); expect(cap.count).toBe(0);
  cap.allow(b, cb); cap.failed(b); expect(cap.count).toBe(0);
});
it("aborted/expired handshakes free slots and a late handshake cannot become accepted", () => {
  vi.useFakeTimers();
  const cap = new ConnectionLimit(1, 100), a = request(); cap.allow(a, () => {});
  vi.advanceTimersByTime(101); expect(a.socket.destroyed).toBe(true); expect(cap.count).toBe(0);
  const late = connection(a); cap.connected(late); expect(cap.accepted(late)).toBe(false);
  const b = request(); cap.allow(b, () => {}); b.emit("aborted"); expect(cap.count).toBe(0);
});
it("shutdown denies new handshakes, cancels pending and retains live connection charge until close", () => {
  const cap = new ConnectionLimit(2), a = request(), b = request();
  cap.allow(a, () => {}); const conn = connection(a); cap.connected(conn); cap.allow(b, () => {});
  cap.stop(); expect(cap.count).toBe(1); expect(b.socket.destroyed).toBe(true);
  const cb = vi.fn(); cap.allow(request(), cb); expect(cb).toHaveBeenCalledWith("not_ready", false);
  conn.emit("close"); expect(cap.count).toBe(0);
});
it("two decoders share a budget before binary reconstruction finishes", () => {
  const cap = admission({ maxInflightBytes: 4000 }), Parser = createSdkParser(cap), a = new Parser.Decoder(), b = new Parser.Decoder();
  const frames = packet(1000); a.add(frames[0]); a.add(frames[1]);
  const held = cap.input.used;
  b.add(frames[0]); b.add(frames[1]);
  expect(() => b.add(new Uint8Array(2000))).toThrow("Ingress capacity");
  expect(cap.input.used).toBe(held); expect(cap.pending).toBe(1);
  a.destroy(); b.destroy(); expect(cap.input.used).toBe(0); expect(cap.pending).toBe(0);
});
it("completed packets stay accounted through dispatch; a claimed operation survives decoder destruction", () => {
  const cap = admission(), decoder = new (createSdkParser(cap).Decoder)();
  let decoded!: Packet; decoder.on("decoded", p => { decoded = p; });
  for (const frame of packet(100)) decoder.add(frame);
  const lease = cap.packets.get(decoded.data as object)!; expect(cap.input.used).toBeGreaterThan(1100);
  expect(lease.claim()).toBe(true); const held = cap.input.used;
  decoder.destroy(); expect(cap.input.used).toBe(held);
  lease.release(); lease.release(); expect(cap.pending).toBe(0); expect(cap.input.used).toBe(0);
});
it("per-connection pending cap includes claimed operations and does not free them on rejection", () => {
  const cap = admission({ maxPendingCommandsPerSocket: 1 }), decoder = new (createSdkParser(cap).Decoder)();
  let decoded!: Packet; decoder.on("decoded", p => { decoded = p; });
  for (const frame of packet(100)) decoder.add(frame);
  const lease = cap.packets.get(decoded.data as object)!; lease.claim(); const held = cap.input.used;
  expect(() => decoder.add(packet(100)[0])).toThrow("Ingress capacity");
  expect(cap.input.used).toBe(held); lease.release(); expect(cap.pending).toBe(0);
});
it("incomplete packet deadline discards reconstruction and closes its bound transport", () => {
  vi.useFakeTimers(); const cap = admission({ binaryPacketTimeoutMs: 100 });
  const decoder = new (createSdkParser(cap).Decoder)(), abort = vi.fn(); decoder.bindAbort(abort);
  decoder.add(packet(100)[0]); expect(cap.pending).toBe(1);
  vi.advanceTimersByTime(101); expect(abort).toHaveBeenCalledOnce(); expect(cap.input.used).toBe(0);
  decoder.destroy(); expect(cap.pending).toBe(0);
});
it("token bucket bounds bursts and refills without per-connection interval timers", () => {
  vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
  const cap = admission({ commandBurst: 1, maxCommandsPerSecond: 1 }), decoder = new (createSdkParser(cap).Decoder)();
  decoder.add("0"); expect(() => decoder.add("0")).toThrow("Ingress capacity");
  vi.advanceTimersByTime(1001); expect(() => decoder.add("1")).not.toThrow(); decoder.destroy();
  expect(cap.input.used).toBe(0);
});
it("invalid reconstruction and unsupported namespace release every unclaimed charge", () => {
  const cap = admission(), decoder = new (createSdkParser(cap).Decoder)();
  decoder.add(packet(10)[0]); expect(() => decoder.add("0")).toThrow(); expect(cap.input.used).toBe(0);
  expect(() => decoder.add('2/foreign,1["ulda:hello",{}]')).toThrow("Unsupported namespace");
  expect(cap.pending).toBe(0); decoder.destroy();
});
it("alias amplification is checked and reserved before defensive copies", () => {
  const item = { witness: new Uint8Array(1), payload: new Uint8Array(1_100_000) }, reserve = vi.fn();
  expect(() => parseSdkCreate(Array(8).fill(item), 167, reserve)).toThrow(); expect(reserve).not.toHaveBeenCalled();
  const two = parseSdkCreate([item, item], 167, reserve);
  expect(reserve).toHaveBeenCalledWith(3 * 2 * 1_100_001);
  item.payload[0] = 9; expect(two[0]!.payload[0]).toBe(0);
  two[0]!.payload[0] = 8; expect(two[1]!.payload[0]).toBe(0);
  expect(SDK_LIMITS.messageBytes).toBe(8_388_608);
});
it("outbound total budget disconnects the new overflowing receiver without releasing another socket's bytes", () => {
  const cap = admission({ maxBufferedTotalBytes: 5000 });
  function receiver() {
    const transport = new EventEmitter();
    const conn = Object.assign(new EventEmitter(), { transport, closed: false,
      close(this: EventEmitter & { closed: boolean }) { this.closed = true; this.emit("close"); } });
    limitOutboundBuffer(conn as unknown as Socket["conn"], 10_000, () => {}, cap);
    return conn;
  }
  const a = receiver(), b = receiver();
  a.emit("packetCreate", { data: Buffer.alloc(3000) }); expect(cap.output.used).toBe(3064);
  b.emit("packetCreate", { data: Buffer.alloc(3000) }); expect(b.closed).toBe(true);
  expect(a.closed).toBe(false); expect(cap.output.used).toBe(3064);
  a.close(); expect(cap.output.used).toBe(0); expect(cap.outputPackets.used).toBe(0);
});
it.each(["MAX_CONNECTIONS", "MAX_INFLIGHT_BYTES", "MAX_ACTIVE_READ_BYTES", "MAX_BUFFERED_TOTAL_BYTES", "MAX_PENDING_COMMANDS_PER_SOCKET", "MAX_COMMANDS_PER_SECOND", "COMMAND_BURST", "BINARY_PACKET_TIMEOUT_MS"])("rejects invalid %s config", key => {
  expect(() => loadConfig({ [key]: "0" })).toThrow(); expect(() => loadConfig({ [key]: "-1" })).toThrow();
});

it("unsolicited binary ACKs and repeated CONNECT cannot bypass dispatch accounting", () => {
  const cap = admission(), decoder = new (createSdkParser(cap).Decoder)();
  expect(() => decoder.add('31[]')).toThrow("Unsupported incoming packet");
  expect(cap.input.used).toBe(0);
  decoder.add("0"); expect(() => decoder.add("0")).toThrow("Repeated CONNECT");
  decoder.destroy(); expect(cap.input.used).toBe(0);
});
