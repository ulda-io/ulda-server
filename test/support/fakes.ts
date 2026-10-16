import type {
  ProofVerificationInput,
  ProofVerifier,
  ResourceEventPublisher,
  UldaVerifier,
} from "../../src/domain/ports.js";
import type {
  ActiveResource,
  DeletedResource,
} from "../../src/domain/resource.js";

export { InMemoryResourceStorage } from "../../src/storage/in-memory-resource-storage.js";

export class FakeUldaVerifier implements UldaVerifier {
  readonly #order: string[] | undefined;
  readonly verifyCalls: Array<{
    previous: Uint8Array;
    candidate: Uint8Array;
  }> = [];

  constructor(order?: string[]) {
    this.#order = order;
  }

  async verify(previous: Uint8Array, candidate: Uint8Array): Promise<boolean> {
    this.#order?.push("ulda");
    this.verifyCalls.push({
      previous: new Uint8Array(previous),
      candidate: new Uint8Array(candidate),
    });
    const previousIndex = previous[0];
    const candidateIndex = candidate[0];
    if (previousIndex === undefined || candidateIndex === undefined) return false;
    const gap = BigInt(candidateIndex) - BigInt(previousIndex);
    return gap > 0n && gap < 5n;
  }
}

export class RecordingProofVerifier implements ProofVerifier {
  readonly #order: string[] | undefined;
  readonly calls: ProofVerificationInput[] = [];
  allowed: boolean;

  constructor(allowed = true, order?: string[]) {
    this.allowed = allowed;
    this.#order = order;
  }

  async verify(input: ProofVerificationInput): Promise<boolean> {
    this.#order?.push("proof");
    this.calls.push(input);
    return this.allowed;
  }
}

export class RecordingPublisher implements ResourceEventPublisher {
  readonly updated: ActiveResource[] = [];
  readonly deleted: DeletedResource[] = [];

  async resourceUpdated(resource: ActiveResource): Promise<void> {
    this.updated.push(resource);
  }

  async resourceDeleted(resource: DeletedResource): Promise<void> {
    this.deleted.push(resource);
  }
}
