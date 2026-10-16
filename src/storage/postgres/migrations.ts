import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { PoolClient, QueryResultRow } from "pg";

interface AppliedMigrationRow extends QueryResultRow {
  checksum: string;
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

const MIGRATION_PATTERN = /^\d{3}_[a-z0-9_]+\.sql$/u;
const MIGRATION_LOCK_NAME = "ulda-server-schema-migrations";

function checksumSql(sql: string): string {
  const normalized = sql.replace(/\r\n?/gu, "\n");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

export async function runPostgresMigrations(
  client: PoolClient,
  directory: string,
  onApplied: (filename: string) => void = () => undefined,
): Promise<MigrationResult> {
  const filenames = (await readdir(directory))
    .filter((filename) => MIGRATION_PATTERN.test(filename))
    .sort((left, right) => left.localeCompare(right, "en"));

  const result: MigrationResult = { applied: [], alreadyApplied: [] };
  await client.query(
    "SELECT pg_advisory_lock(hashtextextended($1, 0))",
    [MIGRATION_LOCK_NAME],
  );
  try {
    await client.query(
      "CREATE TABLE IF NOT EXISTS public.ulda_schema_migrations (" +
        "version TEXT PRIMARY KEY, " +
        "checksum TEXT NOT NULL, " +
        "applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()" +
        ")",
    );

    for (const filename of filenames) {
      const sql = await readFile(join(directory, filename), "utf8");
      const checksum = checksumSql(sql);
      const existing = await client.query<AppliedMigrationRow>(
        "SELECT checksum FROM public.ulda_schema_migrations WHERE version = $1",
        [filename],
      );
      const recorded = existing.rows[0];
      if (recorded !== undefined) {
        if (recorded.checksum !== checksum) {
          throw new Error("Migration checksum mismatch for " + filename + ".");
        }
        result.alreadyApplied.push(filename);
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO public.ulda_schema_migrations (version, checksum) " +
            "VALUES ($1, $2)",
          [filename, checksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      result.applied.push(filename);
      onApplied(filename);
    }
  } finally {
    await client.query(
      "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
      [MIGRATION_LOCK_NAME],
    );
  }
  return result;
}
