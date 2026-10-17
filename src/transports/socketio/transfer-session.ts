import { randomBytes } from 'node:crypto';
import type { Socket } from 'socket.io';
import type { AppConfig } from '../../config/config.js';
import type { ServerAdmission } from '../../admission/server-admission.js';
import type { RequestRouter } from '../../router/request-router.js';
import type { SdkResourceService } from '../../domain/sdk-resource-service.js';
import type { ActiveResource } from '../../domain/resource.js';
import type { StoredChange, CreateStoredResource } from '../../domain/ports.js';
import { DomainError, invalidRequest } from '../../domain/errors.js';
import { SDK_LIMITS, SdkLimitError, sdkId, parseSdkChanges, parseSdkCreate } from '../../protocol/sdk-commands.js';

const CHUNK = 1_048_576;
type Item = CreateStoredResource | StoredChange;
function object(value: unknown, keys: string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) throw invalidRequest('Invalid transfer frame.');
  return value as Record<string, any>;
}
function bytes(value: unknown, max: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length < 1 || value.length > max) throw invalidRequest('Invalid transfer bytes.');
  return value;
}
function integer(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new SdkLimitError();
  return value as number;
}
function equal(a: Uint8Array, b: Uint8Array) { return a.length === b.length && a.every((x, i) => x === b[i]); }

class StagedWrite {
  readonly token = randomBytes(16).toString('hex');
  readonly items: Item[] = [];
  readonly ids = new Set<bigint>();
  partial: { id?: bigint; witness: Uint8Array; payload: Uint8Array; offset: number } | undefined;
  logicalBytes: number;
  charged = 0;
  timer?: NodeJS.Timeout;
  constructor(readonly action: string, readonly count: number, readonly admission: ServerAdmission, readonly limits: AppConfig['limits']) {
    this.logicalBytes = count * 256;
    if (this.logicalBytes > limits.maxTransferBytes || !admission.staging.acquire(this.logicalBytes)) throw new SdkLimitError();
    this.charged = this.logicalBytes;
  }
  charge(value: number) {
    if (this.logicalBytes + value > this.limits.maxTransferBytes || !this.admission.staging.acquire(value * 3)) throw new SdkLimitError();
    this.logicalBytes += value; this.charged += value * 3;
  }
  add(item: Item) {
    if (this.items.length >= this.count) throw invalidRequest('Too many items.');
    if ('id' in item) {
      if (this.ids.has(item.id)) throw invalidRequest('Duplicate ID.');
      this.ids.add(item.id);
    }
    this.items.push(item);
  }
  append(frame: unknown) {
    const data = object(frame, ['kind', 'token', 'items']);
    if (this.partial || !Array.isArray(data.items) || data.items.length + this.items.length > this.count) throw invalidRequest('Invalid append order.');
    const reserve = (copyBytes: number) => this.charge(copyBytes / 3);
    const items = this.action === 'create' ? parseSdkCreate(data.items, this.limits.maxWitnessBytes, reserve)
      : parseSdkChanges(data.items, this.action === 'delete' && data.items.some((x: any) => x && !Object.hasOwn(x, 'payload')), this.limits.maxWitnessBytes, reserve);
    for (const item of items) this.add(item);
  }
  part(frame: unknown) {
    const data = object(frame, ['kind', 'token', ...(this.action === 'create' ? [] : ['resourceId']), 'witness', 'payload', 'total', 'offset']);
    const id = this.action === 'create' ? undefined : sdkId(data.resourceId);
    const witness = bytes(data.witness, Math.min(this.limits.maxWitnessBytes, SDK_LIMITS.witnessBytes));
    const payload = bytes(data.payload, CHUNK);
    const total = integer(data.total, 1, this.limits.maxResourceBytes), offset = integer(data.offset, 0, total);
    if (offset + payload.length > total || this.items.length >= this.count) throw invalidRequest('Invalid fragment bounds.');
    if (!this.partial) {
      if (offset !== 0 || (id !== undefined && this.ids.has(id))) throw invalidRequest('Invalid fragment start.');
      this.charge(total + witness.length);
      this.partial = { ...(id === undefined ? {} : { id }), witness: witness.slice(), payload: new Uint8Array(total), offset: 0 };
    }
    const current = this.partial;
    if (current.id !== id || current.offset !== offset || current.payload.length !== total || !equal(current.witness, witness)) throw invalidRequest('Inconsistent fragment.');
    current.payload.set(payload, offset); current.offset += payload.length;
    if (current.offset === total) {
      this.add({ ...(id === undefined ? {} : { id }), witness: current.witness, payload: current.payload });
      this.partial = undefined;
    }
  }
  finish() {
    if (this.partial || this.items.length !== this.count || (this.action === 'delete' && !this.items.some(x => x.payload === undefined))) throw invalidRequest('Incomplete transfer.');
    clearTimeout(this.timer);
  }
  release() {
    clearTimeout(this.timer); this.items.length = 0; this.partial = undefined; this.ids.clear();
    this.admission.staging.release(this.charged); this.charged = 0;
  }
}

export class TransferSession {
  #stage: StagedWrite | undefined;
  #committing = false;
  #reading = false;
  #read: { resource: ActiveResource; offset: number; release(): void; timer: NodeJS.Timeout } | undefined;
  constructor(readonly socket: Socket, readonly service: SdkResourceService, readonly router: RequestRouter,
    readonly admission: ServerAdmission, readonly config: AppConfig,
    readonly reserveSubscriptions: (ids: readonly bigint[] | number) => () => void,
    readonly subscribe: (ids: readonly bigint[]) => void,
    readonly publish: (changes: readonly StoredChange[]) => void,
    readonly active: () => boolean, readonly signal: AbortSignal) {}

  close() { this.#stage?.release(); this.#stage = undefined; this.#clearRead(); }
  #clearRead() {
    if (this.#read) { clearTimeout(this.#read.timer); this.#read.release(); this.#read = undefined; }
  }
  async #validate(changes: readonly StoredChange[]): Promise<void> {
    const charge = changes.length * (SDK_LIMITS.payloadBytes + SDK_LIMITS.witnessBytes);
    const releaseRead = await this.admission.reads.reserve(charge, this.signal);
    let retry = false;
    try { await this.service.validate(changes); }
    catch (error) {
      if (error instanceof SdkLimitError || (error instanceof DomainError && error.code === 'rate_limited')) retry = true;
      else throw error;
    } finally { releaseRead(); }
    if (!retry) return;
    if (changes.length > 1) {
      const middle = Math.ceil(changes.length / 2);
      await this.#validate(changes.slice(0, middle)); await this.#validate(changes.slice(middle));
    } else {
      const largeCharge = (this.config.limits.maxResourceBytes + SDK_LIMITS.witnessBytes) * 3;
      const releaseLarge = await this.admission.reads.reserve(largeCharge, this.signal);
      try { await this.service.validate(changes, this.config.limits.maxResourceBytes); }
      finally { releaseLarge(); }
    }
  }
  async handle(raw: unknown, reply: (value: unknown) => void, mutationStarted: () => void): Promise<void> {
    const value = raw as Record<string, any>;
    if (value?.kind === 'read') { await this.#readPart(raw, reply); return; }
    if (value?.kind === 'begin') {
      const data = object(raw, ['kind', 'action', 'count']);
      if (this.#stage || this.#committing || !['create', 'update', 'delete'].includes(data.action)) throw invalidRequest('Transfer already active or invalid action.');
      const count = integer(data.count, 1, data.action === 'create' ? SDK_LIMITS.batch : this.config.limits.maxQueuedTotal);
      const stage = new StagedWrite(data.action, count, this.admission, this.config.limits);
      this.#stage = stage;
      stage.timer = setTimeout(() => { if (this.#stage === stage) { this.#stage = undefined; stage.release(); } }, this.config.limits.transferTimeoutMs);
      stage.timer.unref();
      reply({ ok: true, token: stage.token }); return;
    }
    const stage = this.#stage;
    if (!stage || value?.token !== stage.token) throw invalidRequest('Unknown transfer.');
    try {
      if (value.kind === 'append') { stage.append(raw); reply({ ok: true }); return; }
      if (value.kind === 'part') { stage.part(raw); reply({ ok: true }); return; }
      object(raw, ['kind', 'token']);
      if (value.kind === 'cancel') { this.#stage = undefined; stage.release(); reply({ ok: true }); return; }
      if (value.kind !== 'commit') throw invalidRequest('Unknown transfer action.');
      stage.finish(); this.#stage = undefined; this.#committing = true;
      try {
        if (stage.action === 'create') {
          await this.router.runCreate(async () => {
            const release = this.reserveSubscriptions(stage.items.length);
            try {
              mutationStarted();
              const resources = await this.service.create(stage.items as CreateStoredResource[]);
              this.subscribe(resources.map(x => x.id));
              reply({ ok: true, data: resources.map(x => String(x.id)) });
            } finally { release(); }
          });
        } else {
          const changes = stage.items as StoredChange[];
          await this.router.runResources(changes.map(x => x.id), async () => {
            const ids = changes.filter(x => x.payload !== undefined).map(x => x.id);
            const release = this.reserveSubscriptions(ids);
            try {
              for (let i = 0; i < changes.length; i += SDK_LIMITS.batch) await this.#validate(changes.slice(i, i + SDK_LIMITS.batch));
              mutationStarted();
              await this.service.storage.applyBatch(changes);
              this.subscribe(ids); this.publish(changes); reply({ ok: true });
            } finally { release(); }
          });
        }
      } finally { this.#committing = false; stage.release(); }
    } catch (error) {
      if (this.#stage === stage) { this.#stage = undefined; stage.release(); }
      throw error;
    }
  }
  async #readPart(raw: unknown, reply: (value: unknown) => void) {
    const data = object(raw, ['kind', 'resourceId', 'offset']);
    const id = sdkId(data.resourceId), offset = integer(data.offset, 0, this.config.limits.maxResourceBytes);
    if (this.#reading) throw invalidRequest('Read transfer active.');
    this.#reading = true;
    try {
      if (offset === 0) {
        this.#clearRead();
        await this.router.runResources([id], async () => {
          const charge = (this.config.limits.maxResourceBytes + SDK_LIMITS.witnessBytes) * 3;
          const releaseRead = await this.admission.reads.reserve(charge, this.signal);
          let retained = false, release = () => {};
          try {
            if (!this.active()) throw invalidRequest('Disconnected read.');
            release = this.reserveSubscriptions([id]);
            const [resource] = await this.service.read([id], this.config.limits.maxResourceBytes);
            if (!resource || !this.active()) throw invalidRequest('Disconnected read.');
            const timer = setTimeout(() => this.#clearRead(), this.config.limits.transferTimeoutMs); timer.unref();
            this.#read = { resource, offset: 0, release: releaseRead, timer }; retained = true; this.subscribe([id]);
          } finally { release(); if (!retained) releaseRead(); }
        });
      }
      const cached = this.#read;
      if (!cached || cached.resource.id !== id || cached.offset !== offset) throw invalidRequest('Invalid read fragment order.');
      const { resource } = cached;
      const payload = Buffer.from(resource.payload.subarray(offset, offset + CHUNK));
      cached.offset += payload.length;
      const response = { ok: true, data: { id: String(id), witness: Buffer.from(resource.witness), payload, total: resource.payload.length, offset } };
      if (cached.offset === resource.payload.length) this.#clearRead();
      reply(response);
    } catch (error) { this.#clearRead(); throw error; }
    finally { this.#reading = false; }
  }
}
