import type {
  ActiveResource,
  DeletedResource,
  OpaqueProof,
} from "./resource.js";

export interface CreateStoredResource {
  witness: Uint8Array;
  payload: Uint8Array;
}

/** All entries must commit together; absence of payload means hard delete. */
export interface StoredChange {
  id: bigint;
  witness: Uint8Array;
  payload?: Uint8Array;
}

export interface StorageReadBounds { maxWitnessBytes: number; maxPayloadBytes: number }

export interface ResourceStorage {
  ping(): Promise<void>;
  close(): Promise<void>;
  create(input: CreateStoredResource): Promise<ActiveResource>;
  createBatch(inputs: readonly CreateStoredResource[]): Promise<ActiveResource[]>;
  /** All entries commit together; missing/duplicate IDs reject the entire batch. */
  applyBatch(changes: readonly StoredChange[]): Promise<void>;
  findById(id: bigint): Promise<ActiveResource | null>;
  /** Aligned slots. When bounds are supplied, reject oversized rows BEFORE copying
   * or transferring their blobs into this process. Custom adapters must honor this. */
  findManyByIds(ids: readonly bigint[], bounds?: StorageReadBounds): Promise<Array<ActiveResource | null>>;
  update(input: {
    id: bigint;
    nextWitness: Uint8Array;
    nextPayload: Uint8Array;
  }): Promise<ActiveResource | null>;
  delete(id: bigint): Promise<boolean>;
}

export interface UldaVerifier {
  verify(previousWitness: Uint8Array, candidateWitness: Uint8Array): Promise<boolean>;
}

export interface ProofVerificationInput {
  action: "update" | "delete";
  current: ActiveResource;
  candidateWitness: Uint8Array;
  payload: Uint8Array | null;
  proof: OpaqueProof;
}

export interface ProofVerifier {
  verify(input: ProofVerificationInput): Promise<boolean>;
}

export interface ResourceEventPublisher {
  resourceUpdated(resource: ActiveResource): Promise<void>;
  resourceDeleted(resource: DeletedResource): Promise<void>;
}

export interface ServiceLimits {
  maxWitnessBytes: number;
}
