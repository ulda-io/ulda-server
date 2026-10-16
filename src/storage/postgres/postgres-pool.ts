import { Pool } from "pg";
import { postgresFilePassword } from "./password-file.js";

export interface PostgresConnectionOptions {
  connectionString: string | undefined;
  maxConnections: number;
  connectionTimeoutMs: number;
  idleTimeoutMs: number;
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
  idleInTransactionTimeoutMs?: number;
}

export function createPostgresPool(options: PostgresConnectionOptions): Pool {
  const password = postgresFilePassword(process.env, options.connectionString);
  return new Pool({
    ...(password === undefined ? {} : { password }),
    ...(options.connectionString === undefined
      ? {}
      : { connectionString: options.connectionString }),
    max: options.maxConnections,
    connectionTimeoutMillis: options.connectionTimeoutMs,
    idleTimeoutMillis: options.idleTimeoutMs,
    // PostgreSQL owns SQL cancellation. A client-side Promise timeout must not
    // release a resource lock while the database may still be executing a write.
    statement_timeout: options.statementTimeoutMs ?? 10_000,
    lock_timeout: options.lockTimeoutMs ?? 5_000,
    idle_in_transaction_session_timeout: options.idleInTransactionTimeoutMs ?? 10_000,
  });
}
