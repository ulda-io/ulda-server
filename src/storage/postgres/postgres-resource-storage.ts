import type { QueryResultRow, PoolClient } from "pg";
import { Pool } from "pg";

import type {
  CreateStoredResource,
  ResourceStorage,
  StoredChange,
  StorageReadBounds,
} from "../../domain/ports.js";
import { DomainError } from "../../domain/errors.js";
import type { ActiveResource } from "../../domain/resource.js";
import {
  createPostgresPool,
  type PostgresConnectionOptions,
} from "./postgres-pool.js";

interface ResourceRow extends QueryResultRow {
  id: string;
  witness: Buffer;
  payload: Buffer;
}

const RESOURCE_COLUMNS = "id, witness, payload";
const MAX_SIGNED_BIGINT = 9_223_372_036_854_775_807n;

function rowToResource(row: ResourceRow): ActiveResource {
  const id = BigInt(row.id);
  if (id < 1n || id > MAX_SIGNED_BIGINT) {
    throw new Error("PostgreSQL returned an invalid resource id.");
  }
  return {
    id,
    witness: new Uint8Array(row.witness),
    payload: new Uint8Array(row.payload),
  };
}

function cloneResource(resource: ActiveResource): ActiveResource {
  return {
    id: resource.id,
    witness: new Uint8Array(resource.witness),
    payload: new Uint8Array(resource.payload),
  };
}

export class PostgresResourceStorage implements ResourceStorage {
  readonly #pool: Pool;

  constructor(
    options: PostgresConnectionOptions,
    onPoolError: (error: Error) => void = () => undefined,
  ) {
    this.#pool = createPostgresPool(options);
    this.#pool.on("error", onPoolError);
  }

  async ping(): Promise<void> {
    await this.#pool.query(
      "SELECT id, witness, payload FROM public.ulda_resources LIMIT 0",
    );
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  async create(input: CreateStoredResource): Promise<ActiveResource> {
    const result = await this.#pool.query<ResourceRow>(
      "INSERT INTO public.ulda_resources (witness, payload) " +
        "VALUES ($1, $2) RETURNING " + RESOURCE_COLUMNS,
      [Buffer.from(input.witness), Buffer.from(input.payload)],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("PostgreSQL did not return the created resource.");
    }
    return rowToResource(row);
  }

  async #transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    let broken = false;
    const onClientError = () => { broken = true; };
    client.on("error", onClientError);
    try {
      await client.query("BEGIN");
      const result = await work(client);
      if (broken) throw new Error("Transaction connection failed.");
      await client.query("COMMIT");
      if (broken) throw new Error("Transaction acknowledgement unavailable.");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); }
      catch { broken = true; }
      // A COMMIT response can be lost. Transport must not claim a definite
      // rejection after an unexpected mutation error or replay the write.
      throw error;
    } finally {
      client.release(broken);
      client.off("error", onClientError);
    }
  }

  async createBatch(inputs: readonly CreateStoredResource[]): Promise<ActiveResource[]> {
    const copies = inputs.map(input => ({
      witness: Buffer.from(input.witness), payload: Buffer.from(input.payload),
    }));
    return this.#transaction(async client => {
      const result: ActiveResource[] = [];
      for (const input of copies) {
        const inserted = await client.query<ResourceRow>(
          "INSERT INTO public.ulda_resources (witness, payload) VALUES ($1, $2) RETURNING " + RESOURCE_COLUMNS,
          [input.witness, input.payload],
        );
        if (inserted.rows[0] === undefined) throw new Error("Missing created resource.");
        result.push(rowToResource(inserted.rows[0]));
      }
      return result;
    });
  }

  async applyBatch(changes: readonly StoredChange[]): Promise<void> {
    if (new Set(changes.map(change => change.id)).size !== changes.length) {
      throw new Error("Duplicate atomic storage id.");
    }
    const copies = changes.map(change => ({
      id: String(change.id), witness: Buffer.from(change.witness),
      payload: change.payload === undefined ? undefined : Buffer.from(change.payload),
    }));
    await this.#transaction(async client => {
      for (const change of copies) {
        const result = change.payload === undefined
          ? await client.query("DELETE FROM public.ulda_resources WHERE id = $1", [change.id])
          : await client.query(
            "UPDATE public.ulda_resources SET witness = $2, payload = $3 WHERE id = $1",
            [change.id, change.witness, change.payload],
          );
        if (result.rowCount !== 1) throw new Error("Missing atomic storage resource.");
      }
    });
  }

  async findById(id: bigint): Promise<ActiveResource | null> {
    const result = await this.#pool.query<ResourceRow>(
      "SELECT " + RESOURCE_COLUMNS +
        " FROM public.ulda_resources WHERE id = $1",
      [id.toString()],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToResource(row);
  }

  async findManyByIds(
    ids: readonly bigint[],
    bounds?: StorageReadBounds,
  ): Promise<Array<ActiveResource | null>> {
    if (ids.length === 0) return [];
    // Oversized legacy/corrupt rows never transfer large BYTEA values into Node.
    // Bounds are parameters, not string-interpolated SQL; one query/read snapshot.
    // Window aggregates see requested slots, including repeated IDs. One
    // statement checks lengths and returns bytes from the same MVCC snapshot;
    // no metadata query whose result could race a later payload read.
    const aggregate = bounds?.maxTotalBytes !== undefined;
    const query = aggregate
      ? `WITH selected AS (
          SELECT r.id, r.witness, r.payload,
            bool_and(octet_length(r.witness) <= $2 AND octet_length(r.payload) <= $3) OVER () AS rows_fit,
            sum(octet_length(r.witness)::bigint + octet_length(r.payload)) OVER () AS total_bytes
          FROM unnest($1::bigint[]) AS requested(id)
          JOIN public.ulda_resources r ON r.id = requested.id
        ) SELECT id,
          CASE WHEN rows_fit AND ($4::bigint IS NULL OR total_bytes <= $4) THEN witness END AS witness,
          CASE WHEN rows_fit AND ($4::bigint IS NULL OR total_bytes <= $4) THEN payload END AS payload
        FROM selected`
      : bounds
        ? "SELECT id, CASE WHEN octet_length(witness) <= $2 AND octet_length(payload) <= $3 THEN witness END AS witness, " +
          "CASE WHEN octet_length(witness) <= $2 AND octet_length(payload) <= $3 THEN payload END AS payload " +
          "FROM public.ulda_resources WHERE id = ANY($1::bigint[])"
        : "SELECT " + RESOURCE_COLUMNS + " FROM public.ulda_resources WHERE id = ANY($1::bigint[])";
    const result = await this.#pool.query<ResourceRow>(
      query,
      bounds ? [ids.map(String), bounds.maxWitnessBytes, bounds.maxPayloadBytes,
        ...(aggregate ? [bounds.maxTotalBytes] : [])] : [ids.map(String)],
    );
    if (result.rows.some(row => row.witness === null || row.payload === null)) {
      throw new DomainError("rate_limited", "Stored row exceeds read bounds.");
    }
    const byId = new Map(
      result.rows.map((row) => {
        const resource = rowToResource(row);
        return [resource.id, resource] as const;
      }),
    );
    return ids.map((id) => {
      const resource = byId.get(id);
      return resource === undefined ? null : cloneResource(resource);
    });
  }

  async update(input: {
    id: bigint;
    nextWitness: Uint8Array;
    nextPayload: Uint8Array;
  }): Promise<ActiveResource | null> {
    const result = await this.#pool.query<ResourceRow>(
      "UPDATE public.ulda_resources SET witness = $2, payload = $3 " +
        "WHERE id = $1 RETURNING " + RESOURCE_COLUMNS,
      [
        input.id.toString(),
        Buffer.from(input.nextWitness),
        Buffer.from(input.nextPayload),
      ],
    );
    const row = result.rows[0];
    return row === undefined ? null : rowToResource(row);
  }

  async delete(id: bigint): Promise<boolean> {
    const result = await this.#pool.query(
      "DELETE FROM public.ulda_resources WHERE id = $1 RETURNING id",
      [id.toString()],
    );
    return result.rowCount === 1;
  }
}
