import { SDK_LIMITS, SdkLimitError } from "../protocol/sdk-commands.js";
import { DomainError } from "./errors.js";
import type { ResourceStorage, UldaVerifier, ProofVerifier, StoredChange, CreateStoredResource } from "./ports.js";
import type { ActiveResource } from "./resource.js";

export class SdkResourceService {
  constructor(
    readonly storage: ResourceStorage,
    readonly ulda: UldaVerifier,
    readonly proof: ProofVerifier,
  ) {}

  async read(ids: readonly bigint[], maxPayloadBytes: number = SDK_LIMITS.payloadBytes, maxTotalBytes?: number): Promise<ActiveResource[]> {
    const found = await this.storage.findManyByIds(ids, {
      maxWitnessBytes: SDK_LIMITS.witnessBytes, maxPayloadBytes,
      ...(maxTotalBytes === undefined ? {} : { maxTotalBytes }),
    });
    if (found.length !== ids.length) throw new Error("Invalid storage batch.");
    let total = 0;
    return found.map((resource, index) => {
      if (resource === null) throw new DomainError("not_found", "Resource was not found.");
      if (resource === undefined || resource.id !== ids[index]) throw new Error("Misaligned storage batch.");
      if (resource.witness.byteLength > SDK_LIMITS.witnessBytes || resource.payload.byteLength > maxPayloadBytes) throw new SdkLimitError();
      total += resource.witness.byteLength + resource.payload.byteLength;
      if (maxTotalBytes !== undefined && total > maxTotalBytes) throw new SdkLimitError();
      return resource;
    });
  }

  async create(items: readonly CreateStoredResource[]): Promise<ActiveResource[]> {
    const result = await this.storage.createBatch(items);
    if (result.length !== items.length || new Set(result.map(item => item.id)).size !== result.length
      || result.some(item => item.id < 1n || item.id > 9_223_372_036_854_775_807n)) {
      throw new Error("Invalid created resource IDs.");
    }
    return result;
  }

  // Caller holds all resource locks until commit, subscription, publication and ACK.
  async validate(changes: readonly StoredChange[], maxPayloadBytes: number = SDK_LIMITS.payloadBytes): Promise<void> {
    const current = await this.read(changes.map(change => change.id), maxPayloadBytes);
    for (let index = 0; index < changes.length; index++) {
      const change = changes[index]!;
      const previous = current[index]!;
      // No client base, no reversed verification, no automatic replay/rebase.
      if (!(await this.ulda.verify(previous.witness, change.witness))) {
        throw new DomainError("invalid_transition", "Candidate does not follow current witness.");
      }
      if (!(await this.proof.verify({
        action: change.payload === undefined ? "delete" : "update",
        current: previous, candidateWitness: change.witness,
        payload: change.payload ?? null, proof: null,
      }))) throw new DomainError("invalid_proof", "Proof rejected.");
    }
  }
}
