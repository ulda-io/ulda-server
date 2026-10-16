import { resolve } from "node:path";
import { grantRuntimeAccess } from "../storage/postgres/runtime-grants.js";

import type { PoolClient } from "pg";

import { loadConfig } from "../config/config.js";
import { createLogger } from "../observability/logger.js";
import { runPostgresMigrations, type MigrationResult } from "../storage/postgres/migrations.js";
import { createPostgresPool } from "../storage/postgres/postgres-pool.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  if (config.storageAdapterModule !== undefined) {
    throw new Error(
      "PostgreSQL migrations cannot run with STORAGE_ADAPTER_MODULE.",
    );
  }

  const pool = createPostgresPool(config.database);
  let client: PoolClient | undefined;
  let broken = false;
  let failed = true;
  let result: MigrationResult;
  const onClientError = () => { broken = true; };
  pool.on("error", error => {
    broken = true;
    logger.error("PostgreSQL pool reported an idle-client error", error);
  });
  try {
    client = await pool.connect();
    client.on("error", onClientError);
    const directory = resolve(
      process.env.MIGRATIONS_DIR?.trim() || "migrations/postgres",
    );
    result = await runPostgresMigrations(
      client,
      directory,
      () => logger.info("PostgreSQL migration applied"),
    );
    if (process.env.ULDA_MANAGED_ROLES === "1") await grantRuntimeAccess(client);
    if (broken) throw new Error("Migration connection failed.");
    failed = false;
  } finally {
    try { client?.release(failed || broken); }
    finally {
      try { await pool.end(); }
      finally { client?.off("error", onClientError); }
    }
  }
  if (broken) throw new Error("Migration connection failed.");
  logger.info("PostgreSQL migrations ready", {
    applied: result.applied.length,
    alreadyApplied: result.alreadyApplied.length,
  });
}

main().catch((error: unknown) => {
  createLogger("error").error("PostgreSQL migration failed", error);
  process.exitCode = 1;
});
