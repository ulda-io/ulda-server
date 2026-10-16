import { describe, expect, it } from "vitest";

import { DomainError } from "../../src/domain/errors.js";
import { KeyedPipelineQueue } from "../../src/router/keyed-pipeline-queue.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Condition was not reached before the microtask deadline.");
}

function makeQueue(): KeyedPipelineQueue {
  return new KeyedPipelineQueue({
    maxQueuedPerKey: 10,
    maxQueuedTotal: 100,
  });
}

describe("KeyedPipelineQueue", () => {
  it("runs pipelines for the same key strictly in FIFO order", async () => {
    const queue = makeQueue();
    const releaseFirst = deferred<void>();
    const events: string[] = [];

    const first = queue.run("resource:1", async () => {
      events.push("first:start");
      await releaseFirst.promise;
      events.push("first:end");
      return "first";
    });
    const second = queue.run("resource:1", async () => {
      events.push("second:start");
      events.push("second:end");
      return "second";
    });

    await waitUntil(() => events.includes("first:start"));
    expect(events).toEqual(["first:start"]);
    expect(queue.pending).toBe(2);
    expect(queue.keys).toBe(1);

    releaseFirst.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(events).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
    expect(queue.pending).toBe(0);
    expect(queue.keys).toBe(0);
  });

  it("allows different keys to execute in parallel", async () => {
    const queue = makeQueue();
    const releaseBoth = deferred<void>();
    const entered = new Set<string>();

    const first = queue.run("resource:1", async () => {
      entered.add("resource:1");
      await releaseBoth.promise;
    });
    const second = queue.run("resource:2", async () => {
      entered.add("resource:2");
      await releaseBoth.promise;
    });

    await waitUntil(() => entered.size === 2);
    expect([...entered]).toEqual(["resource:1", "resource:2"]);
    expect(queue.pending).toBe(2);
    expect(queue.keys).toBe(2);

    releaseBoth.resolve();
    await Promise.all([first, second]);

    expect(queue.pending).toBe(0);
    expect(queue.keys).toBe(0);
  });

  it("reserves the full total capacity for a multi-key batch before it starts", async () => {
    const queue = new KeyedPipelineQueue({
      maxQueuedPerKey: 10,
      maxQueuedTotal: 3,
    });
    const entered = deferred<void>();
    const release = deferred<void>();

    const batch = queue.runMany(["resource:1", "resource:2", "resource:3"], async () => {
      entered.resolve();
      await release.promise;
      return "completed";
    });
    await entered.promise;

    expect(queue.pending).toBe(3);
    await expect(queue.run("resource:4", async () => undefined)).rejects.toEqual(
      expect.objectContaining<Partial<DomainError>>({ code: "rate_limited" }),
    );

    release.resolve();
    await expect(batch).resolves.toBe("completed");
    await expect(queue.run("resource:4", async () => "next")).resolves.toBe("next");
    expect(queue.pending).toBe(0);
    expect(queue.keys).toBe(0);
  });

  it("rejects an oversized batch without reserving any key", async () => {
    const queue = new KeyedPipelineQueue({
      maxQueuedPerKey: 10,
      maxQueuedTotal: 2,
    });
    let pipelineCalls = 0;

    await expect(queue.runMany(
      ["resource:1", "resource:2", "resource:3"],
      async () => {
        pipelineCalls += 1;
      },
    )).rejects.toEqual(
      expect.objectContaining<Partial<DomainError>>({ code: "rate_limited" }),
    );
    expect(pipelineCalls).toBe(0);
    expect(queue.pending).toBe(0);
    expect(queue.keys).toBe(0);
  });

  it("rejects a batch before reserving any key when one resource queue is full", async () => {
    const queue = new KeyedPipelineQueue({
      maxQueuedPerKey: 1,
      maxQueuedTotal: 10,
    });
    const activeEntered = deferred<void>();
    const releaseActive = deferred<void>();
    let batchCalls = 0;

    const active = queue.run("resource:2", async () => {
      activeEntered.resolve();
      await releaseActive.promise;
    });
    await activeEntered.promise;

    await expect(queue.runMany(["resource:1", "resource:2"], async () => {
      batchCalls += 1;
    })).rejects.toEqual(
      expect.objectContaining<Partial<DomainError>>({ code: "rate_limited" }),
    );
    expect(batchCalls).toBe(0);
    expect(queue.pending).toBe(1);
    await expect(queue.run("resource:1", async () => "free")).resolves.toBe("free");

    releaseActive.resolve();
    await active;
    expect(queue.pending).toBe(0);
    expect(queue.keys).toBe(0);
  });

  it("does not poison a key after an asynchronous rejection or synchronous throw", async () => {
    const queue = makeQueue();
    const events: string[] = [];

    const rejected = queue.run("resource:1", async () => {
      events.push("reject");
      throw new Error("asynchronous failure");
    });
    const afterRejected = queue.run("resource:1", async () => {
      events.push("after-reject");
      return 1;
    });

    await expect(rejected).rejects.toThrow("asynchronous failure");
    await expect(afterRejected).resolves.toBe(1);

    const thrown = queue.run("resource:1", () => {
      events.push("throw");
      throw new Error("synchronous failure");
    });
    const afterThrown = queue.run("resource:1", async () => {
      events.push("after-throw");
      return 2;
    });

    await expect(thrown).rejects.toThrow("synchronous failure");
    await expect(afterThrown).resolves.toBe(2);
    expect(events).toEqual(["reject", "after-reject", "throw", "after-throw"]);
    expect(queue.pending).toBe(0);
    expect(queue.keys).toBe(0);
  });

  it("drains accepted work, cleans up its keys, and rejects new work while draining", async () => {
    const queue = makeQueue();
    const releaseActive = deferred<void>();
    let drained = false;

    const active = queue.run("resource:1", async () => {
      await releaseActive.promise;
    });
    const queued = queue.run("resource:1", async () => undefined);

    await waitUntil(() => queue.pending === 2);
    queue.stopAccepting();
    const drain = queue.drain().then(() => {
      drained = true;
    });

    await Promise.resolve();
    expect(drained).toBe(false);
    await expect(queue.run("resource:2", async () => undefined)).rejects.toEqual(
      expect.objectContaining<Partial<DomainError>>({ code: "not_ready" }),
    );

    releaseActive.resolve();
    await Promise.all([active, queued, drain]);

    expect(drained).toBe(true);
    expect(queue.pending).toBe(0);
    expect(queue.keys).toBe(0);
  });
});
