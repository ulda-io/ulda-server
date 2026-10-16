import { describe, expect, it } from "vitest";

import { DomainError } from "../../src/domain/errors.js";
import type {
  ProofVerificationInput,
  ProofVerifier,
} from "../../src/domain/ports.js";
import { ResourceService } from "../../src/domain/resource-service.js";
import { KeyedPipelineQueue } from "../../src/router/keyed-pipeline-queue.js";
import { RequestRouter } from "../../src/router/request-router.js";
import { InMemoryResourceStorage } from "../../src/storage/in-memory-resource-storage.js";
import {
  FakeUldaVerifier,
  RecordingPublisher,
} from "../support/fakes.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Condition was not reached before the microtask deadline.");
}

class DeferredProofVerifier implements ProofVerifier {
  readonly calls: ProofVerificationInput[] = [];
  readonly entered = deferred<void>();
  readonly release = deferred<boolean>();

  async verify(input: ProofVerificationInput): Promise<boolean> {
    this.calls.push(input);
    this.entered.resolve();
    return this.release.promise;
  }
}

class CountingInMemoryStorage extends InMemoryResourceStorage {
  updateCalls = 0;

  override async update(
    input: Parameters<InMemoryResourceStorage["update"]>[0],
  ): ReturnType<InMemoryResourceStorage["update"]> {
    this.updateCalls += 1;
    return super.update(input);
  }
}

class RecordingKeyedPipelineQueue extends KeyedPipelineQueue {
  readonly requestedKeys: string[] = [];

  override runMany<T>(
    keys: readonly string[],
    pipeline: () => Promise<T>,
  ): Promise<T> {
    this.requestedKeys.push(...keys);
    return super.runMany(keys, pipeline);
  }
}

function makeRouter(): RequestRouter {
  return new RequestRouter(new KeyedPipelineQueue({
    maxQueuedPerKey: 10,
    maxQueuedTotal: 100,
  }));
}

describe("RequestRouter", () => {
  it("lets exactly the first same-base mutation commit with a non-CAS storage adapter", async () => {
    const storage = new CountingInMemoryStorage();
    const proof = new DeferredProofVerifier();
    const ulda = new FakeUldaVerifier();
    const publisher = new RecordingPublisher();
    const service = new ResourceService({
      storage,
      proof,
      ulda,
      publisher,
      limits: { maxWitnessBytes: 64 },
    });
    const queue = new KeyedPipelineQueue({
      maxQueuedPerKey: 10,
      maxQueuedTotal: 100,
    });
    const router = new RequestRouter(queue);
    const created = await service.create({
      witness: Uint8Array.of(0, 10),
      payload: Uint8Array.of(20),
    });
    const base = {
      id: created.resource.id,
      baseWitness: created.resource.witness,
      proof: null,
    } as const;
    let secondPipelineEntered = false;

    const first = router.runResource(created.resource.id, () => service.update({
      ...base,
      candidateWitness: Uint8Array.of(1, 11),
      payload: Uint8Array.of(21),
    }));

    await proof.entered.promise;

    const second = router.runResource(created.resource.id, async () => {
      secondPipelineEntered = true;
      return service.update({
        ...base,
        candidateWitness: Uint8Array.of(1, 12),
        payload: Uint8Array.of(22),
      });
    });

    await waitUntil(() => queue.pending === 2);
    expect(secondPipelineEntered).toBe(false);
    expect(proof.calls).toHaveLength(1);
    expect(ulda.verifyCalls).toHaveLength(1);
    expect(storage.updateCalls).toBe(0);
    expect(publisher.updated).toHaveLength(0);

    proof.release.resolve(true);
    const results = await Promise.allSettled([first, second]);

    expect(results[0]).toEqual(expect.objectContaining({ status: "fulfilled" }));
    expect(results[1]).toEqual(expect.objectContaining({ status: "rejected" }));
    if (results[1]?.status !== "rejected") {
      throw new Error("The second same-base mutation unexpectedly succeeded.");
    }
    expect(results[1].reason).toEqual(
      expect.objectContaining<Partial<DomainError>>({ code: "stale_state" }),
    );
    expect(secondPipelineEntered).toBe(true);
    expect(proof.calls).toHaveLength(1);
    expect(ulda.verifyCalls).toHaveLength(1);
    expect(storage.updateCalls).toBe(1);
    expect(publisher.updated).toHaveLength(1);

    const current = await storage.findById(created.resource.id);
    expect(current).toEqual(expect.objectContaining({
      witness: Uint8Array.of(1, 11),
      payload: Uint8Array.of(21),
    }));
    expect(queue.pending).toBe(0);
    expect(queue.keys).toBe(0);
  });

  it("serializes overlapping batches without deadlocking on reversed input order", async () => {
    const queue = new KeyedPipelineQueue({
      maxQueuedPerKey: 10,
      maxQueuedTotal: 100,
    });
    const router = new RequestRouter(queue);
    const firstEntered = deferred<void>();
    const releaseFirst = deferred<void>();
    const events: string[] = [];

    const first = router.runResources([2n, 1n], async () => {
      events.push("first:start");
      firstEntered.resolve();
      await releaseFirst.promise;
      events.push("first:end");
    });
    await firstEntered.promise;

    const second = router.runResources([1n, 2n], async () => {
      events.push("second:start");
      events.push("second:end");
    });

    await waitUntil(() => queue.pending === 4);
    expect(events).toEqual(["first:start"]);

    releaseFirst.resolve();
    await Promise.all([first, second]);

    expect(events).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
    expect(queue.pending).toBe(0);
    expect(queue.keys).toBe(0);
  });

  it("drains an accepted batch that acquires later resource locks after shutdown starts", async () => {
    const queue = new KeyedPipelineQueue({
      maxQueuedPerKey: 10,
      maxQueuedTotal: 100,
    });
    const router = new RequestRouter(queue);
    const blockerEntered = deferred<void>();
    const releaseBlocker = deferred<void>();
    const batchEntered = deferred<void>();
    const releaseBatch = deferred<void>();
    let batchCalls = 0;
    let drained = false;

    const blocker = router.runResource(1n, async () => {
      blockerEntered.resolve();
      await releaseBlocker.promise;
    });
    await blockerEntered.promise;

    const acceptedBatch = router.runResources([1n, 2n], async () => {
      batchCalls += 1;
      batchEntered.resolve();
      await releaseBatch.promise;
      return "completed";
    });
    await waitUntil(() => queue.pending === 3);

    router.stopAccepting();
    const drain = router.drain().then(() => {
      drained = true;
    });
    await expect(router.runResource(3n, async () => undefined)).rejects.toEqual(
      expect.objectContaining<Partial<DomainError>>({ code: "not_ready" }),
    );

    releaseBlocker.resolve();
    await batchEntered.promise;
    await Promise.resolve();
    expect(drained).toBe(false);

    releaseBatch.resolve();
    await expect(Promise.all([blocker, acceptedBatch, drain])).resolves.toEqual([
      undefined,
      "completed",
      undefined,
    ]);
    expect(drained).toBe(true);
    expect(batchCalls).toBe(1);
    expect(queue.pending).toBe(0);
    expect(queue.keys).toBe(0);
  });

  it("allows disjoint batches to overlap", async () => {
    const router = makeRouter();
    const releaseBoth = deferred<void>();
    const entered = new Set<string>();

    const first = router.runResources([2n, 1n], async () => {
      entered.add("first");
      await releaseBoth.promise;
    });
    const second = router.runResources([4n, 3n], async () => {
      entered.add("second");
      await releaseBoth.promise;
    });

    await waitUntil(() => entered.size === 2);
    expect(entered).toEqual(new Set(["first", "second"]));

    releaseBoth.resolve();
    await Promise.all([first, second]);
  });

  it("deduplicates and locks ids in numeric order without mutating input order", async () => {
    const queue = new RecordingKeyedPipelineQueue({
      maxQueuedPerKey: 10,
      maxQueuedTotal: 100,
    });
    const router = new RequestRouter(queue);
    const ids = [10n, 2n, 10n, 1n];
    const original = [...ids];
    let pipelineCalls = 0;

    await router.runResources(ids, async () => {
      pipelineCalls += 1;
    });

    expect(ids).toEqual(original);
    expect(queue.requestedKeys).toEqual([
      "resource:1",
      "resource:2",
      "resource:10",
    ]);
    expect(pipelineCalls).toBe(1);
  });

  it("runs an empty batch exactly once without acquiring a queue key", async () => {
    const queue = new RecordingKeyedPipelineQueue({
      maxQueuedPerKey: 10,
      maxQueuedTotal: 100,
    });
    const router = new RequestRouter(queue);
    let pipelineCalls = 0;

    await router.runResources([], async () => {
      pipelineCalls += 1;
    });

    expect(pipelineCalls).toBe(1);
    expect(queue.requestedKeys).toEqual([]);
    expect(queue.pending).toBe(0);
  });

  it("tracks an accepted empty batch during drain and rejects a new one", async () => {
    const queue = new KeyedPipelineQueue({
      maxQueuedPerKey: 10,
      maxQueuedTotal: 100,
    });
    const router = new RequestRouter(queue);
    const entered = deferred<void>();
    const release = deferred<void>();
    let drained = false;

    const acceptedBatch = router.runResources([], async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;

    router.stopAccepting();
    const drain = router.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();

    expect(drained).toBe(false);
    await expect(router.runResources([], async () => undefined)).rejects.toEqual(
      expect.objectContaining<Partial<DomainError>>({ code: "not_ready" }),
    );

    release.resolve();
    await Promise.all([acceptedBatch, drain]);
    expect(drained).toBe(true);
    expect(queue.pending).toBe(0);
    expect(queue.keys).toBe(0);
  });

  it("subscribes idempotently and exposes both sides of the relationship", () => {
    const router = makeRouter();

    expect(router.subscribe("socket-a", 1n, 1)).toBe("added");
    expect(router.subscribe("socket-a", 1n, 0)).toBe("existing");

    expect(router.isSubscribed("socket-a", 1n)).toBe(true);
    expect(router.subscriptionCount("socket-a")).toBe(1);
    expect(router.subscriptions("socket-a")).toEqual([1n]);
    expect(router.subscriberIds(1n)).toEqual(["socket-a"]);
  });

  it("applies the per-socket limit without leaving a one-sided subscription", () => {
    const router = makeRouter();

    expect(router.subscribe("socket-a", 1n, 1)).toBe("added");
    expect(router.subscribe("socket-b", 2n, 2)).toBe("added");
    expect(router.subscribe("socket-a", 2n, 1)).toBe("limit");

    expect(router.subscriptions("socket-a")).toEqual([1n]);
    expect(router.subscriptionCount("socket-a")).toBe(1);
    expect(router.subscriberIds(2n)).toEqual(["socket-b"]);
    expect(router.isSubscribed("socket-a", 2n)).toBe(false);

    expect(router.subscribe("socket-a", 2n, 2)).toBe("added");
    expect(router.subscriptions("socket-a")).toEqual([1n, 2n]);
    expect(router.subscriberIds(2n)).toEqual(["socket-b", "socket-a"]);
  });

  it("unsubscribes from both indexes without changing other relationships", () => {
    const router = makeRouter();
    router.subscribe("socket-a", 1n);
    router.subscribe("socket-a", 2n);
    router.subscribe("socket-b", 1n);

    expect(router.unsubscribe("socket-a", 1n)).toBe(true);
    expect(router.unsubscribe("socket-a", 1n)).toBe(false);

    expect(router.subscriptions("socket-a")).toEqual([2n]);
    expect(router.subscriberIds(1n)).toEqual(["socket-b"]);
    expect(router.subscriberIds(2n)).toEqual(["socket-a"]);
    expect(router.subscriptions("socket-b")).toEqual([1n]);

    expect(router.unsubscribe("socket-a", 2n)).toBe(true);
    expect(router.subscriptionCount("socket-a")).toBe(0);
    expect(router.subscriptions("socket-a")).toEqual([]);
    expect(router.subscriberIds(2n)).toEqual([]);
    expect(router.subscriberIds(1n)).toEqual(["socket-b"]);
  });

  it("removes a resource from every socket while preserving their other resources", () => {
    const router = makeRouter();
    router.subscribe("socket-a", 1n);
    router.subscribe("socket-a", 2n);
    router.subscribe("socket-b", 1n);
    router.subscribe("socket-b", 3n);

    router.removeResource(1n);
    router.removeResource(1n);

    expect(router.subscriberIds(1n)).toEqual([]);
    expect(router.isSubscribed("socket-a", 1n)).toBe(false);
    expect(router.isSubscribed("socket-b", 1n)).toBe(false);
    expect(router.subscriptions("socket-a")).toEqual([2n]);
    expect(router.subscriptions("socket-b")).toEqual([3n]);
    expect(router.subscriberIds(2n)).toEqual(["socket-a"]);
    expect(router.subscriberIds(3n)).toEqual(["socket-b"]);
  });

  it("removes a disconnected socket from every resource without touching other sockets", () => {
    const router = makeRouter();
    router.subscribe("socket-a", 1n);
    router.subscribe("socket-a", 2n);
    router.subscribe("socket-b", 1n);
    router.subscribe("socket-b", 3n);

    router.unsubscribeSocket("socket-a");
    router.unsubscribeSocket("socket-a");

    expect(router.subscriptionCount("socket-a")).toBe(0);
    expect(router.subscriptions("socket-a")).toEqual([]);
    expect(router.subscriberIds(1n)).toEqual(["socket-b"]);
    expect(router.subscriberIds(2n)).toEqual([]);
    expect(router.subscriptions("socket-b")).toEqual([1n, 3n]);
    expect(router.subscriberIds(3n)).toEqual(["socket-b"]);
  });
});
