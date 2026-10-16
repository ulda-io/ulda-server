import { describe, expect, it } from "vitest";

import { DomainError } from "../../src/domain/errors.js";
import { ResourceService } from "../../src/domain/resource-service.js";
import {
  FakeUldaVerifier,
  InMemoryResourceStorage,
  RecordingProofVerifier,
  RecordingPublisher,
} from "../support/fakes.js";

class CountingBatchStorage extends InMemoryResourceStorage {
  findManyCalls = 0;

  override async findManyByIds(ids: readonly bigint[]) {
    this.findManyCalls += 1;
    return await super.findManyByIds(ids);
  }
}

class MisalignedBatchStorage extends InMemoryResourceStorage {
  override async findManyByIds(ids: readonly bigint[]) {
    const found = await super.findManyByIds(ids);
    return found.length === 2 ? [found[1] ?? null, found[0] ?? null] : found;
  }
}

function makeService(options: {
  proofAllowed?: boolean;
  storage?: InMemoryResourceStorage;
} = {}) {
  const storage = options.storage ?? new InMemoryResourceStorage();
  const publisher = new RecordingPublisher();
  const order: string[] = [];
  const ulda = new FakeUldaVerifier(order);
  const proof = new RecordingProofVerifier(options.proofAllowed ?? true, order);
  const service = new ResourceService({
    storage,
    publisher,
    ulda,
    proof,
    limits: { maxWitnessBytes: 64 },
  });
  return { service, storage, publisher, ulda, proof, order };
}

describe("ResourceService", () => {
  it("accepts an already advanced witness and allows independent rows with the same witness", async () => {
    const { service, ulda } = makeService();
    const witness = Uint8Array.of(1, 10);

    const first = await service.create({
      witness,
      payload: Uint8Array.of(20),
    });
    const second = await service.create({
      witness,
      payload: Uint8Array.of(21),
    });

    expect(first.resource.id).not.toBe(second.resource.id);
    expect(first.resource.witness).toEqual(witness);
    expect(second.resource.witness).toEqual(witness);
    expect(Object.keys(first.resource).sort()).toEqual(["id", "payload", "witness"]);
    expect(ulda.verifyCalls).toHaveLength(0);
  });

  it("stores an opaque first witness without interpreting its ULDA structure", async () => {
    const { service, ulda } = makeService();
    const opaqueWitness = Uint8Array.of(255, 0, 127, 99);

    const created = await service.create({
      witness: opaqueWitness,
      payload: Uint8Array.of(20),
    });

    expect(created.resource.witness).toEqual(opaqueWitness);
    expect(ulda.verifyCalls).toHaveLength(0);
  });

  it("retains the application-level witness size limit", async () => {
    const { service } = makeService();

    await expect(service.create({
      witness: new Uint8Array(65),
      payload: Uint8Array.of(20),
    })).rejects.toEqual(
      expect.objectContaining<Partial<DomainError>>({ code: "invalid_witness" }),
    );
  });

  it("creates, updates and recognizes an exact retry", async () => {
    const { service, publisher, proof, ulda } = makeService();
    const created = await service.create({
      witness: Uint8Array.of(0, 10),
      payload: Uint8Array.of(20),
    });
    const updated = await service.update({
      id: created.resource.id,
      baseWitness: created.resource.witness,
      candidateWitness: Uint8Array.of(1, 11),
      payload: Uint8Array.of(21),
      proof: null,
    });
    const retried = await service.update({
      id: created.resource.id,
      baseWitness: created.resource.witness,
      candidateWitness: updated.resource.witness,
      payload: updated.resource.payload,
      proof: null,
    });

    expect(updated.resource.witness).toEqual(Uint8Array.of(1, 11));
    expect(retried.idempotent).toBe(true);
    expect(publisher.updated).toHaveLength(1);
    expect(ulda.verifyCalls).toHaveLength(1);
    expect(proof.calls).toHaveLength(1);
  });

  it("does not apply an application-level payload size limit", async () => {
    const { service } = makeService();
    const payload = new Uint8Array(128 * 1024).fill(7);

    const created = await service.create({
      witness: Uint8Array.of(0, 10),
      payload,
    });

    expect(created.resource.payload).toEqual(payload);
  });

  it("reads many resources in input order and reports missing ids with one storage call", async () => {
    const storage = new CountingBatchStorage();
    const { service } = makeService({ storage });
    const first = await service.create({
      witness: Uint8Array.of(0, 10),
      payload: Uint8Array.of(20),
    });
    await service.create({
      witness: Uint8Array.of(0, 11),
      payload: Uint8Array.of(21),
    });
    const third = await service.create({
      witness: Uint8Array.of(0, 12),
      payload: Uint8Array.of(22),
    });

    const result = await service.readMany([third.resource.id, 999n, first.resource.id]);

    expect(result.resources.map((resource) => resource.id)).toEqual([
      third.resource.id,
      first.resource.id,
    ]);
    expect(result.missingIds).toEqual([999n]);
    expect(storage.findManyCalls).toBe(1);

    await expect(service.readMany([])).resolves.toEqual({
      resources: [],
      missingIds: [],
    });
    expect(storage.findManyCalls).toBe(1);
  });

  it("rejects a storage batch whose slots do not match the requested ids", async () => {
    const storage = new MisalignedBatchStorage();
    const { service } = makeService({ storage });
    const first = await service.create({
      witness: Uint8Array.of(0, 10),
      payload: Uint8Array.of(20),
    });
    const second = await service.create({
      witness: Uint8Array.of(0, 11),
      payload: Uint8Array.of(21),
    });

    await expect(service.readMany([first.resource.id, second.resource.id])).rejects.toEqual(
      expect.objectContaining<Partial<DomainError>>({ code: "internal_error" }),
    );
  });

  it("rejects a stale mutation by comparing the base witness", async () => {
    const { service, proof, ulda } = makeService();
    const created = await service.create({
      witness: Uint8Array.of(0, 10),
      payload: Uint8Array.of(20),
    });
    await service.update({
      id: created.resource.id,
      baseWitness: created.resource.witness,
      candidateWitness: Uint8Array.of(1, 11),
      payload: Uint8Array.of(21),
      proof: null,
    });

    await expect(service.update({
      id: created.resource.id,
      baseWitness: created.resource.witness,
      candidateWitness: Uint8Array.of(2, 12),
      payload: Uint8Array.of(22),
      proof: null,
    })).rejects.toEqual(
      expect.objectContaining<Partial<DomainError>>({
        code: "stale_state",
        current: expect.objectContaining({ witness: Uint8Array.of(1, 11) }),
      }),
    );

    expect(proof.calls).toHaveLength(1);
    expect(ulda.verifyCalls).toHaveLength(1);
  });

  it("runs the proof gate for fresh update and delete mutations", async () => {
    const { service, proof, order } = makeService();
    const updatedResource = await service.create({
      witness: Uint8Array.of(0, 10),
      payload: Uint8Array.of(20),
    });
    const deletedResource = await service.create({
      witness: Uint8Array.of(0, 12),
      payload: Uint8Array.of(22),
    });
    const updateProof = { version: "stub", token: "update" };
    const deleteProof = { version: "stub", token: "delete" };

    await service.update({
      id: updatedResource.resource.id,
      baseWitness: updatedResource.resource.witness,
      candidateWitness: Uint8Array.of(1, 11),
      payload: Uint8Array.of(21),
      proof: updateProof,
    });
    await service.delete({
      id: deletedResource.resource.id,
      baseWitness: deletedResource.resource.witness,
      candidateWitness: Uint8Array.of(1, 13),
      proof: deleteProof,
    });

    expect(proof.calls).toHaveLength(2);
    expect(proof.calls[0]).toMatchObject({
      action: "update",
      current: { id: updatedResource.resource.id },
      candidateWitness: Uint8Array.of(1, 11),
      payload: Uint8Array.of(21),
      proof: updateProof,
    });
    expect(proof.calls[1]).toMatchObject({
      action: "delete",
      current: { id: deletedResource.resource.id },
      candidateWitness: Uint8Array.of(1, 13),
      payload: null,
      proof: deleteProof,
    });
    expect(order).toEqual(["ulda", "proof", "ulda", "proof"]);
  });

  it.each(["update", "delete"] as const)(
    "rejects a fresh %s when proof is false without mutating or publishing",
    async (action) => {
      const { service, storage, publisher, ulda, proof } = makeService({
        proofAllowed: false,
      });
      const created = await service.create({
        witness: Uint8Array.of(0, 10),
        payload: Uint8Array.of(20),
      });

      const mutation = action === "update"
        ? service.update({
            id: created.resource.id,
            baseWitness: created.resource.witness,
            candidateWitness: Uint8Array.of(1, 11),
            payload: Uint8Array.of(21),
            proof: null,
          })
        : service.delete({
            id: created.resource.id,
            baseWitness: created.resource.witness,
            candidateWitness: Uint8Array.of(1, 11),
            proof: null,
          });

      await expect(mutation).rejects.toEqual(
        expect.objectContaining<Partial<DomainError>>({ code: "invalid_proof" }),
      );
      await expect(storage.findById(created.resource.id)).resolves.toMatchObject({
        witness: created.resource.witness,
        payload: created.resource.payload,
      });
      expect(proof.calls).toHaveLength(1);
      expect(ulda.verifyCalls).toHaveLength(1);
      expect(publisher.updated).toHaveLength(0);
      expect(publisher.deleted).toHaveLength(0);
    },
  );

  it("rejects an invalid ULDA transition before running proof", async () => {
    const { service, storage, publisher, ulda, proof } = makeService();
    const created = await service.create({
      witness: Uint8Array.of(0, 10),
      payload: Uint8Array.of(20),
    });

    await expect(service.update({
      id: created.resource.id,
      baseWitness: created.resource.witness,
      candidateWitness: Uint8Array.of(5, 11),
      payload: Uint8Array.of(21),
      proof: { version: "stub" },
    })).rejects.toEqual(
      expect.objectContaining<Partial<DomainError>>({ code: "invalid_transition" }),
    );

    expect(proof.calls).toHaveLength(0);
    expect(ulda.verifyCalls).toHaveLength(1);
    await expect(storage.findById(created.resource.id)).resolves.toMatchObject({
      witness: created.resource.witness,
      payload: created.resource.payload,
    });
    expect(publisher.updated).toHaveLength(0);
    expect(publisher.deleted).toHaveLength(0);
  });

  it("hard-deletes the row and returns not_found on a repeated delete", async () => {
    const { service, storage, publisher } = makeService();
    const created = await service.create({
      witness: Uint8Array.of(0, 10),
      payload: Uint8Array.of(20),
    });
    const command = {
      id: created.resource.id,
      baseWitness: created.resource.witness,
      candidateWitness: Uint8Array.of(1, 11),
      proof: null,
    };
    const deleted = await service.delete(command);

    expect(deleted).toEqual({
      resource: {
        id: created.resource.id,
        witness: Uint8Array.of(1, 11),
      },
      idempotent: false,
    });
    expect(deleted.resource).not.toHaveProperty("payload");
    await expect(storage.findById(created.resource.id)).resolves.toBeNull();
    expect(publisher.deleted).toHaveLength(1);
    expect(publisher.deleted[0]).toEqual(deleted.resource);
    await expect(service.read(created.resource.id)).rejects.toEqual(
      expect.objectContaining<Partial<DomainError>>({ code: "not_found" }),
    );
    await expect(service.delete(command)).rejects.toEqual(
      expect.objectContaining<Partial<DomainError>>({ code: "not_found" }),
    );
    expect(publisher.deleted).toHaveLength(1);
  });
});
