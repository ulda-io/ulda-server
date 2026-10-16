import type { Socket } from "socket.io";
import type { ServerAdmission } from "../../admission/server-admission.js";

type Connection = Socket["conn"];
type Transport = Connection["transport"];
interface Charge { bytes: number; packets: number }

function charge(packet: { data?: unknown }): Charge {
  const data = packet.data;
  const bytes = typeof data === "string" ? Buffer.byteLength(data)
    : ArrayBuffer.isView(data) ? data.byteLength
    : data instanceof ArrayBuffer ? data.byteLength : 0;
  // Include a fixed framing/accounting allowance, including empty control packets.
  return { bytes: bytes + 64, packets: 1 };
}

/** Account until transport drain, not Engine.IO's earlier buffer-to-transport flush.
 * Applies to ACKs, binary attachments and Changed, without reading private buffers.
 * A disconnected writer may have committed: never send a false negative ACK here.
 */
export function limitOutboundBuffer(connection: Connection, maxBytes: number, onLimit: () => void, shared?: ServerAdmission): void {
  let pendingBytes = 0, pendingPackets = 0, closed = false;
  const charges = new WeakMap<object, Charge>();
  const transports = new Map<Transport, { batches: Charge[]; drain: () => void; close: () => void }>();
  const release = (item: Charge) => {
    shared?.output.release(item.bytes); shared?.outputPackets.release(item.packets);
    pendingBytes = Math.max(0, pendingBytes - item.bytes);
    pendingPackets = Math.max(0, pendingPackets - item.packets);
  };
  const attach = (transport: Transport) => {
    if (closed || transports.has(transport)) return;
    const batches: Charge[] = [];
    const drain = () => { const batch = batches.shift(); if (batch) release(batch); };
    const close = () => {
      for (const batch of batches) release(batch);
      batches.length = 0;
      transport.off("drain", drain); transport.off("close", close);
      transports.delete(transport);
    };
    transports.set(transport, { batches, drain, close });
    transport.on("drain", drain); transport.on("close", close);
  };
  const created = (packet: { data?: unknown }) => {
    if (closed) return;
    const item = charge(packet);
    let fits = pendingBytes + item.bytes <= maxBytes && pendingPackets + 1 <= 4096;
    if (fits && shared) {
      fits = shared.output.acquire(item.bytes);
      if (fits && !shared.outputPackets.acquire(1)) { shared.output.release(item.bytes); fits = false; }
    }
    if (!fits) {
      // Forced Engine.IO close discards queued packets; graceful close would wait
      // for the very slow receiver that caused this condition.
      try { onLimit(); } finally { connection.close(true); }
      return;
    }
    charges.set(packet, item); pendingBytes += item.bytes; pendingPackets++;
  };
  const flushed = (packets: Array<{ data?: unknown }>) => {
    if (closed) return;
    attach(connection.transport);
    const batch = packets.reduce((sum, packet) => {
      const item = charges.get(packet); charges.delete(packet);
      return { bytes: sum.bytes + (item?.bytes ?? 0), packets: sum.packets + (item?.packets ?? 0) };
    }, { bytes: 0, packets: 0 });
    transports.get(connection.transport)!.batches.push(batch);
  };
  const upgraded = (transport: Transport) => attach(transport);
  connection.on("packetCreate", created); connection.on("flush", flushed);
  connection.on("upgrade", upgraded); attach(connection.transport);
  connection.once("close", () => {
    closed = true;
    connection.off("packetCreate", created); connection.off("flush", flushed); connection.off("upgrade", upgraded);
    for (const state of [...transports.values()]) state.close();
    release({ bytes: pendingBytes, packets: pendingPackets });
  });
}
