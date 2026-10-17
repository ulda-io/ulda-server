import type { AppConfig } from "../config/config.js";
import { ByteBudget } from "./byte-budget.js";
import { ConnectionLimit } from "./connection-limit.js";

export class IngressLease {
  #bytes = 0;
  #released = false;
  #claimed = false;
  constructor(readonly owner: IngressOwner) {}
  grow(bytes: number): boolean {
    if (this.#released || !this.owner.admission.input.acquire(bytes)) return false;
    this.#bytes += bytes; return true;
  }
  claim(): boolean {
    if (this.#released || this.#claimed) return false;
    this.#claimed = true; this.owner.unclaimed.delete(this); return true;
  }
  release(): void {
    if (this.#released) return;
    this.#released = true; this.owner.unclaimed.delete(this);
    this.owner.admission.input.release(this.#bytes); this.#bytes = 0;
    this.owner.pending--; this.owner.admission.pending--;
  }
}

/** One owner per physical Socket.IO decoder, including its next-tick dispatch queue. */
export class IngressOwner {
  readonly unclaimed = new Set<IngressLease>();
  pending = 0;
  #tokens: number;
  #last = performance.now();
  constructor(readonly admission: ServerAdmission) { this.#tokens = admission.limits.commandBurst; }
  begin(): IngressLease {
    const now = performance.now(), limits = this.admission.limits;
    this.#tokens = Math.min(limits.commandBurst, this.#tokens + (now - this.#last) * limits.maxCommandsPerSecond / 1000);
    this.#last = now;
    if (this.pending >= limits.maxPendingCommandsPerSocket || this.#tokens < 1) {
      throw new Error("Ingress capacity exceeded.");
    }
    this.#tokens--;
    const lease = new IngressLease(this);
    if (!lease.grow(1024)) throw new Error("Ingress capacity exceeded.");
    this.pending++; this.admission.pending++; this.unclaimed.add(lease);
    return lease;
  }
  destroy(): void { for (const lease of this.unclaimed) lease.release(); }
}

export class ServerAdmission {
  readonly input: ByteBudget;
  readonly reads: ByteBudget;
  readonly output: ByteBudget;
  readonly staging: ByteBudget;
  readonly outputPackets = new ByteBudget(65_536);
  readonly connections: ConnectionLimit;
  readonly packets = new WeakMap<object, IngressLease>();
  readonly bodies = new WeakMap<object, IngressLease>();
  // CONNECT auth object is passed unchanged to socket.handshake.auth by Socket.IO.
  // This binds a decoder timeout to its transport without reading Client private fields.
  readonly handshakes = new WeakMap<object, { bindAbort(abort: () => void): void }>();
  pending = 0;
  constructor(readonly limits: AppConfig["limits"]) {
    this.input = new ByteBudget(limits.maxInflightBytes);
    this.reads = new ByteBudget(limits.maxActiveReadBytes);
    this.output = new ByteBudget(limits.maxBufferedTotalBytes);
    this.staging = new ByteBudget(limits.maxStagedBytes);
    this.connections = new ConnectionLimit(limits.maxConnections);
  }
  claim(body: object): IngressLease | undefined {
    const lease = this.bodies.get(body); this.bodies.delete(body);
    return lease?.claim() ? lease : undefined;
  }
  snapshot() {
    return { connections: this.connections.count, pending: this.pending,
      inputBytes: this.input.used, inputPeakBytes: this.input.peak,
      readBytes: this.reads.used, readPeakBytes: this.reads.peak,
      outputBytes: this.output.used, outputPeakBytes: this.output.peak,
      outputPackets: this.outputPackets.used, stagedBytes: this.staging.used, stagedPeakBytes: this.staging.peak };
  }
}
