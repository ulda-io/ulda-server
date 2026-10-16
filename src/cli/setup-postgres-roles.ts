// Explicit administrator operation, never invoked by application startup.
import { escapeIdentifier, escapeLiteral } from "pg";
import { loadConfig } from "../config/config.js";
import { createPostgresPool } from "../storage/postgres/postgres-pool.js";
import { readPasswordFile } from "../storage/postgres/password-file.js";

async function main(): Promise<void> {
  if (process.env.ULDA_DB_SETUP !== "1") throw new Error();
  const migration = readPasswordFile(process.env.ULDA_MIGRATION_PASSWORD_FILE ?? "");
  const runtime = readPasswordFile(process.env.ULDA_RUNTIME_PASSWORD_FILE ?? "");
  const admin = readPasswordFile(process.env.PGPASSWORD_FILE ?? "");
  if (migration.length < 32 || runtime.length < 32 || new Set([admin, migration, runtime]).size !== 3) throw new Error();
  const pool = createPostgresPool(loadConfig().database);
  let broken = false;
  pool.on("error", () => { broken = true; });
  const client = await pool.connect().catch(async () => { await pool.end(); throw new Error(); });
  const onError = () => { broken = true; }; client.on("error", onError);
  let success = false;
  try {
    // Keep password-bearing DDL out of built-in statement/error logs.
    // Administrator-controlled audit extensions are a separate trusted boundary.
    await client.query("SET log_statement = 'none'; SET log_min_duration_statement = -1; SET log_duration = off; SET log_min_error_statement = 'panic'; SET log_parameter_max_length_on_error = 0");
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('ulda-server-role-setup', 0))");
    const { rows: [db] } = await client.query("SELECT current_database() AS name");
    if (!db || db.name !== process.env.PGDATABASE) throw new Error();
    const active = await client.query("SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND backend_type = 'client backend' AND pid <> pg_backend_pid()");
    if (active.rowCount !== 0) throw new Error();
    const roles = await client.query("SELECT 1 FROM pg_roles WHERE rolname IN ('ulda_migrator', 'ulda_runtime')");
    // Never silently change existing accounts or their memberships/passwords.
    if (roles.rowCount !== 0) throw new Error();
    const existing = await client.query("SELECT to_regclass('public.ulda_resources') IS NOT NULL AS resources, to_regclass('public.ulda_schema_migrations') IS NOT NULL AS ledger");
    const row = existing.rows[0];
    if (row.resources !== row.ledger || (row.resources && process.env.ULDA_DB_ADOPT_EXISTING !== "1")) throw new Error();
    await client.query("CREATE ROLE ulda_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5 PASSWORD " + escapeLiteral(migration));
    await client.query("CREATE ROLE ulda_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 12 PASSWORD " + escapeLiteral(runtime));
    const database = escapeIdentifier(db.name as string);
    await client.query("REVOKE ALL ON DATABASE " + database + " FROM PUBLIC");
    await client.query("GRANT CONNECT ON DATABASE " + database + " TO ulda_migrator, ulda_runtime");
    await client.query("REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT USAGE, CREATE ON SCHEMA public TO ulda_migrator; GRANT USAGE ON SCHEMA public TO ulda_runtime");
    if (row.resources) {
      await client.query("ALTER TABLE public.ulda_resources OWNER TO ulda_migrator; ALTER TABLE public.ulda_schema_migrations OWNER TO ulda_migrator");
      // Identity sequence ownership follows its table. Migrate reapplies grants.
    }
    await client.query("COMMIT");
    if (broken) throw new Error();
    success = true;
  } finally {
    try { client.release(!success || broken); }
    finally { try { await pool.end(); } finally { client.off("error", onError); } }
  }
  if (broken) throw new Error();
  console.log("PostgreSQL roles initialized; run the migration job before starting the server.");
}
main().catch(() => {
  console.error("PostgreSQL role setup failed; private diagnostics suppressed. Check explicit setup consent, stopped clients, new role names and existing-volume adoption policy.");
  process.exitCode = 1;
});
