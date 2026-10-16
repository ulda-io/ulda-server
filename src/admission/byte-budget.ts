/** Logical retained-byte budget, not a measurement of V8/OS resident memory. */
export class ByteBudget {
  #used = 0;
  #peak = 0;
  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid budget.");
  }
  get used(): number { return this.#used; }
  get peak(): number { return this.#peak; }
  acquire(bytes: number): boolean {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid charge.");
    if (bytes > this.limit - this.#used) return false;
    this.#used += bytes; this.#peak = Math.max(this.#peak, this.#used);
    return true;
  }
  release(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.#used) throw new Error("Invalid release.");
    this.#used -= bytes;
  }
}
