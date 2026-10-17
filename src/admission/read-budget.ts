import { DomainError } from '../domain/errors.js';
import { SdkLimitError } from '../protocol/sdk-commands.js';
import { ByteBudget } from './byte-budget.js';

type Waiter = { bytes: number; grant(): void; cancel(): void };

/** FIFO admission before storage reads. Waiters retain only their bounded input
 * command, never an unaccounted query result. All callers acquire Router keys
 * first; a granted lease must never wait for another Router key or read lease. */
export class ReadBudget extends ByteBudget {
  readonly #waiting = new Set<Waiter>();
  #stopped = false;
  constructor(limit: number, readonly maxWaiting: number, readonly waitMs = 5000) {
    super(limit);
    if (!Number.isSafeInteger(maxWaiting) || maxWaiting < 1 || !Number.isSafeInteger(waitMs) || waitMs < 1)
      throw new Error('Invalid read queue limits.');
  }
  get waiting(): number { return this.#waiting.size; }
  override acquire(bytes: number): boolean {
    return !this.#stopped && this.#waiting.size === 0 && super.acquire(bytes);
  }
  override release(bytes: number): void { super.release(bytes); this.#drain(); }
  #lease(bytes: number): () => void {
    let released = false;
    return () => { if (!released) { released = true; this.release(bytes); } };
  }
  async reserve(bytes: number, signal: AbortSignal): Promise<() => void> {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid charge.');
    // A request that can never fit is different from temporary contention.
    if (bytes > this.limit) throw new SdkLimitError();
    if (this.#stopped || signal.aborted) throw new DomainError('not_ready', 'Read admission unavailable.');
    if (this.acquire(bytes)) return this.#lease(bytes);
    if (this.#waiting.size >= this.maxWaiting) throw new DomainError('not_ready', 'Read queue full.');
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', waiter.cancel); this.#waiting.delete(waiter); };
      const waiter: Waiter = {
        bytes,
        grant: () => { cleanup(); resolve(this.#lease(bytes)); },
        cancel: () => { cleanup(); reject(new DomainError('not_ready', 'Read admission unavailable.')); this.#drain(); },
      };
      const timer = setTimeout(waiter.cancel, this.waitMs); timer.unref();
      this.#waiting.add(waiter);
      signal.addEventListener('abort', waiter.cancel, { once: true });
    });
  }
  #drain(): void {
    if (this.#stopped) return;
    for (const waiter of this.#waiting) {
      // Do not let small newcomers starve an older large read.
      if (!super.acquire(waiter.bytes)) break;
      waiter.grant();
    }
  }
  stop(): void {
    this.#stopped = true;
    for (const waiter of this.#waiting) waiter.cancel();
  }
}
