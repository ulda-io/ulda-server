import { createServer as createHttpServer } from "node:http";

import { Server as SocketIoServer } from "socket.io";

import type { AppConfig } from "../config/config.js";
import type {
  ProofVerifier,
  ResourceStorage,
  UldaVerifier,
} from "../domain/ports.js";
import { SdkResourceService } from "../domain/sdk-resource-service.js";
import { registerSdkHandlers } from "../transports/socketio/register-sdk-handlers.js";
import { createSdkParser } from "../transports/socketio/sdk-parser.js";
import { limitOutboundBuffer } from "../transports/socketio/outbound-limit.js";
import { ServerAdmission } from "../admission/server-admission.js";
import { SDK_LIMITS } from "../protocol/sdk-commands.js";
import { ResourceService } from "../domain/resource-service.js";
import { createLogger, type Logger } from "../observability/logger.js";
import { ReadinessProbe } from "../observability/readiness.js";
import { AllowAllProofVerifier } from "../proof/allow-all-proof-verifier.js";
import { KeyedPipelineQueue } from "../router/keyed-pipeline-queue.js";
import { RequestRouter } from "../router/request-router.js";
import { registerSocketHandlers } from "../transports/socketio/register-socket-handlers.js";
import { SocketIoPublisher } from "../transports/socketio/socket-publisher.js";
import { UldaCoreVerifier } from "../ulda/ulda-core-verifier.js";

export interface CreateServerOptions {
  /** Legacy wire is only for explicitly selected old tests/benchmarks. */
  protocol?: "sdk" | "legacy";
  config: AppConfig;
  storage: ResourceStorage;
  ulda?: UldaVerifier;
  proof?: ProofVerifier;
  logger?: Logger;
}

export interface UldaServer {
  readonly httpServer: ReturnType<typeof createHttpServer>;
  readonly io: SocketIoServer;
  readonly service: ResourceService;
  readonly router: RequestRouter;
  readonly storage: ResourceStorage;
  readonly admission: ServerAdmission;
  start(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
}

function writeJson(
  response: import("node:http").ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  if (response.destroyed || response.writableEnded) return;
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": encoded.byteLength,
    "cache-control": "no-store",
  });
  response.end(encoded);
}

export function createUldaServer(options: CreateServerOptions): UldaServer {
  const { config } = options;
  const sdk = options.protocol !== "legacy";
  if (sdk && config.ulda.originSize !== 256) throw new Error("SDK requires 256-bit origin blocks.");
  const logger = options.logger ?? createLogger(config.logLevel);
  const storage = options.storage;
  let acceptingCommands = true;
  const readiness = new ReadinessProbe(() => storage.ping(), config.readiness);
  const admission = new ServerAdmission(config.limits);

  const httpServer = createHttpServer((request, response) => {
    const path = request.url?.split("?", 1)[0];
    if (request.method === "GET" && path === "/health") {
      writeJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "GET" && path === "/ready") {
      if (!acceptingCommands) {
        writeJson(response, 503, { ok: false, code: "not_ready" });
        return;
      }
      void readiness
        .check()
        .then(ready => {
          if (!ready || !acceptingCommands) {
            writeJson(response, 503, { ok: false, code: "not_ready" });
            return;
          }
          writeJson(response, 200, { ok: true });
        })
        .catch(() => writeJson(response, 503, { ok: false, code: "not_ready" }));
      return;
    }
    writeJson(response, 404, { ok: false, code: "not_found" });
  });

  const io = new SocketIoServer(httpServer, {
    serveClient: false,
    maxHttpBufferSize: sdk ? Math.min(config.limits.maxSocketMessageBytes, SDK_LIMITS.payloadBytes) : config.limits.maxSocketMessageBytes,
    ...(sdk ? {
      parser: createSdkParser(admission),
      connectTimeout: 10_000,
      allowRequest: admission.connections.allow.bind(admission.connections),
    } : {}),
    cors: {
      origin: config.corsOrigins,
      methods: ["GET", "POST"],
    },
  });
  const queue = new KeyedPipelineQueue({
    maxQueuedPerKey: config.limits.maxQueuedPerResource,
    maxQueuedTotal: config.limits.maxQueuedTotal,
  });
  if (sdk) {
    io.engine.on("connection", connection => {
      admission.connections.connected(connection);
      limitOutboundBuffer(connection, config.limits.maxBufferedSocketBytes,
        () => logger.warn("Receiver disconnected: outbound capacity"), admission);
    });
    io.engine.on("connection_error", error => { admission.connections.failed(error.req); });
    io.use((socket, next) => {
      if (!admission.connections.accepted(socket.conn)) next(new Error("not_ready"));
      else next();
    });
  }
  const router = new RequestRouter(queue);
  const publisher = new SocketIoPublisher(io, router);
  const ulda = options.ulda ?? new UldaCoreVerifier(config.ulda);
  const proof = options.proof ?? new AllowAllProofVerifier();
  const service = new ResourceService({
    storage,
    ulda,
    proof,
    publisher,
    limits: config.limits,
    onPublishError: (error, event, id) => {
      logger.error("Realtime broadcast failed after storage update", error, {
        event: `resource:${event}`,
        resourceId: id.toString(),
      });
    },
  });
  if (sdk) registerSdkHandlers({ io, service: new SdkResourceService(storage, ulda, proof), router, config, logger, admission });
  else registerSocketHandlers({ io, service, router, config, logger });

  return {
    httpServer,
    io,
    service,
    router,
    storage,
    admission,
    async start() {
      await storage.ping();
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          httpServer.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          httpServer.off("error", onError);
          resolve();
        };
        httpServer.once("error", onError);
        httpServer.once("listening", onListening);
        httpServer.listen(config.port, config.host);
      });
      const address = httpServer.address();
      const port = typeof address === "object" && address !== null
        ? address.port
        : config.port;
      logger.info("ULDA server started", { host: config.host, port });
      return { host: config.host, port };
    },
    async close() {
      acceptingCommands = false;
      readiness.stop();
      admission.connections.stop();
      router.stopAccepting();
      await router.drain();
      await new Promise<void>((resolve) => io.close(() => resolve()));
      if (httpServer.listening) {
        await new Promise<void>((resolve, reject) => {
          httpServer.close((error) => (error === undefined ? resolve() : reject(error)));
        });
      }
      await storage.close();
      logger.info("ULDA server stopped");
    },
  };
}
