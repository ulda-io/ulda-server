import { DomainError } from "./errors.js";
import type {
  ProofVerifier,
  ResourceEventPublisher,
  ResourceStorage,
  ServiceLimits,
  UldaVerifier,
} from "./ports.js";
import type {
  ActiveResource,
  CreateResourceCommand,
  DeleteResourceCommand,
  DeletedResource,
  MutationResult,
  ReadManyResult,
  UpdateResourceCommand,
} from "./resource.js";

export interface ResourceServiceOptions {
  storage: ResourceStorage;
  ulda: UldaVerifier;
  proof: ProofVerifier;
  publisher: ResourceEventPublisher;
  limits: ServiceLimits;
  onPublishError?: (error: unknown, event: "updated" | "deleted", id: bigint) => void;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

export class ResourceService {
  readonly #storage: ResourceStorage;
  readonly #ulda: UldaVerifier;
  readonly #proof: ProofVerifier;
  readonly #publisher: ResourceEventPublisher;
  readonly #limits: ServiceLimits;
  readonly #onPublishError: NonNullable<ResourceServiceOptions["onPublishError"]>;

  constructor(options: ResourceServiceOptions) {
    this.#storage = options.storage;
    this.#ulda = options.ulda;
    this.#proof = options.proof;
    this.#publisher = options.publisher;
    this.#limits = options.limits;
    this.#onPublishError = options.onPublishError ?? (() => undefined);
  }

  async create(command: CreateResourceCommand): Promise<MutationResult<ActiveResource>> {
    this.#assertWitnessSize(command.witness);

    const resource = await this.#storage.create({
      witness: command.witness,
      payload: command.payload,
    });

    return { resource, idempotent: false };
  }

  async read(id: bigint): Promise<ActiveResource> {
    const current = await this.#storage.findById(id);
    if (current === null) {
      throw new DomainError("not_found", "Resource was not found.");
    }
    return current;
  }

  async readMany(ids: readonly bigint[]): Promise<ReadManyResult> {
    if (ids.length === 0) return { resources: [], missingIds: [] };

    const found = await this.#storage.findManyByIds(ids);
    if (found.length !== ids.length) {
      throw new DomainError(
        "internal_error",
        "Storage returned an invalid batch-read result.",
      );
    }

    const resources: ActiveResource[] = [];
    const missingIds: bigint[] = [];
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index];
      const resource = found[index];
      if (id === undefined) continue;
      if (resource === null || resource === undefined) missingIds.push(id);
      else if (resource.id !== id) {
        throw new DomainError(
          "internal_error",
          "Storage returned a resource in the wrong batch-read slot.",
        );
      } else resources.push(resource);
    }
    return { resources, missingIds };
  }

  async update(command: UpdateResourceCommand): Promise<MutationResult<ActiveResource>> {
    this.#assertWitnessSize(command.baseWitness);
    this.#assertWitnessSize(command.candidateWitness);

    const previous = await this.#storage.findById(command.id);
    if (previous === null) {
      throw new DomainError("not_found", "Resource was not found.");
    }

    if (equalBytes(command.candidateWitness, previous.witness)) {
      if (equalBytes(command.payload, previous.payload)) {
        return { resource: previous, idempotent: true };
      }
      throw new DomainError(
        "witness_reuse_conflict",
        "Current witness cannot be reused with a different payload.",
        { current: previous },
      );
    }

    this.#assertBaseMatches(command.baseWitness, previous);

    if (!(await this.#ulda.verify(previous.witness, command.candidateWitness))) {
      throw new DomainError(
        "invalid_transition",
        "Candidate is not a valid ULDA transition from current state.",
        { current: previous },
      );
    }

    if (!(await this.#proof.verify({
      action: "update",
      current: previous,
      candidateWitness: command.candidateWitness,
      payload: command.payload,
      proof: command.proof,
    }))) {
      throw new DomainError(
        "invalid_proof",
        "Mutation proof was rejected.",
        { current: previous },
      );
    }

    const updated = await this.#storage.update({
      id: command.id,
      nextWitness: command.candidateWitness,
      nextPayload: command.payload,
    });

    if (updated === null) {
      const current = await this.#storage.findById(command.id);
      if (current === null) {
        throw new DomainError("not_found", "Resource was not found.");
      }
      throw this.#stale(current);
    }

    await this.#publishUpdated(updated);
    return { resource: updated, idempotent: false };
  }

  async delete(command: DeleteResourceCommand): Promise<MutationResult<DeletedResource>> {
    this.#assertWitnessSize(command.baseWitness);
    this.#assertWitnessSize(command.candidateWitness);

    const previous = await this.#storage.findById(command.id);
    if (previous === null) {
      throw new DomainError("not_found", "Resource was not found.");
    }

    this.#assertBaseMatches(command.baseWitness, previous);

    if (!(await this.#ulda.verify(previous.witness, command.candidateWitness))) {
      throw new DomainError(
        "invalid_transition",
        "Candidate is not a valid ULDA transition from current state.",
        { current: previous },
      );
    }

    if (!(await this.#proof.verify({
      action: "delete",
      current: previous,
      candidateWitness: command.candidateWitness,
      payload: null,
      proof: command.proof,
    }))) {
      throw new DomainError(
        "invalid_proof",
        "Mutation proof was rejected.",
        { current: previous },
      );
    }

    const deleted = await this.#storage.delete(command.id);

    if (!deleted) {
      const current = await this.#storage.findById(command.id);
      if (current === null) {
        throw new DomainError("not_found", "Resource was not found.");
      }
      throw this.#stale(current);
    }

    const deletedResource: DeletedResource = {
      id: previous.id,
      witness: command.candidateWitness,
    };

    await this.#publishDeleted(deletedResource);
    return { resource: deletedResource, idempotent: false };
  }

  #assertWitnessSize(witness: Uint8Array): void {
    if (witness.byteLength === 0 || witness.byteLength > this.#limits.maxWitnessBytes) {
      throw new DomainError(
        "invalid_witness",
        `Witness must contain 1..${this.#limits.maxWitnessBytes} bytes.`,
      );
    }
  }

  #assertBaseMatches(
    baseWitness: Uint8Array,
    current: ActiveResource,
  ): void {
    if (!equalBytes(baseWitness, current.witness)) {
      throw this.#stale(current);
    }
  }

  #stale(current: ActiveResource): DomainError {
    return new DomainError(
      "stale_state",
      "Resource was updated. Build a candidate valid from current state.",
      { current },
    );
  }

  async #publishUpdated(resource: ActiveResource): Promise<void> {
    try {
      await this.#publisher.resourceUpdated(resource);
    } catch (error) {
      this.#onPublishError(error, "updated", resource.id);
    }
  }

  async #publishDeleted(resource: DeletedResource): Promise<void> {
    try {
      await this.#publisher.resourceDeleted(resource);
    } catch (error) {
      this.#onPublishError(error, "deleted", resource.id);
    }
  }
}
