import { EventEmitter } from "node:events";
import type { Socket } from "socket.io";
import { expect, it } from "vitest";
import { limitOutboundBuffer } from "../../src/transports/socketio/outbound-limit.js";

function fixture(maxBytes = 1024) {
  const transport = new EventEmitter();
  const connection = Object.assign(new EventEmitter(), {
    transport, forced: false,
    close(this: EventEmitter & { forced: boolean }, discard: boolean) { this.forced = discard; this.emit("close"); },
  });
  limitOutboundBuffer(connection as unknown as Socket["conn"], maxBytes, () => undefined);
  const packet = (n: number) => { const p = { data: Buffer.alloc(n) }; connection.emit("packetCreate", p); return p; };
  return { connection, transport, packet };
}
it("flush is not delivery: bytes remain charged until transport drain", () => {
  const t = fixture(), a = t.packet(700);
  t.connection.emit("flush", [a]);t.connection.emit("drain");
  t.packet(300);expect(t.connection.forced).toBe(true);
});
it("transport drain releases charge and upgrade keeps queued packets accounted", () => {
  const t = fixture(), a = t.packet(700);
  t.connection.emit("flush", [a]);t.transport.emit("drain");
  const b = t.packet(700), next = new EventEmitter();
  t.connection.transport = next;t.connection.emit("upgrade", next);t.connection.emit("flush", [b]);
  next.emit("drain");t.packet(700);expect(t.connection.forced).toBe(false);
  t.connection.close(true);expect(next.listenerCount("drain")).toBe(0);expect(t.transport.listenerCount("drain")).toBe(0);
});
it("untracked handshake packets cannot subtract a later queued message's budget", () => {
  const t = fixture();t.connection.emit("flush", [{ data: Buffer.alloc(900) }]);
  t.packet(700);t.transport.emit("drain");t.packet(300);expect(t.connection.forced).toBe(true);
});
it("many empty packets are bounded by count even with a large byte budget", () => {
  const t = fixture(128 * 1024 * 1024);
  for (let i = 0; i < 4097; i++) t.packet(0);
  expect(t.connection.forced).toBe(true);
});
