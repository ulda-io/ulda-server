export interface ActiveResource {
  id: bigint;
  witness: Uint8Array;
  payload: Uint8Array;
}

/** Transient result/event payload. Deleted resources are not persisted. */
export interface DeletedResource {
  id: bigint;
  witness: Uint8Array;
}

export type OpaqueProof = Readonly<Record<string, unknown>> | null;

export interface CreateResourceCommand {
  witness: Uint8Array;
  payload: Uint8Array;
}

export interface UpdateResourceCommand {
  id: bigint;
  baseWitness: Uint8Array;
  candidateWitness: Uint8Array;
  payload: Uint8Array;
  proof: OpaqueProof;
}

export interface DeleteResourceCommand {
  id: bigint;
  baseWitness: Uint8Array;
  candidateWitness: Uint8Array;
  proof: OpaqueProof;
}

export interface MutationResult<T> {
  resource: T;
  idempotent: boolean;
}

export interface ReadManyResult {
  resources: ActiveResource[];
  missingIds: bigint[];
}
