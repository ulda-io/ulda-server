import { randomUUID } from "node:crypto";

import type { Server } from "socket.io";

import type { AppConfig } from "../../config/config.js";
import { toPublicConfig } from "../../config/config.js";
import { DomainError } from "../../domain/errors.js";
import type { ResourceService } from "../../domain/resource-service.js";
import type { Logger } from "../../observability/logger.js";
import type { RequestRouter } from "../../router/request-router.js";
import {
  parseCreateCommand,
  parseDeleteCommand,
  parseReadManyCommand,
  parseResourceIdCommand,
  parseSubscribeManyCommand,
  parseUpdateCommand,
} from "../../protocol/commands.js";
import {
  serializeActiveResource,
  serializeDeletedResource,
  serializeFailure,
} from "../../protocol/serialization.js";

type Ack = (value: unknown) => void;

function safeAck(candidate: unknown): Ack {
  return typeof candidate === "function" ? (candidate as Ack) : () => undefined;
}

export function registerSocketHandlers(options: {
  io: Server;
  service: ResourceService;
  router: RequestRouter;
  config: AppConfig;
  logger: Logger;
}): void {
  const { io, service, router, config, logger } = options;

  io.on("connection", (socket) => {
    logger.info("Socket connected", { socketId: socket.id });

    socket.on("server:config", (ackCandidate: unknown) => {
      safeAck(ackCandidate)({
        ok: true,
        requestId: randomUUID(),
        config: toPublicConfig(config),
      });
    });

    socket.on("resource:create", async (raw: unknown, ackCandidate: unknown) => {
      const requestId = randomUUID();
      const ack = safeAck(ackCandidate);
      try {
        const command = parseCreateCommand(raw);
        await router.runCreate(async () => {
          try {
            const result = await service.create(command);
            const subscribed = socket.connected && router.subscribe(
              socket.id,
              result.resource.id,
              config.limits.maxSubscriptionsPerSocket,
            ) !== "limit";
            ack({
              ok: true,
              requestId,
              resource: serializeActiveResource(result.resource),
              idempotent: result.idempotent,
              subscribed,
            });
          } catch (error) {
            logCommandFailure(logger, error, "resource:create", requestId, socket.id);
            ack(serializeFailure(error, requestId));
          }
        });
      } catch (error) {
        logCommandFailure(logger, error, "resource:create", requestId, socket.id);
        ack(serializeFailure(error, requestId));
      }
    });

    socket.on("resource:read", async (raw: unknown, ackCandidate: unknown) => {
      const requestId = randomUUID();
      const ack = safeAck(ackCandidate);
      try {
        const { id } = parseResourceIdCommand(raw);
        await router.runResource(id, async () => {
          try {
            const resource = await service.read(id);
            ack({ ok: true, requestId, resource: serializeActiveResource(resource) });
          } catch (error) {
            logCommandFailure(logger, error, "resource:read", requestId, socket.id);
            ack(serializeFailure(error, requestId));
          }
        });
      } catch (error) {
        logCommandFailure(logger, error, "resource:read", requestId, socket.id);
        ack(serializeFailure(error, requestId));
      }
    });

    socket.on("resource:read-many", async (raw: unknown, ackCandidate: unknown) => {
      const requestId = randomUUID();
      const ack = safeAck(ackCandidate);
      try {
        const { ids } = parseReadManyCommand(raw);
        await router.runResources(ids, async () => {
          try {
            const result = await service.readMany(ids);
            ack({
              ok: true,
              requestId,
              resources: result.resources.map(serializeActiveResource),
              missingIds: result.missingIds.map(String),
            });
          } catch (error) {
            logCommandFailure(logger, error, "resource:read-many", requestId, socket.id);
            ack(serializeFailure(error, requestId));
          }
        });
      } catch (error) {
        logCommandFailure(logger, error, "resource:read-many", requestId, socket.id);
        ack(serializeFailure(error, requestId));
      }
    });

    socket.on("resource:subscribe", async (raw: unknown, ackCandidate: unknown) => {
      const requestId = randomUUID();
      const ack = safeAck(ackCandidate);
      try {
        const { id } = parseResourceIdCommand(raw);
        await router.runResource(id, async () => {
          let subscription: "added" | "existing" | "limit" = "existing";
          try {
            if (!socket.connected) {
              throw new DomainError("not_ready", "Socket is disconnected.");
            }
            subscription = router.subscribe(
              socket.id,
              id,
              config.limits.maxSubscriptionsPerSocket,
            );
            if (subscription === "limit") {
              throw new DomainError(
                "rate_limited",
                "Maximum subscriptions per socket exceeded.",
              );
            }
            const resource = await service.read(id);
            ack({ ok: true, requestId, resource: serializeActiveResource(resource) });
          } catch (error) {
            if (subscription === "added") router.unsubscribe(socket.id, id);
            logCommandFailure(logger, error, "resource:subscribe", requestId, socket.id);
            ack(serializeFailure(error, requestId));
          }
        });
      } catch (error) {
        logCommandFailure(logger, error, "resource:subscribe", requestId, socket.id);
        ack(serializeFailure(error, requestId));
      }
    });

    socket.on(
      "resource:subscribe-many",
      async (raw: unknown, ackCandidate: unknown) => {
        const requestId = randomUUID();
        const ack = safeAck(ackCandidate);
        try {
          const { ids } = parseSubscribeManyCommand(raw);
          if (ids.length > config.limits.maxSubscriptionsPerSocket) {
            throw new DomainError(
              "rate_limited",
              "Subscription batch exceeds the per-socket limit.",
            );
          }
          await router.runResources(ids, async () => {
            if (!socket.connected) {
              throw new DomainError("not_ready", "Socket is disconnected.");
            }

            const subscriptions = new Map<
              bigint,
              "added" | "existing" | "limit"
            >();
            const readableIds: bigint[] = [];
            for (const id of ids) {
              const subscription = router.subscribe(
                socket.id,
                id,
                config.limits.maxSubscriptionsPerSocket,
              );
              subscriptions.set(id, subscription);
              if (subscription !== "limit") readableIds.push(id);
            }

            try {
              const batch = await service.readMany(readableIds);
              const resourcesById = new Map(
                batch.resources.map((resource) => [resource.id, resource] as const),
              );
              const missing = new Set(batch.missingIds);

              const results = ids.map((id) => {
                const subscription = subscriptions.get(id);
                let error: DomainError | undefined;
                if (subscription === "limit") {
                  error = new DomainError(
                    "rate_limited",
                    "Maximum subscriptions per socket exceeded.",
                  );
                } else if (missing.has(id) || !resourcesById.has(id)) {
                  error = new DomainError("not_found", "Resource was not found.");
                }

                if (error !== undefined) {
                  if (subscription === "added") router.unsubscribe(socket.id, id);
                  logCommandFailure(
                    logger,
                    error,
                    "resource:subscribe-many",
                    requestId,
                    socket.id,
                  );
                  return { id: id.toString(), ...serializeFailure(error, requestId) };
                }

                const resource = resourcesById.get(id);
                if (resource === undefined) {
                  throw new DomainError(
                    "internal_error",
                    "Batch read result was inconsistent.",
                  );
                }
                return {
                  ok: true as const,
                  id: id.toString(),
                  resource: serializeActiveResource(resource),
                };
              });
              ack({
                ok: true,
                requestId,
                results,
                subscriptions: router.subscriptions(socket.id).map(String),
              });
            } catch (error) {
              for (const [id, subscription] of subscriptions) {
                if (subscription === "added") router.unsubscribe(socket.id, id);
              }
              throw error;
            }
          });
        } catch (error) {
          logCommandFailure(
            logger,
            error,
            "resource:subscribe-many",
            requestId,
            socket.id,
          );
          ack(serializeFailure(error, requestId));
        }
      },
    );

    socket.on("resource:unsubscribe", async (raw: unknown, ackCandidate: unknown) => {
      const requestId = randomUUID();
      const ack = safeAck(ackCandidate);
      try {
        const { id } = parseResourceIdCommand(raw);
        router.unsubscribe(socket.id, id);
        ack({ ok: true, requestId, id: id.toString() });
      } catch (error) {
        logCommandFailure(logger, error, "resource:unsubscribe", requestId, socket.id);
        ack(serializeFailure(error, requestId));
      }
    });

    socket.on("resource:update", async (raw: unknown, ackCandidate: unknown) => {
      const requestId = randomUUID();
      const ack = safeAck(ackCandidate);
      try {
        const command = parseUpdateCommand(raw);
        await router.runResource(command.id, async () => {
          try {
            const result = await service.update(command);
            ack({
              ok: true,
              requestId,
              resource: serializeActiveResource(result.resource),
              idempotent: result.idempotent,
            });
          } catch (error) {
            logCommandFailure(logger, error, "resource:update", requestId, socket.id);
            ack(serializeFailure(error, requestId));
          }
        });
      } catch (error) {
        logCommandFailure(logger, error, "resource:update", requestId, socket.id);
        ack(serializeFailure(error, requestId));
      }
    });

    socket.on("resource:delete", async (raw: unknown, ackCandidate: unknown) => {
      const requestId = randomUUID();
      const ack = safeAck(ackCandidate);
      try {
        const command = parseDeleteCommand(raw);
        await router.runResource(command.id, async () => {
          try {
            const result = await service.delete(command);
            ack({
              ok: true,
              requestId,
              deleted: serializeDeletedResource(result.resource),
              idempotent: result.idempotent,
            });
          } catch (error) {
            logCommandFailure(logger, error, "resource:delete", requestId, socket.id);
            ack(serializeFailure(error, requestId));
          }
        });
      } catch (error) {
        logCommandFailure(logger, error, "resource:delete", requestId, socket.id);
        ack(serializeFailure(error, requestId));
      }
    });

    socket.on("disconnect", (reason) => {
      router.unsubscribeSocket(socket.id);
      logger.info("Socket disconnected", { socketId: socket.id, reason });
    });
  });
}

function logCommandFailure(
  logger: Logger,
  error: unknown,
  event: string,
  requestId: string,
  socketId: string,
): void {
  if (error instanceof DomainError && error.code !== "internal_error") {
    logger.warn("Socket command rejected", {
      event,
      requestId,
      socketId,
      code: error.code,
    });
    return;
  }
  logger.error("Socket command failed", error, { event, requestId, socketId });
}
