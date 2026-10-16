import { DomainError } from "../domain/errors.js";

export interface PipelineQueueLimits {
  maxQueuedPerKey: number;
  maxQueuedTotal: number;
}

interface KeyReservation {
  key: string;
  previous: Promise<void>;
  tail: Promise<void>;
  release(): void;
}

/**
 * Serializes complete pipelines for the same key while allowing unrelated
 * resources to progress independently in the same Node.js event loop.
 */
export class KeyedPipelineQueue {
  readonly #limits: PipelineQueueLimits;
  readonly #tails = new Map<string, Promise<void>>();
  readonly #depthByKey = new Map<string, number>();
  readonly #acceptedOperations = new Set<Promise<void>>();
  #pending = 0;
  #reservedCapacity = 0;
  #accepting = true;

  constructor(limits: PipelineQueueLimits) {
    this.#limits = limits;
  }

  get pending(): number {
    return this.#pending;
  }

  get keys(): number {
    return this.#tails.size;
  }

  run<T>(key: string, pipeline: () => Promise<T>): Promise<T> {
    return this.#accept([key], pipeline);
  }

  /**
   * Admits one external operation before acquiring any keys. Later key
   * acquisitions are private continuations of that accepted operation, so a
   * concurrent shutdown cannot reject the operation halfway through.
   */
  runMany<T>(keys: readonly string[], pipeline: () => Promise<T>): Promise<T> {
    const stableKeys = [...new Set(keys)];
    return this.#accept(stableKeys, pipeline);
  }

  async #accept<T>(
    keys: readonly string[],
    pipeline: () => Promise<T>,
  ): Promise<T> {
    if (!this.#accepting) {
      throw new DomainError("not_ready", "Server is shutting down.");
    }
    const capacity = Math.max(1, keys.length);
    if (this.#reservedCapacity + capacity > this.#limits.maxQueuedTotal) {
      throw new DomainError("rate_limited", "Server pipeline queue is full.");
    }
    for (const key of keys) {
      if ((this.#depthByKey.get(key) ?? 0) >= this.#limits.maxQueuedPerKey) {
        throw new DomainError(
          "rate_limited",
          "Too many pipelines are queued for this resource.",
        );
      }
    }

    let markSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    this.#acceptedOperations.add(settled);
    this.#reservedCapacity += capacity;
    const reservations: KeyReservation[] = [];

    try {
      // Reserve every selected key synchronously. Capacity can therefore fail
      // only before the operation starts, never halfway through a batch.
      for (const key of keys) reservations.push(this.#reserve(key));
      await Promise.all(
        reservations.map(async ({ previous }) => {
          await previous.catch(() => undefined);
        }),
      );
      return await pipeline();
    } finally {
      for (const reservation of reservations) reservation.release();
      for (const reservation of reservations) this.#cleanup(reservation);
      this.#reservedCapacity -= capacity;
      markSettled();
      this.#acceptedOperations.delete(settled);
    }
  }

  #reserve(key: string): KeyReservation {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);

    this.#tails.set(key, tail);
    this.#depthByKey.set(key, (this.#depthByKey.get(key) ?? 0) + 1);
    this.#pending += 1;
    return { key, previous, tail, release };
  }

  #cleanup({ key, tail }: KeyReservation): void {
    this.#pending -= 1;
    const remaining = (this.#depthByKey.get(key) ?? 1) - 1;
    if (remaining === 0) this.#depthByKey.delete(key);
    else this.#depthByKey.set(key, remaining);
    if (this.#tails.get(key) === tail) this.#tails.delete(key);
  }

  stopAccepting(): void {
    this.#accepting = false;
  }

  async drain(): Promise<void> {
    this.stopAccepting();
    // Every public run/runMany call has one root completion promise here,
    // including an empty multi-key operation.
    await Promise.all(
      [...this.#acceptedOperations].map(async (operation) => {
        await operation;
      }),
    );
  }
}
