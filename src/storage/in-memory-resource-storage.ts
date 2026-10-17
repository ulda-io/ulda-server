import type {
  CreateStoredResource,
  ResourceStorage,
  StoredChange,
  StorageReadBounds,
} from "../domain/ports.js";
import { DomainError } from "../domain/errors.js";
import type { ActiveResource } from "../domain/resource.js";

function copyBytes(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}

function cloneResource(resource: ActiveResource): ActiveResource {
  return {
    id: resource.id,
    witness: copyBytes(resource.witness),
    payload: copyBytes(resource.payload),
  };
}

/**
 * Explicit development/test adapter used to run the pipeline without a DB.
 * All records disappear when the process exits.
 */
export class InMemoryResourceStorage implements ResourceStorage {
  #nextId = 1n;
  readonly #records = new Map<bigint, ActiveResource>();

  async ping(): Promise<void> {}

  async close(): Promise<void> {}

  async create(input: CreateStoredResource): Promise<ActiveResource> {
    const resource: ActiveResource = {
      id: this.#nextId++,
      witness: copyBytes(input.witness),
      payload: copyBytes(input.payload),
    };
    this.#records.set(resource.id, resource);
    return cloneResource(resource);
  }

  async createBatch(inputs: readonly CreateStoredResource[]): Promise<ActiveResource[]> {
    const staged = inputs.map((input, index) => ({
      id: this.#nextId + BigInt(index),
      witness: copyBytes(input.witness), payload: copyBytes(input.payload),
    }));
    const result = staged.map(cloneResource);
    // No await between staging and publication of the entire batch.
    for (const resource of staged) this.#records.set(resource.id, resource);
    this.#nextId += BigInt(staged.length);
    return result;
  }

  async applyBatch(changes: readonly StoredChange[]): Promise<void> {
    const seen = new Set<bigint>();
    const staged = changes.map((change) => {
      if (seen.has(change.id) || !this.#records.has(change.id)) {
        throw new Error("Invalid atomic storage batch.");
      }
      seen.add(change.id);
      return { id: change.id, resource: change.payload === undefined ? null : {
        id: change.id, witness: copyBytes(change.witness), payload: copyBytes(change.payload),
      } };
    });
    for (const { id, resource } of staged) {
      if (resource === null) this.#records.delete(id);
      else this.#records.set(id, resource);
    }
  }

  async findById(id: bigint): Promise<ActiveResource | null> {
    const record = this.#records.get(id);
    return record === undefined ? null : cloneResource(record);
  }

  async findManyByIds(ids: readonly bigint[], bounds?: StorageReadBounds): Promise<Array<ActiveResource | null>> {
    // Check the entire batch before defensive copies, including a bad last row.
    let total = 0;
    if (bounds) for (const id of ids) {
      const row = this.#records.get(id);
      if (row) total += row.witness.byteLength + row.payload.byteLength;
      if (row && (row.witness.byteLength > bounds.maxWitnessBytes || row.payload.byteLength > bounds.maxPayloadBytes
        || (bounds.maxTotalBytes !== undefined && total > bounds.maxTotalBytes))) {
        throw new DomainError("rate_limited", "Stored row exceeds read bounds.");
      }
    }
    return ids.map((id) => {
      const resource = this.#records.get(id);
      return resource === undefined ? null : cloneResource(resource);
    });
  }

  async update(input: {
    id: bigint;
    nextWitness: Uint8Array;
    nextPayload: Uint8Array;
  }): Promise<ActiveResource | null> {
    const current = this.#records.get(input.id);
    if (current === undefined) return null;

    const updated: ActiveResource = {
      id: current.id,
      witness: copyBytes(input.nextWitness),
      payload: copyBytes(input.nextPayload),
    };
    this.#records.set(input.id, updated);
    return cloneResource(updated);
  }

  async delete(id: bigint): Promise<boolean> {
    return this.#records.delete(id);
  }
}

export function createStorage(): ResourceStorage {
  return new InMemoryResourceStorage();
}
