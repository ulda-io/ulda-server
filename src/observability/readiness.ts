export interface ReadinessOptions {
  timeoutMs: number;
  cacheMs: number;
  maxWaiters: number;
}

interface Flight {
  result: Promise<boolean>;
  settle: (ready: boolean) => void;
}

/** One storage operation, bounded HTTP waiters, and a short-lived result cache. */
export class ReadinessProbe {
  #active: Flight | undefined;
  #cached: { ready: boolean; until: number } | undefined;
  #waiters = 0;
  #stopped = false;

  constructor(private readonly ping: () => Promise<void>, private readonly options: ReadinessOptions) {}

  async check(): Promise<boolean> {
    if (this.#stopped) return false;
    if (this.#cached && performance.now() < this.#cached.until) return this.#cached.ready;
    if (this.#waiters >= this.options.maxWaiters) return false;
    const flight = this.#active ?? this.#start();
    this.#waiters++;
    try { return await flight.result; }
    finally { this.#waiters--; }
  }

  stop(): void {
    this.#stopped = true;
    this.#cached = undefined;
    this.#active?.settle(false);
  }

  #start(): Flight {
    let resolve!: (ready: boolean) => void;
    const result = new Promise<boolean>(done => { resolve = done; });
    let answered = false;
    const flight: Flight = { result, settle: ready => {
      if (answered) return;
      answered = true;
      clearTimeout(timer);
      const accepted = ready && !this.#stopped;
      this.#cached = { ready: accepted, until: performance.now() + this.options.cacheMs };
      resolve(accepted);
    } };
    const timer = setTimeout(() => flight.settle(false), this.options.timeoutMs);
    timer.unref();
    this.#active = flight;
    const completed = (ready: boolean) => {
      flight.settle(ready);
      // Deadline/stop only completes callers. Keep the storage slot until the
      // actual ping settles, so a stuck driver cannot spawn unlimited queries.
      if (this.#active === flight) this.#active = undefined;
    };
    try { void this.ping().then(() => completed(true), () => completed(false)); }
    catch { completed(false); }
    return flight;
  }
}
