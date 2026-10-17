import type { Server } from "socket.io";
import type { StoredChange } from "../../domain/ports.js";
import type { RequestRouter } from "../../router/request-router.js";
import { sdkResource, SDK_LIMITS } from "../../protocol/sdk-commands.js";

/** One committed batch per subscriber; author accepts its local candidates on ACK. */
export function publishSdkChanges(io: Server, router: RequestRouter, author: string,
  changes: readonly StoredChange[], onError: () => void): void {
  const recipients = new Map<string, { updated: ReturnType<typeof sdkResource>[]; deleted: string[] }>();
  for (const change of changes) {
    // Copy each immutable committed record once, not once per subscriber.
    const updated = change.payload === undefined ? undefined
      : sdkResource({ ...change, payload: change.payload });
    for (const socketId of router.subscriberIds(change.id)) {
      if (socketId === author) continue;
      let packet = recipients.get(socketId);
      if (!packet) { packet = { updated: [], deleted: [] }; recipients.set(socketId, packet); }
      if (change.payload === undefined) packet.deleted.push(String(change.id));
      else packet.updated.push(updated!);
    }
  }
  try {
    for (const [socketId, packet] of recipients) {
      try {
        const socket = io.sockets.sockets.get(socketId);
        if (!socket) continue;
        const count = packet.updated.length + packet.deleted.length;
        const size = packet.updated.reduce((n, x) => n + x.witness.length + x.payload.length, 0);
        if (count <= SDK_LIMITS.batch && size <= SDK_LIMITS.messageBytes && packet.updated.every(x => x.payload.length <= SDK_LIMITS.payloadBytes)) {
          socket.emit("ulda:changed", packet);
        } else if (!socket.data.uldaTransfer) {
          // Legacy decoders cannot accept this committed state. Disconnect so
          // clients never silently continue with an unreported stale snapshot.
          socket.disconnect(true);
        } else {
          socket.emit('ulda:changed.part', { kind: 'begin', count });
          let items: unknown[] = [], bytes = 0;
          const flush = () => { if (items.length) socket.emit('ulda:changed.part', { kind: 'append', items }); items = []; bytes = 0; };
          for (const record of packet.updated) {
            const size = record.witness.length + record.payload.length;
            if (items.length && (items.length === SDK_LIMITS.batch || bytes + size > SDK_LIMITS.messageBytes || record.payload.length > SDK_LIMITS.payloadBytes)) flush();
            if (record.payload.length > SDK_LIMITS.payloadBytes) {
              for (let offset = 0; offset < record.payload.length; offset += 1_048_576) socket.emit('ulda:changed.part', {
                kind: 'part', resourceId: record.id, witness: record.witness, total: record.payload.length,
                offset, payload: record.payload.subarray(offset, offset + 1_048_576),
              });
            } else { items.push(record); bytes += size; }
          }
          for (const id of packet.deleted) { if (items.length === SDK_LIMITS.batch) flush(); items.push({ id }); }
          flush(); socket.emit('ulda:changed.part', { kind: 'end' });
        }
      }
      catch {
        try { onError(); }
        catch { /* Diagnostics cannot interrupt committed fan-out or the writer's ACK. */ }
      }
    }
  } finally {
    for (const change of changes) if (change.payload === undefined) router.removeResource(change.id);
  }
}
