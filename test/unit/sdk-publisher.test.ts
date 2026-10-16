import type { Server } from "socket.io";
import { expect, it, vi } from "vitest";
import { publishSdkChanges } from "../../src/transports/socketio/sdk-publisher.js";
import { RequestRouter } from "../../src/router/request-router.js";
import { KeyedPipelineQueue } from "../../src/router/keyed-pipeline-queue.js";

it("a throwing diagnostic after failed delivery cannot stop other recipients or deletion cleanup", () => {
  const router = new RequestRouter(new KeyedPipelineQueue({ maxQueuedPerKey: 4, maxQueuedTotal: 8 }));
  for (const id of [1n, 2n]) for (const socket of ["author", "failed", "healthy"]) router.subscribe(socket, id);
  const failed = vi.fn(() => { throw new Error("synthetic transport failure"); });
  const healthy = vi.fn(), author = vi.fn(), diagnostic = vi.fn(() => { throw new Error("synthetic logger failure"); });
  const io = { sockets: { sockets: new Map([
    ["author", { emit: author }], ["failed", { emit: failed }], ["healthy", { emit: healthy }],
  ]) } } as unknown as Server;
  expect(() => publishSdkChanges(io, router, "author", [
    { id: 1n, witness: Uint8Array.of(2) },
    { id: 2n, witness: Uint8Array.of(2), payload: Uint8Array.of(91) },
  ], diagnostic)).not.toThrow();
  expect(author).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledOnce(); expect(diagnostic).toHaveBeenCalledOnce();
  expect(healthy).toHaveBeenCalledExactlyOnceWith("ulda:changed", {
    updated: [{ id: "2", witness: Buffer.from([2]), payload: Buffer.from([91]) }], deleted: ["1"],
  });
  expect(router.subscriberIds(1n)).toEqual([]); expect(router.subscriptionTotal).toBe(3);
});
