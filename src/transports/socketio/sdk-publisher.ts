import type { Server } from "socket.io";
import type { StoredChange } from "../../domain/ports.js";
import type { RequestRouter } from "../../router/request-router.js";
import { sdkResource } from "../../protocol/sdk-commands.js";

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
      try { io.sockets.sockets.get(socketId)?.emit("ulda:changed", packet); }
      catch {
        try { onError(); }
        catch { /* Diagnostics cannot interrupt committed fan-out or the writer's ACK. */ }
      }
    }
  } finally {
    for (const change of changes) if (change.payload === undefined) router.removeResource(change.id);
  }
}
