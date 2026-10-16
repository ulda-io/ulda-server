import type { Server } from "socket.io";
import type { ServerAdmission } from "../../admission/server-admission.js";
import type { AppConfig } from "../../config/config.js";
import { DomainError } from "../../domain/errors.js";
import type { SdkResourceService } from "../../domain/sdk-resource-service.js";
import type { Logger } from "../../observability/logger.js";
import type { RequestRouter } from "../../router/request-router.js";
import {
  parseSdkEmpty, parseSdkRead, parseSdkCreate, parseSdkChanges,
  checkSdkSize, sdkResource, sdkError, SDK_LIMITS, SdkLimitError,
} from "../../protocol/sdk-commands.js";
import { publishSdkChanges } from "./sdk-publisher.js";

export function registerSdkHandlers(options: {
  io: Server; service: SdkResourceService; router: RequestRouter; config: AppConfig; logger: Logger; admission: ServerAdmission;
}): void {
  const { io, service, router, config, logger, admission } = options;
  let totalReservations = 0;
  io.on("connection", socket => {
    admission.handshakes.get(socket.handshake.auth)?.bindAbort(() => socket.conn.close(true));
    const actions = new Set(["hello", "read", "create", "update", "delete", "session.close"]);
    socket.use((event, next) => {
      const lease = admission.packets.get(event); admission.packets.delete(event);
      if (!lease) return; // Already discarded by decoder/connection close.
      const callback = event.at(-1), name = event[0], body = event[1];
      if (typeof callback !== "function" || typeof name !== "string" || !actions.has(name.slice(5)) || !name.startsWith("ulda:")
        || event.length !== 3 || body === null || typeof body !== "object") {
        try { if (typeof callback === "function") callback({ ok: false, error: "invalid_request" }); }
        catch { /* A failed rejection ACK must not escape the socket dispatch loop. */ }
        finally { lease.release(); }
        return;
      }
      admission.bodies.set(body, lease); // ACK may be wrapped/dropped by instrumentation.
      next(); // Lease stays decoder-owned across Socket.IO's next-tick dispatch.
    });
    const reserveRead = (count: number) => {
      const bytes = count * (SDK_LIMITS.payloadBytes + SDK_LIMITS.witnessBytes);
      if (!admission.reads.acquire(bytes)) throw new SdkLimitError();
      let released = false;
      return () => { if (!released) { released = true; admission.reads.release(bytes); } };
    };
    socket.on("error", () => socket.conn.close(true));
    let ended = false;
    let reservations = 0;
    const finishSession = () => { ended = true; router.unsubscribeSocket(socket.id); };
    socket.on("disconnect", finishSession);
    const active = () => socket.connected && !ended;

    // Reserve capacity before any await/write. Concurrent disjoint batches on
    // one connection cannot both spend the same remaining subscription slots.
    const reserve = (idsOrCount: readonly bigint[] | number) => {
      const count = !active() ? 0 : typeof idsOrCount === "number" ? idsOrCount
        : idsOrCount.filter(id => !router.isSubscribed(socket.id, id)).length;
      if (router.subscriptionCount(socket.id) + reservations + count > config.limits.maxSubscriptionsPerSocket
        || router.subscriptionTotal + totalReservations + count > config.limits.maxSubscriptionsTotal) {
        throw new DomainError("rate_limited", "Subscription capacity exceeded.");
      }
      reservations += count; totalReservations += count;
      return () => { reservations -= count; totalReservations -= count; };
    };
    const subscribe = (ids: readonly bigint[]) => {
      if (active()) for (const id of ids) router.subscribe(socket.id, id);
    };

    for (const action of ["hello", "read", "create", "update", "delete", "session.close"]) {
      socket.on("ulda:" + action, (...args: unknown[]) => {
        const ack = args.at(-1);
        // Never perform a mutation without a reply channel.
        if (typeof ack !== "function") return;
        const lease = args[0] && typeof args[0] === "object" ? admission.claim(args[0]) : undefined;
        if (!lease) return;
        const reserveCopies = (bytes: number) => { if (!lease.grow(bytes)) throw new SdkLimitError(); };
        let replied = false;
        let mutationStarted = false;
        const reply = (value: unknown) => {
          if (replied) return;
          replied = true;
          try { ack(value); } catch { /* Committed state must not change due to ACK failure. */ }
        };
        const handle = async () => {
          if (args.length !== 2 || ended) throw new DomainError("invalid_request", "Invalid session or arguments.");
          const body = args[0];
          if (action === "session.close") {
            parseSdkEmpty(body);
            finishSession();
            reply({ ok: true });
            return;
          }
          if (action === "hello") {
            parseSdkEmpty(body);
            await router.runResources([], async () => { reply({ ok: true }); });
            return;
          }
          if (action === "read") {
            const ids = parseSdkRead(body);
            await router.runResources(ids, async () => {
              const releaseRead = reserveRead(ids.length);
              const release = () => { releaseRead(); releaseSubscriptions(); };
              let releaseSubscriptions = () => {};
              try { releaseSubscriptions = reserve(ids); } catch (error) { releaseRead(); throw error; }
              try {
                const resources = await service.read(ids);
                checkSdkSize(resources);
                subscribe(ids);
                reply({ ok: true, data: resources.map(sdkResource) });
              } finally { release(); }
            });
            return;
          }
          if (action === "create") {
            const items = parseSdkCreate(body, config.limits.maxWitnessBytes, reserveCopies);
            await router.runCreate(async () => {
              const release = reserve(items.length);
              try {
                mutationStarted = true;
                const resources = await service.create(items);
                subscribe(resources.map(item => item.id));
                reply({ ok: true, data: resources.map(item => String(item.id)) });
              } finally { release(); }
            });
            return;
          }
          const changes = parseSdkChanges(body, action === "delete", config.limits.maxWitnessBytes, reserveCopies);
          await router.runResources(changes.map(item => item.id), async () => {
            const updateIds = changes.filter(item => item.payload !== undefined).map(item => item.id);
            const release = reserve(updateIds);
            try {
              const releaseRead = reserveRead(changes.length);
              try { await service.validate(changes); } finally { releaseRead(); }
              mutationStarted = true;
              await service.storage.applyBatch(changes);
              subscribe(updateIds);
              publishSdkChanges(io, router, socket.id, changes,
                () => { logger.warn("Changed delivery failed after commit", { event: "ulda:changed" }); });
              reply({ ok: true });
            } finally { release(); }
          });
        };
        void handle().catch(error => {
          if (mutationStarted) {
            // Storage/COMMIT may already have succeeded. Closing produces the
            // SDK's UNKNOWN_OUTCOME; never claim rollback or retry a write.
            try { logger.warn("Mutation outcome uncertain; connection closed", { event: "ulda:" + action }); }
            catch { /* Closing an uncertain mutation must not depend on the diagnostic sink. */ }
            socket.disconnect(true);
          } else reply(sdkError(error));
        }).finally(() => lease.release());
      });
    }
  });
}
