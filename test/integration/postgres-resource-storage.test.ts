import { requireTestDatabase } from "../support/test-database.mjs";
import { resolve } from "node:path";

import { Pool, types } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runPostgresMigrations } from "../../src/storage/postgres/migrations.js";
import { PostgresResourceStorage } from "../../src/storage/postgres/postgres-resource-storage.js";

const connectionString = requireTestDatabase();
const options = {
  connectionString,
  maxConnections: 4,
  connectionTimeoutMs: 5_000,
  idleTimeoutMs: 5_000,
};

let adminPool: Pool;
let storage: PostgresResourceStorage;

beforeAll(async () => {
  adminPool = new Pool({ connectionString });
  const client = await adminPool.connect();
  try {
    await runPostgresMigrations(client, resolve("migrations/postgres"));
  } finally {
    client.release();
  }
  storage = new PostgresResourceStorage(options);
  await storage.ping();
});

beforeEach(async () => {
  await adminPool.query(
    "TRUNCATE TABLE public.ulda_resources RESTART IDENTITY",
  );
});

afterAll(async () => {
  await storage?.close();
  await adminPool?.end();
});

describe("PostgresResourceStorage", () => {
  it('rejects aggregate and duplicate-slot overflow before any BYTEA reaches the driver parser', async () => {
    await storage.createBatch(Array.from({ length: 2 }, () => ({ witness: Uint8Array.of(1), payload: new Uint8Array(15) })));
    const bounds = { maxWitnessBytes: 167, maxPayloadBytes: 1_100_000, maxTotalBytes: 31 };
    const original = types.getTypeParser(17, 'text'); let decoded = 0;
    types.setTypeParser(17, 'text', value => { decoded++; return original(value); });
    try {
      await expect(storage.findManyByIds([1n, 2n], bounds)).rejects.toMatchObject({ code: 'rate_limited' });
      expect(decoded).toBe(0);
      await expect(storage.findManyByIds([1n, 1n], bounds)).rejects.toMatchObject({ code: 'rate_limited' });
      expect(decoded).toBe(0);
      const exact = await storage.findManyByIds([1n, 2n], { ...bounds, maxTotalBytes: 32 });
      expect(exact.map(x => x?.id)).toEqual([1n, 2n]); expect(decoded).toBe(4);
      const missing = await storage.findManyByIds([3n, 1n], { ...bounds, maxTotalBytes: 16 });
      expect(missing.map(x => x?.id ?? null)).toEqual([null, 1n]);
      expect(await storage.findManyByIds([1n, 2n], { maxWitnessBytes: 167, maxPayloadBytes: 1_100_000 })).toHaveLength(2);
    } finally { types.setTypeParser(17, 'text', original); }
  });
  it("bounds BYTEA in SQL before transfer, preserving aligned reads and the stored row", async () => {
    await storage.createBatch([
      { witness: Uint8Array.of(1), payload: Uint8Array.of(2) },
      { witness: Uint8Array.of(1), payload: new Uint8Array(1_100_001) },
    ]);
    const bounds = { maxWitnessBytes: 167, maxPayloadBytes: 1_100_000 };
    await expect(storage.findManyByIds([1n, 2n], bounds)).rejects.toMatchObject({ code: "rate_limited" });
    const aligned = await storage.findManyByIds([3n, 1n, 1n], bounds);
    expect(aligned.map(row => row?.id ?? null)).toEqual([null, 1n, 1n]);
    expect(aligned[1]).not.toBe(aligned[2]);
    expect((await storage.findById(2n))?.payload.byteLength).toBe(1_100_001);
    await adminPool.query("UPDATE public.ulda_resources SET witness = decode(repeat('01', 168), 'hex') WHERE id = 1");
    await expect(storage.findManyByIds([1n], bounds)).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("creates, reads and atomically updates witness with payload", async () => {
    const witness = Uint8Array.of(1, 2);
    const payload = Uint8Array.of(3, 4);
    const created = await storage.create({ witness, payload });
    witness[0] = 99;
    payload[0] = 99;

    await expect(storage.findById(created.id)).resolves.toEqual({
      id: created.id,
      witness: Uint8Array.of(1, 2),
      payload: Uint8Array.of(3, 4),
    });

    const updated = await storage.update({
      id: created.id,
      nextWitness: Uint8Array.of(5, 6),
      nextPayload: Uint8Array.of(7, 8),
    });
    expect(updated).toEqual({
      id: created.id,
      witness: Uint8Array.of(5, 6),
      payload: Uint8Array.of(7, 8),
    });
    await expect(storage.findById(created.id)).resolves.toEqual(updated);
  });

  it("returns aligned batch slots, including missing and duplicate ids", async () => {
    const first = await storage.create({
      witness: Uint8Array.of(1),
      payload: Uint8Array.of(11),
    });
    const second = await storage.create({
      witness: Uint8Array.of(2),
      payload: Uint8Array.of(12),
    });

    const result = await storage.findManyByIds([
      second.id,
      9_999n,
      first.id,
      second.id,
    ]);
    expect(result.map((resource) => resource?.id ?? null)).toEqual([
      second.id,
      null,
      first.id,
      second.id,
    ]);
    expect(result[0]).not.toBe(result[3]);
  });

  it("rolls back all changes when a later batch item fails", async () => {
    const [a, b] = await storage.createBatch([
      { witness: Uint8Array.of(1), payload: Uint8Array.of(11) },
      { witness: Uint8Array.of(2), payload: Uint8Array.of(12) },
    ]);
    await expect(storage.applyBatch([
      { id: a!.id, witness: Uint8Array.of(3), payload: Uint8Array.of(13) },
      { id: 9999n, witness: Uint8Array.of(4) },
    ])).rejects.toThrow();
    expect(await storage.findById(a!.id)).toEqual(a);
    await expect(storage.applyBatch([
      { id: a!.id, witness: Uint8Array.of(3) },
      { id: 9999n, witness: Uint8Array.of(4), payload: Uint8Array.of(14) },
    ])).rejects.toThrow();
    expect(await storage.findById(a!.id)).toEqual(a);
    await storage.applyBatch([
      { id: a!.id, witness: Uint8Array.of(3) },
      { id: b!.id, witness: Uint8Array.of(4), payload: Uint8Array.of(14) },
    ]);
    expect(await storage.findById(a!.id)).toBeNull();
    expect((await storage.findById(b!.id))!.payload).toEqual(Uint8Array.of(14));
  });

  it("rolls back a partially executed create batch when PostgreSQL rejects the later row", async () => {
    await adminPool.query("ALTER TABLE public.ulda_resources ADD CONSTRAINT test_reject_payload CHECK (payload <> decode('ff', 'hex'))");
    try {
      await expect(storage.createBatch([
        { witness: Uint8Array.of(1), payload: Uint8Array.of(1) },
        { witness: Uint8Array.of(2), payload: Uint8Array.of(255) },
      ])).rejects.toThrow();
      expect((await adminPool.query("SELECT count(*) FROM public.ulda_resources")).rows[0].count).toBe("0");
    } finally {
      await adminPool.query("ALTER TABLE public.ulda_resources DROP CONSTRAINT test_reject_payload");
    }
  });

  it("a killed database connection rolls back an in-flight multi-row transaction", async () => {
    const [a, b] = await storage.createBatch([
      { witness: Uint8Array.of(1), payload: Uint8Array.of(11) },
      { witness: Uint8Array.of(2), payload: Uint8Array.of(12) },
    ]);
    const blocker = await adminPool.connect();
    const lock = 20261006;
    await blocker.query("SELECT pg_advisory_lock($1)", [lock]);
    let outcome: Promise<string> | undefined;
    try {
    await adminPool.query("CREATE FUNCTION public.ulda_test_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = " + b!.id.toString() + " THEN PERFORM pg_advisory_xact_lock(20261006); END IF; RETURN NEW; END $$");
    await adminPool.query("CREATE TRIGGER ulda_test_pause BEFORE UPDATE ON public.ulda_resources FOR EACH ROW EXECUTE FUNCTION public.ulda_test_pause()");
    const write = storage.applyBatch([
      { id: a!.id, witness: Uint8Array.of(3), payload: Uint8Array.of(13) },
      { id: b!.id, witness: Uint8Array.of(4), payload: Uint8Array.of(14) },
    ]);
    // Consume the rejection immediately while synchronizing with the lock wait.
    outcome = write.then(() => "committed", () => "rejected");
      let pid: number | undefined;
      for (let i = 0; i < 200; i++) {
        const rows = await adminPool.query("SELECT pid FROM pg_locks WHERE locktype='advisory' AND objid=$1 AND NOT granted", [lock]);
        pid = rows.rows[0]?.pid;
        if (pid !== undefined) break;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(pid).toBeDefined();
      // First SQL UPDATE has run, but another DB connection still sees the old rows.
      expect(await storage.findManyByIds([a!.id, b!.id])).toEqual([a, b]);
      await adminPool.query("SELECT pg_terminate_backend($1)", [pid]);
      expect(await outcome).toBe("rejected");
      expect(await storage.findManyByIds([a!.id, b!.id])).toEqual([a, b]);
    } finally {
      await blocker.query("SELECT pg_advisory_unlock($1)", [lock]);
      blocker.release();
      await outcome;
      await adminPool.query("DROP TRIGGER IF EXISTS ulda_test_pause ON public.ulda_resources");
      await adminPool.query("DROP FUNCTION IF EXISTS public.ulda_test_pause()");
    }
  });

  it("reports missing update and hard-delete results", async () => {
    await expect(storage.update({
      id: 999n,
      nextWitness: Uint8Array.of(1),
      nextPayload: Uint8Array.of(2),
    })).resolves.toBeNull();
    await expect(storage.delete(999n)).resolves.toBe(false);

    const created = await storage.create({
      witness: Uint8Array.of(1),
      payload: Uint8Array.of(2),
    });
    await expect(storage.delete(created.id)).resolves.toBe(true);
    await expect(storage.delete(created.id)).resolves.toBe(false);
    await expect(storage.findById(created.id)).resolves.toBeNull();
  });
});
