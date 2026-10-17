// Bounded histograms: one-millisecond buckets, including an explicit overflow.
const safeCodes = new Set(['INVALID_INPUT', 'INVALID_PACKET', 'UNSUPPORTED_PROFILE',
  'CRYPTO_FAILED', 'CLOSED', 'OFFLINE', 'NOT_OPEN', 'UNKNOWN_OUTCOME', 'CONFLICT',
  'NOT_FOUND', 'EXISTS', 'NEEDS_RESYNC', 'ROLLBACK', 'LIMIT', 'UNSUPPORTED',
  'SERVER_ERROR', 'STALE_REFERENCE', 'BUSY', 'TIMEOUT', 'ERR_ASSERTION']);
export function loadFailureCode(error) {
  // No messages, stacks, arbitrary code strings or error serialization.
  try {
    const code = error?.code;
    return typeof code === 'string' && safeCodes.has(code) ? code : 'CHECK_FAILED';
  }
  catch { return 'CHECK_FAILED'; }
}

export function loadWorkerStatus(child, worker) {
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const status = { worker, ready: child.ready === true, warmed: child.warmed === true,
    failed: child.failed === true, exited: child.exited === true, reportReceived: !!child.report,
    exitCode: count(child.exitCode) };
  if (child.failure) {
    const failure = child.failure;
    status.failure = {
      phase: ['clients', 'warmup', 'measurement', 'verification', 'report', 'async', 'update'].includes(failure.phase) ? failure.phase : 'unknown',
      code: loadFailureCode(failure), attempted: count(failure.attempted), confirmed: count(failure.confirmed),
      failed: count(failure.failed), asyncErrors: count(failure.asyncErrors),
    };
  }
  return status;
}

export class Histogram {
  bins = new Uint32Array(60_001);
  count = 0;
  sum = 0;
  max = 0;
  overflow = 0;
  add(ms) {
    if (!Number.isFinite(ms) || ms < 0) throw new Error("Invalid latency sample");
    this.bins[Math.min(60_000, Math.ceil(ms))]++;
    if (ms > 60_000) this.overflow++;
    this.count++; this.sum += ms; this.max = Math.max(this.max, ms);
  }
  merge(other) {
    if (other.bins.length !== this.bins.length) throw new Error("Histogram size mismatch");
    for (let i = 0; i < this.bins.length; i++) this.bins[i] += other.bins[i];
    this.count += other.count; this.sum += other.sum;
    this.max = Math.max(this.max, other.max); this.overflow += other.overflow;
  }
  export() { return { bins: Array.from(this.bins), count: this.count, sum: this.sum, max: this.max, overflow: this.overflow }; }
  summary() {
    const percentile = p => {
      if (!this.count) return null;
      let n = 0;
      for (let i = 0; i < this.bins.length; i++) {
        n += this.bins[i]; if (n >= Math.ceil(this.count * p)) return i;
      }
      return null;
    };
    return { count: this.count, meanMs: this.count ? this.sum / this.count : null,
      p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99), maxMs: this.max, overflow: this.overflow };
  }
}

export function loadOptions(env) {
  const number = (name, fallback, min, max) => {
    const n = Number(env[name] ?? fallback);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error("Invalid load option: " + name);
    return n;
  };
  const profile = env.ULDA_LOAD_PROFILE ?? "host";
  if (!["host", "compose"].includes(profile)) throw new Error("Invalid load profile");
  const clients = number("ULDA_LOAD_CLIENTS", 100, 1, 100);
  return { clients, workers: number("ULDA_LOAD_WORKERS", 4, 1, Math.min(12, clients)),
    seconds: number("ULDA_LOAD_SECONDS", 1800, 5, 3600), warmup: number("ULDA_LOAD_WARMUP", 10, 0, 60), profile };
}
