import type { Server } from "socket.io";

import type { ResourceEventPublisher } from "../../domain/ports.js";
import type {
  ActiveResource,
  DeletedResource,
} from "../../domain/resource.js";
import type { RequestRouter } from "../../router/request-router.js";
import {
  serializeActiveResource,
  serializeDeletedResource,
} from "../../protocol/serialization.js";

export class SocketIoPublisher implements ResourceEventPublisher {
  readonly #io: Server;
  readonly #router: RequestRouter;

  constructor(io: Server, router: RequestRouter) {
    this.#io = io;
    this.#router = router;
  }

  async resourceUpdated(resource: ActiveResource): Promise<void> {
    this.#emitToSubscribers(
      resource.id,
      "resource:updated",
      serializeActiveResource(resource),
    );
  }

  async resourceDeleted(resource: DeletedResource): Promise<void> {
    try {
      this.#emitToSubscribers(
        resource.id,
        "resource:deleted",
        serializeDeletedResource(resource),
      );
    } finally {
      this.#router.removeResource(resource.id);
    }
  }

  #emitToSubscribers(resourceId: bigint, event: string, payload: unknown): void {
    let firstError: unknown;
    for (const socketId of this.#router.subscriberIds(resourceId)) {
      try {
        this.#io.sockets.sockets.get(socketId)?.emit(event, payload);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
  }
}
