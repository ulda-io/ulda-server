import { io as createClient, type Socket } from "socket.io-client";
import { afterEach, describe, expect, it } from "vitest";

import { createUldaServer, type UldaServer } from "../../src/app/create-server.js";
import type { AppConfig } from "../../src/config/config.js";
import type {
  ProofVerificationInput,
  ProofVerifier,
} from "../../src/domain/ports.js";
import { createLogger } from "../../src/observability/logger.js";
import {
  FakeUldaVerifier,
  InMemoryResourceStorage,
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

class CountingStorage extends InMemoryResourceStorage {
  updateCalls = 0;
  findManyCalls = 0;

  override async update(
    input: Parameters<InMemoryResourceStorage["update"]>[0],
  ): ReturnType<InMemoryResourceStorage["update"]> {
    this.updateCalls += 1;
    return super.update(input);
  }

  override async findManyByIds(
    ids: readonly bigint[],
  ): ReturnType<InMemoryResourceStorage["findManyByIds"]> {
    this.findManyCalls += 1;
    return super.findManyByIds(ids);
  }
}

class CloseRecordingStorage extends InMemoryResourceStorage {
  closeCalls = 0;

  override async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

class DelayedReadinessStorage extends InMemoryResourceStorage {
  pingCalls = 0;
  readonly readinessPingEntered = deferred<void>();
  readonly releaseReadinessPing = deferred<void>();

  override async ping(): Promise<void> {
    this.pingCalls += 1;
    if (this.pingCalls === 1) return;
    this.readinessPingEntered.resolve();
    await this.releaseReadinessPing.promise;
  }
}

function testConfig(): AppConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    logLevel: "error",
    storageAdapterModule: undefined,
    database: {
      connectionString: undefined,
      maxConnections: 10,
      connectionTimeoutMs: 5000,
      idleTimeoutMs: 30000,
      statementTimeoutMs: 10000,
      lockTimeoutMs: 5000,
      idleInTransactionTimeoutMs: 10000,
    },
    corsOrigins: ["*"],
    serverVersion: "0.1.0-test",
    protocolVersion: "1.0",
    ulda: {
      coreVersion: "fake",
      pack: "compactV1",
      N: 5,
      mode: "S",
      hash: "SHA-256",
      originSize: 256,
      ageBytes: 4,
    },
    limits: {
      maxWitnessBytes: 64,
      maxSocketMessageBytes: 4096,
      maxSubscriptionsPerSocket: 10,
      maxQueuedPerResource: 10,
      maxQueuedTotal: 100,
      maxBufferedSocketBytes: 16777216,
      maxConnections: 1000, maxSubscriptionsTotal: 100000, maxInflightBytes: 67108864, maxActiveReadBytes: 268435456,
      maxBufferedTotalBytes: 67108864, maxPendingCommandsPerSocket: 64,
      maxCommandsPerSecond: 1000, commandBurst: 2000, binaryPacketTimeoutMs: 30000,
    },
    readiness: { timeoutMs: 2000, cacheMs: 1000, maxWaiters: 32 },
    gracefulShutdownTimeoutMs: 1000,
  };
}

async function connect(url: string): Promise<Socket> {
  const socket = createClient(url, {
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  return socket;
}

function connectedSocketId(socket: Socket): string {
  if (socket.id === undefined) throw new Error("Socket is not connected.");
  return socket.id;
}

describe("Socket.IO-only server", () => {
  let server: UldaServer | undefined;
  const sockets: Socket[] = [];

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    sockets.length = 0;
    await server?.close();
    server = undefined;
  });

  it("keeps storage open until an accepted multi-resource request finishes", async () => {
    const storage = new CloseRecordingStorage();
    server = createUldaServer({
    protocol: "legacy",
      config: testConfig(),
      storage,
      ulda: new FakeUldaVerifier(),
      logger: createLogger("error"),
    });
    const address = await server.start();
    const url = `http://127.0.0.1:${address.port}`;
    const socket = await connect(url);
    sockets.push(socket);
    const blockerEntered = deferred<void>();
    const releaseBlocker = deferred<void>();
    const batchEntered = deferred<void>();
    const releaseBatch = deferred<void>();
    let serverClosed = false;

    const blocker = server.router.runResource(1n, async () => {
      blockerEntered.resolve();
      await releaseBlocker.promise;
    });
    await blockerEntered.promise;

    const acceptedBatch = server.router.runResources([1n, 2n], async () => {
      batchEntered.resolve();
      await releaseBatch.promise;
    });
    const close = server.close().then(() => {
      serverClosed = true;
    });

    const ready = await fetch(`${url}/ready`);
    expect(ready.status).toBe(503);
    const rejected = await socket.timeout(2000).emitWithAck("resource:read", { id: "3" });
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: "not_ready" },
    });

    releaseBlocker.resolve();
    await batchEntered.promise;
    await Promise.resolve();
    expect(serverClosed).toBe(false);
    expect(storage.closeCalls).toBe(0);

    releaseBatch.resolve();
    await Promise.all([blocker, acceptedBatch, close]);
    expect(serverClosed).toBe(true);
    expect(storage.closeCalls).toBe(1);
    server = undefined;
  });

  it("returns not_ready when shutdown begins during a readiness database check", async () => {
    const storage = new DelayedReadinessStorage();
    server = createUldaServer({
    protocol: "legacy",
      config: testConfig(),
      storage,
      ulda: new FakeUldaVerifier(),
      logger: createLogger("error"),
    });
    const address = await server.start();
    const blockerEntered = deferred<void>();
    const releaseBlocker = deferred<void>();
    const blocker = server.router.runResource(1n, async () => {
      blockerEntered.resolve();
      await releaseBlocker.promise;
    });
    await blockerEntered.promise;

    const readiness = fetch(`http://127.0.0.1:${address.port}/ready`);
    await storage.readinessPingEntered.promise;
    const close = server.close();
    storage.releaseReadinessPing.resolve();

    const response = await readiness;
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: "not_ready",
    });

    releaseBlocker.resolve();
    await Promise.all([blocker, close]);
    server = undefined;
  });

  it("serves config and broadcasts a committed update to the resource room", async () => {
    server = createUldaServer({
    protocol: "legacy",
      config: testConfig(),
      storage: new InMemoryResourceStorage(),
      ulda: new FakeUldaVerifier(),
      logger: createLogger("error"),
    });
    const address = await server.start();
    const url = `http://127.0.0.1:${address.port}`;
    const first = await connect(url);
    const second = await connect(url);
    sockets.push(first, second);

    const configAck = await first.timeout(2000).emitWithAck("server:config");
    expect(configAck).toMatchObject({
      ok: true,
      config: {
        protocolVersion: "1.0",
        features: {
          originCreation: false,
          witnessSigning: false,
          stepUp: false,
          directedVerify: true,
          firstWitnessInspection: false,
          firstWitnessPolicy: "application",
          profileEnforcedOnCreate: false,
          restCrud: false,
          socketIo: true,
          resourceRooms: false,
          routerSubscriptionRegistry: true,
          batchRead: true,
          batchSubscribe: true,
          contentProof: false,
          proofPipeline: true,
          proofEnforced: false,
          proofMode: "allow-all-placeholder",
          proofVersions: [],
        },
      },
    });

    const witness0 = Buffer.from([1, 10]).toString("base64url");
    const createAck = await first.timeout(2000).emitWithAck("resource:create", {
      witness: witness0,
      payload: Buffer.from([20]).toString("base64url"),
    });
    expect(createAck).toMatchObject({
      ok: true,
      resource: { witness: witness0 },
      subscribed: true,
    });
    expect(createAck.resource).not.toHaveProperty("createdAt");
    expect(createAck.resource).not.toHaveProperty("updatedAt");
    const id = (createAck as { resource: { id: string } }).resource.id;

    const subscribeAck = await second.timeout(2000).emitWithAck("resource:subscribe", { id });
    expect(subscribeAck).toMatchObject({ ok: true, resource: { id, witness: witness0 } });
    expect(server.router.subscriberIds(BigInt(id))).toEqual(
      expect.arrayContaining([connectedSocketId(first), connectedSocketId(second)]),
    );
    const secondServerSocket = server.io.sockets.sockets.get(connectedSocketId(second));
    expect(
      [...(secondServerSocket?.rooms ?? [])].filter((room) => room.startsWith("resource:")),
    ).toEqual([]);

    const updateEvent = new Promise<unknown>((resolve) => {
      second.once("resource:updated", resolve);
    });
    const initiatorUpdateEvent = new Promise<unknown>((resolve) => {
      first.once("resource:updated", resolve);
    });
    const witness1 = Buffer.from([2, 11]).toString("base64url");
    const updateAck = await first.timeout(2000).emitWithAck("resource:update", {
      id,
      baseWitness: witness0,
      candidateWitness: witness1,
      payload: Buffer.from([21]).toString("base64url"),
      proof: { version: "placeholder" },
    });

    expect(updateAck).toMatchObject({ ok: true, resource: { id, witness: witness1 } });
    await expect(updateEvent).resolves.toMatchObject({ id, witness: witness1 });
    await expect(initiatorUpdateEvent).resolves.toMatchObject({ id, witness: witness1 });

    const health = await fetch(`${url}/health`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ ok: true });

    const deleteEvent = new Promise<unknown>((resolve) => {
      second.once("resource:deleted", resolve);
    });
    const deleteWitness = Buffer.from([3, 12]).toString("base64url");
    const deleteAck = await first.timeout(2000).emitWithAck("resource:delete", {
      id,
      baseWitness: witness1,
      candidateWitness: deleteWitness,
      proof: null,
    });
    expect(deleteAck).toMatchObject({
      ok: true,
      deleted: { id, witness: deleteWitness },
      idempotent: false,
    });
    expect(deleteAck.deleted).not.toHaveProperty("deletedAt");
    await expect(deleteEvent).resolves.toEqual({ id, witness: deleteWitness });
    expect(server.router.subscriberIds(BigInt(id))).toEqual([]);

    const readAfterDelete = await first.timeout(2000).emitWithAck(
      "resource:read",
      { id },
    );
    expect(readAfterDelete).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });

  it("accepts only one of two simultaneous same-base updates", async () => {
    const storage = new CountingStorage();
    const proof = new DeferredProofVerifier();
    const ulda = new FakeUldaVerifier();
    server = createUldaServer({
    protocol: "legacy",
      config: testConfig(),
      storage,
      proof,
      ulda,
      logger: createLogger("error"),
    });
    const address = await server.start();
    const url = `http://127.0.0.1:${address.port}`;
    const first = await connect(url);
    const second = await connect(url);
    const observer = await connect(url);
    sockets.push(first, second, observer);

    const witness0 = Buffer.from([1, 10]).toString("base64url");
    const createAck = await first.timeout(2000).emitWithAck("resource:create", {
      witness: witness0,
      payload: Buffer.from([20]).toString("base64url"),
    }) as { ok: true; resource: { id: string; witness: string } };
    const { id } = createAck.resource;
    await second.timeout(2000).emitWithAck("resource:subscribe", { id });
    await observer.timeout(2000).emitWithAck("resource:subscribe", { id });

    const events: unknown[] = [];
    const firstClientEvents: unknown[] = [];
    const secondClientEvents: unknown[] = [];
    first.on("resource:updated", (event) => firstClientEvents.push(event));
    second.on("resource:updated", (event) => secondClientEvents.push(event));
    const firstEvent = new Promise<void>((resolve) => {
      observer.on("resource:updated", (event) => {
        events.push(event);
        resolve();
      });
    });
    const common = {
      id,
      baseWitness: createAck.resource.witness,
      proof: { version: "placeholder" },
    };
    const firstCandidate = Buffer.from([2, 11]).toString("base64url");
    const secondCandidate = Buffer.from([2, 12]).toString("base64url");
    const firstAckPromise = first.timeout(2000).emitWithAck("resource:update", {
      ...common,
      candidateWitness: firstCandidate,
      payload: Buffer.from([21]).toString("base64url"),
    });
    const secondAckPromise = second.timeout(2000).emitWithAck("resource:update", {
      ...common,
      candidateWitness: secondCandidate,
      payload: Buffer.from([22]).toString("base64url"),
    });

    await proof.entered.promise;
    await Promise.resolve();
    expect(proof.calls).toHaveLength(1);
    expect(ulda.verifyCalls).toHaveLength(1);
    expect(storage.updateCalls).toBe(0);

    proof.release.resolve(true);
    const acknowledgements = await Promise.all([firstAckPromise, secondAckPromise]) as Array<{
      ok: boolean;
      resource?: { witness: string };
      error?: { code: string };
      current?: { witness: string };
    }>;
    await firstEvent;
    await new Promise<void>((resolve) => setImmediate(resolve));

    const winner = acknowledgements.find((ack) => ack.ok);
    const loser = acknowledgements.find((ack) => !ack.ok);
    expect(winner?.resource?.witness).toEqual(
      expect.toBeOneOf([firstCandidate, secondCandidate]),
    );
    expect(loser).toMatchObject({
      error: { code: "stale_state" },
      current: { witness: winner?.resource?.witness },
    });
    expect(proof.calls).toHaveLength(1);
    expect(ulda.verifyCalls).toHaveLength(1);
    expect(storage.updateCalls).toBe(1);
    expect(events).toHaveLength(1);
    expect(firstClientEvents).toHaveLength(1);
    expect(secondClientEvents).toHaveLength(1);
  });

  it("registers a reconnect list in the Router without resource rooms", async () => {
    const storage = new CountingStorage();
    server = createUldaServer({
    protocol: "legacy",
      config: testConfig(),
      storage,
      ulda: new FakeUldaVerifier(),
      logger: createLogger("error"),
    });
    const address = await server.start();
    const url = `http://127.0.0.1:${address.port}`;
    const owner = await connect(url);
    const reconnecting = await connect(url);
    sockets.push(owner, reconnecting);

    const firstCreate = await owner.timeout(2000).emitWithAck("resource:create", {
      witness: Buffer.from([1, 10]).toString("base64url"),
      payload: Buffer.from([20]).toString("base64url"),
    }) as { resource: { id: string; witness: string } };
    const secondCreate = await owner.timeout(2000).emitWithAck("resource:create", {
      witness: Buffer.from([1, 11]).toString("base64url"),
      payload: Buffer.from([21]).toString("base64url"),
    }) as { resource: { id: string } };

    const batchAck = await reconnecting.timeout(2000).emitWithAck(
      "resource:subscribe-many",
      {
        resources: [
          { id: firstCreate.resource.id },
          { id: secondCreate.resource.id },
          { id: firstCreate.resource.id },
          { id: "999" },
        ],
      },
    ) as {
      ok: boolean;
      results: Array<{ ok: boolean; id: string; error?: { code: string } }>;
      subscriptions: string[];
    };

    expect(batchAck.ok).toBe(true);
    expect(batchAck.results).toHaveLength(3);
    expect(batchAck.results.filter((result) => result.ok)).toHaveLength(2);
    expect(batchAck.results.find((result) => result.id === "999")).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(storage.findManyCalls).toBe(1);
    expect(batchAck.subscriptions).toEqual([
      firstCreate.resource.id,
      secondCreate.resource.id,
    ]);
    const reconnectingId = connectedSocketId(reconnecting);
    expect(server.router.subscriberIds(BigInt(firstCreate.resource.id))).toContain(
      reconnectingId,
    );
    const reconnectingServerSocket = server.io.sockets.sockets.get(reconnectingId);
    if (reconnectingServerSocket === undefined) {
      throw new Error("Server-side reconnecting socket was not found.");
    }
    expect(
      [...(reconnectingServerSocket?.rooms ?? [])].filter((room) =>
        room.startsWith("resource:")
      ),
    ).toEqual([]);

    const updateEvent = new Promise<unknown>((resolve) => {
      reconnecting.once("resource:updated", resolve);
    });
    const updatedWitness = Buffer.from([2, 12]).toString("base64url");
    const updateAck = await owner.timeout(2000).emitWithAck("resource:update", {
      id: firstCreate.resource.id,
      baseWitness: firstCreate.resource.witness,
      candidateWitness: updatedWitness,
      payload: Buffer.from([22]).toString("base64url"),
      proof: { version: "placeholder" },
    });
    expect(updateAck).toMatchObject({ ok: true, resource: { witness: updatedWitness } });
    await expect(updateEvent).resolves.toMatchObject({
      id: firstCreate.resource.id,
      witness: updatedWitness,
    });

    const disconnected = new Promise<void>((resolve) => {
      reconnectingServerSocket.once("disconnect", () => resolve());
    });
    reconnecting.close();
    await disconnected;
    expect(server.router.subscriberIds(BigInt(firstCreate.resource.id))).not.toContain(
      reconnectingId,
    );
    expect(server.router.subscriptions(reconnectingId)).toEqual([]);
  });

  it("reads many resources with one storage batch call and reports missing ids", async () => {
    const storage = new CountingStorage();
    server = createUldaServer({
    protocol: "legacy",
      config: testConfig(),
      storage,
      ulda: new FakeUldaVerifier(),
      logger: createLogger("error"),
    });
    const address = await server.start();
    const url = "http://127.0.0.1:" + address.port;
    const socket = await connect(url);
    sockets.push(socket);

    const first = await socket.timeout(2000).emitWithAck("resource:create", {
      witness: Buffer.from([1, 31]).toString("base64url"),
      payload: Buffer.from([41]).toString("base64url"),
    }) as { resource: { id: string } };
    const second = await socket.timeout(2000).emitWithAck("resource:create", {
      witness: Buffer.from([1, 32]).toString("base64url"),
      payload: Buffer.from([42]).toString("base64url"),
    }) as { resource: { id: string } };

    const ack = await socket.timeout(2000).emitWithAck("resource:read-many", {
      ids: [second.resource.id, "999", first.resource.id, second.resource.id],
    }) as {
      ok: boolean;
      resources: Array<{ id: string }>;
      missingIds: string[];
    };

    expect(ack.ok).toBe(true);
    expect(ack.resources.map((resource) => resource.id)).toEqual([
      second.resource.id,
      first.resource.id,
    ]);
    expect(ack.missingIds).toEqual(["999"]);
    expect(storage.findManyCalls).toBe(1);
  });
});
