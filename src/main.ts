import { createUldaServer, type UldaServer } from "./app/create-server.js";
import { loadConfig } from "./config/config.js";
import { createLogger } from "./observability/logger.js";
import { loadStorageAdapter } from "./storage/load-storage-adapter.js";
import { PostgresResourceStorage } from "./storage/postgres/postgres-resource-storage.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const storage = config.storageAdapterModule === undefined
    ? new PostgresResourceStorage(config.database, (error) => {
        logger.error("PostgreSQL pool reported an idle-client error", error);
    })
    : await loadStorageAdapter(config.storageAdapterModule);
  let server: UldaServer;
  try {
    server = createUldaServer({ config, logger, storage });
    await server.start();
  } catch (error) {
    try {
      await storage.close();
    } catch (closeError) {
      logger.error("Storage cleanup failed after startup error", closeError);
    }
    throw error;
  }

  let stopping = false;
  const stop = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info("Shutdown requested", { signal });

    const timeout = setTimeout(() => {
      logger.error("Graceful shutdown timed out");
      process.exitCode = 1;
    }, config.gracefulShutdownTimeoutMs);
    timeout.unref();

    try {
      await server.close();
    } catch (error) {
      logger.error("Graceful shutdown failed", error);
      process.exitCode = 1;
    } finally {
      clearTimeout(timeout);
    }
  };

  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
}

main().catch((error: unknown) => {
  const logger = createLogger("error");
  logger.error("ULDA server failed to start", error);
  process.exitCode = 1;
});
