import type { PoolClient } from "pg";

// Explicit opt-in for bundled deployment. Never grant access to future/unrelated tables.
export async function grantRuntimeAccess(client: PoolClient): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("REVOKE ALL ON public.ulda_resources, public.ulda_schema_migrations FROM PUBLIC, ulda_runtime");
    await client.query("GRANT SELECT, INSERT, UPDATE, DELETE ON public.ulda_resources TO ulda_runtime");
    await client.query("REVOKE ALL ON SEQUENCE public.ulda_resources_id_seq FROM PUBLIC, ulda_runtime");
    await client.query("GRANT USAGE ON SEQUENCE public.ulda_resources_id_seq TO ulda_runtime");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
