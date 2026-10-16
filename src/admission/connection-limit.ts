import type { IncomingMessage } from "node:http";
import type { Socket } from "socket.io";

/** Pending handshakes consume a slot before Engine.IO's asynchronous generateId. */
export class ConnectionLimit {
  #count = 0;
  #stopping = false;
  readonly #pending = new Map<IncomingMessage, { adopt(): void; release(): void }>();
  readonly #active = new WeakSet<Socket["conn"]>();
  constructor(readonly maximum: number, readonly handshakeTimeoutMs = 10_000) {}
  get count(): number { return this.#count; }
  allow(request: IncomingMessage, callback: (error: string | null, allowed: boolean) => void): void {
    if (this.#stopping || this.#count >= this.maximum) {
      callback(this.#stopping ? "not_ready" : "overloaded", false); return;
    }
    this.#count++;
    let released = false;
    const detach = () => {
      clearTimeout(timer); request.socket.off("close", release); request.off("aborted", release);
      this.#pending.delete(request);
    };
    const release = () => { if (!released) { released = true; detach(); this.#count--; } };
    const timer = setTimeout(() => { release(); request.socket.destroy(); }, this.handshakeTimeoutMs);
    timer.unref();
    request.socket.once("close", release); request.once("aborted", release);
    this.#pending.set(request, { adopt: detach, release });
    callback(null, true);
  }
  connected(connection: Socket["conn"]): void {
    const lease = this.#pending.get(connection.request);
    if (!lease || this.#stopping) { lease?.release(); connection.close(true); return; }
    lease.adopt(); this.#active.add(connection);
    connection.once("close", () => { this.#active.delete(connection); lease.release(); });
  }
  failed(request: IncomingMessage): void { this.#pending.get(request)?.release(); }
  accepted(connection: Socket["conn"]): boolean { return this.#active.has(connection); }
  stop(): void {
    this.#stopping = true;
    for (const [request, lease] of [...this.#pending]) { lease.release(); request.socket.destroy(); }
  }
}
