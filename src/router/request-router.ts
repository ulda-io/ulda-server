import type { KeyedPipelineQueue } from "./keyed-pipeline-queue.js";

export type SubscriptionResult = "added" | "existing" | "limit";

function removeValue<T>(values: T[], value: T): boolean {
  const index = values.indexOf(value);
  if (index === -1) return false;
  values.splice(index, 1);
  return true;
}

export class RequestRouter {
  readonly #queue: KeyedPipelineQueue;
  #subscriptionTotal = 0;
  get subscriptionTotal(): number { return this.#subscriptionTotal; }
  readonly #socketIdsByResource = new Map<bigint, string[]>();
  readonly #resourceIdsBySocket = new Map<string, bigint[]>();

  constructor(queue: KeyedPipelineQueue) {
    this.#queue = queue;
  }

  runCreate<T>(pipeline: () => Promise<T>): Promise<T> {
    return this.#queue.run("create", pipeline);
  }

  runResource<T>(id: bigint, pipeline: () => Promise<T>): Promise<T> {
    return this.#queue.run(this.#resourceKey(id), pipeline);
  }

  runResources<T>(ids: readonly bigint[], pipeline: () => Promise<T>): Promise<T> {
    const orderedIds = [...new Set(ids)].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0
    );
    return this.#queue.runMany(
      orderedIds.map((id) => this.#resourceKey(id)),
      pipeline,
    );
  }

  subscribe(
    socketId: string,
    resourceId: bigint,
    maxSubscriptions = Number.POSITIVE_INFINITY,
  ): SubscriptionResult {
    if (this.isSubscribed(socketId, resourceId)) return "existing";
    if (this.subscriptionCount(socketId) >= maxSubscriptions) return "limit";

    let socketIds = this.#socketIdsByResource.get(resourceId);
    if (socketIds === undefined) {
      socketIds = [];
      this.#socketIdsByResource.set(resourceId, socketIds);
    }
    socketIds.push(socketId);

    let resourceIds = this.#resourceIdsBySocket.get(socketId);
    if (resourceIds === undefined) {
      resourceIds = [];
      this.#resourceIdsBySocket.set(socketId, resourceIds);
    }
    resourceIds.push(resourceId);
    this.#subscriptionTotal++;
    return "added";
  }

  unsubscribe(socketId: string, resourceId: bigint): boolean {
    const socketIds = this.#socketIdsByResource.get(resourceId);
    const removed = socketIds === undefined ? false : removeValue(socketIds, socketId);
    if (socketIds?.length === 0) this.#socketIdsByResource.delete(resourceId);

    const resourceIds = this.#resourceIdsBySocket.get(socketId);
    if (resourceIds !== undefined) removeValue(resourceIds, resourceId);
    if (resourceIds?.length === 0) this.#resourceIdsBySocket.delete(socketId);
    if (removed) this.#subscriptionTotal--;
    return removed;
  }

  unsubscribeSocket(socketId: string): void {
    const resourceIds = this.#resourceIdsBySocket.get(socketId);
    if (resourceIds === undefined) return;
    for (const resourceId of resourceIds) {
      const socketIds = this.#socketIdsByResource.get(resourceId);
      if (socketIds !== undefined) removeValue(socketIds, socketId);
      if (socketIds?.length === 0) this.#socketIdsByResource.delete(resourceId);
    }
    this.#subscriptionTotal -= resourceIds.length;
    this.#resourceIdsBySocket.delete(socketId);
  }

  removeResource(resourceId: bigint): void {
    const socketIds = this.#socketIdsByResource.get(resourceId);
    if (socketIds === undefined) return;
    for (const socketId of socketIds) {
      const resourceIds = this.#resourceIdsBySocket.get(socketId);
      if (resourceIds !== undefined) removeValue(resourceIds, resourceId);
      if (resourceIds?.length === 0) this.#resourceIdsBySocket.delete(socketId);
    }
    this.#subscriptionTotal -= socketIds.length;
    this.#socketIdsByResource.delete(resourceId);
  }

  subscriberIds(resourceId: bigint): string[] {
    return [...(this.#socketIdsByResource.get(resourceId) ?? [])];
  }

  subscriptionCount(socketId: string): number {
    return this.#resourceIdsBySocket.get(socketId)?.length ?? 0;
  }

  isSubscribed(socketId: string, resourceId: bigint): boolean {
    return this.#resourceIdsBySocket.get(socketId)?.includes(resourceId) ?? false;
  }

  subscriptions(socketId: string): bigint[] {
    return [...(this.#resourceIdsBySocket.get(socketId) ?? [])];
  }

  stopAccepting(): void {
    this.#queue.stopAccepting();
  }

  drain(): Promise<void> {
    this.stopAccepting();
    return this.#queue.drain();
  }

  #resourceKey(id: bigint): string {
    return `resource:${id}`;
  }

}
