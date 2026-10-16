import { requireTestDatabase } from "../support/test-database.mjs";
import { resolve } from "node:path";
import { Pool } from "pg";
import { io, type Socket } from "socket.io-client";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createPostgresPool } from "../../src/storage/postgres/postgres-pool.js";
import { PostgresResourceStorage } from "../../src/storage/postgres/postgres-resource-storage.js";
import { runPostgresMigrations } from "../../src/storage/postgres/migrations.js";
import { createUldaServer } from "../../src/app/create-server.js";
import { loadConfig } from "../../src/config/config.js";

const connectionString = requireTestDatabase();
const options = { connectionString, maxConnections: 4, connectionTimeoutMs: 1000,
  idleTimeoutMs: 1000, statementTimeoutMs: 500, lockTimeoutMs: 300, idleInTransactionTimeoutMs: 2000 };
const admin = new Pool({ connectionString });
beforeAll(async () => {
  const client = await admin.connect();
  try { await runPostgresMigrations(client, resolve("migrations/postgres")); }
  finally { client.release(); }
});
beforeEach(async () => { await admin.query("TRUNCATE public.ulda_resources RESTART IDENTITY"); });
afterAll(async () => { await admin.end(); });

it("configures PostgreSQL-side timeouts and recovers the pool after a cancelled statement", async () => {
  const pool = createPostgresPool(options);
  try {
    const settings = await pool.query("SELECT current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS lock, current_setting('idle_in_transaction_session_timeout') AS idle");
    expect(settings.rows[0]).toEqual({ statement: "500ms", lock: "300ms", idle: "2s" });
    await expect(pool.query("SELECT pg_sleep(10)")).rejects.toMatchObject({ code: "57014" });
    expect((await pool.query("SELECT 1 AS n")).rows[0].n).toBe(1);
  } finally { await pool.end(); }
});

it("readiness times out without duplicate SQL and recovers after a real database lock clears", async () => {
  const storage = new PostgresResourceStorage({ ...options, lockTimeoutMs: 2000, statementTimeoutMs: 3000 });
  const config = loadConfig({ LOG_LEVEL: "error", READINESS_TIMEOUT_MS: "100", READINESS_CACHE_MS: "0" });
  config.host = "127.0.0.1"; config.port = 0;
  const server = createUldaServer({ config, storage });
  const blocker = await admin.connect();
  let finished = false;
  try {
    const url = "http://127.0.0.1:" + (await server.start()).port;
    await blocker.query("BEGIN");
    await blocker.query("LOCK public.ulda_resources IN ACCESS EXCLUSIVE MODE");
    const original = storage.ping.bind(storage);
    const ping = vi.spyOn(storage, "ping").mockImplementation(async () => { try { await original(); } finally { finished = true; } });
    const response = await fetch(url + "/ready");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, code: "not_ready" });
    expect((await Promise.all(Array.from({ length: 10 }, () => fetch(url + "/ready")))).every(r => r.status === 503)).toBe(true);
    expect(ping).toHaveBeenCalledOnce();
    expect(finished).toBe(false);
    await blocker.query("ROLLBACK");
    await expect.poll(() => finished).toBe(true);
    expect((await fetch(url + "/ready")).status).toBe(200);
  } finally { await blocker.query("ROLLBACK"); blocker.release(); await server.close(); }
});

async function slowSecondInsert() {
  await admin.query("CREATE FUNCTION public.ulda_operational_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.payload = decode('ff','hex') THEN PERFORM pg_sleep(10); END IF; RETURN NEW; END $$");
  await admin.query("CREATE TRIGGER ulda_operational_pause BEFORE INSERT ON public.ulda_resources FOR EACH ROW EXECUTE FUNCTION public.ulda_operational_pause()");
}
async function removeTrigger() {
  await admin.query("DROP TRIGGER IF EXISTS ulda_operational_pause ON public.ulda_resources");
  await admin.query("DROP FUNCTION IF EXISTS public.ulda_operational_pause()");
}
const items = [ { witness: Uint8Array.of(1), payload: Uint8Array.of(1) },
  { witness: Uint8Array.of(2), payload: Uint8Array.of(255) } ];

it("a timeout on a later INSERT rolls back the entire batch and leaves storage usable", async () => {
  const storage = new PostgresResourceStorage(options);
  try {
    await slowSecondInsert();
    await expect(storage.createBatch(items)).rejects.toMatchObject({ code: "57014" });
    expect((await admin.query("SELECT count(*) FROM public.ulda_resources")).rows[0].count).toBe("0");
    expect(await storage.createBatch([items[0]!])).toHaveLength(1);
  } finally { await removeTrigger(); await storage.close(); }
});

it("shutdown drains a SQL timeout, closes the writer without false ACK, and frees admission", async () => {
  const storage = new PostgresResourceStorage({ ...options, statementTimeoutMs: 2000 });
  const config = loadConfig({ LOG_LEVEL: "error" }); config.host = "127.0.0.1"; config.port = 0;
  const server = createUldaServer({ config, storage });
  let socket: Socket | undefined, closing: Promise<void> | undefined;
  try {
    await slowSecondInsert();
    const url = "http://127.0.0.1:" + (await server.start()).port;
    socket = io(url, { transports: ["websocket"], reconnection: false, forceNew: true });
    await new Promise<void>((yes, no) => { socket!.once("connect", yes); socket!.once("connect_error", no); });
    let acknowledgements = 0;
    const disconnected = new Promise<void>(done => socket!.once("disconnect", () => done()));
    socket.emit("ulda:create", items, () => { acknowledgements++; });
    await expect.poll(async () => (await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event='PgSleep'")).rows[0].n).toBe(1);
    const held = server.admission.input.used;
    expect(held).toBeGreaterThan(0);
    let closed = false;
    closing = server.close().then(() => { closed = true; });
    expect((await fetch(url + "/ready")).status).toBe(503);
    expect(closed).toBe(false);
    expect(server.admission.input.used).toBe(held);
    await disconnected; await closing;
    expect(acknowledgements).toBe(0);
    expect((await admin.query("SELECT count(*) FROM public.ulda_resources")).rows[0].count).toBe("0");
    expect(server.admission.input.used).toBe(0);
    expect(server.admission.pending).toBe(0);
    expect(server.router.subscriptionTotal).toBe(0);
  } finally { socket?.close(); await (closing ?? server.close()); await removeTrigger(); }
});
