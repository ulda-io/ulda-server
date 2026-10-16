import { afterEach, describe, expect, it, vi } from "vitest";
import { ReadinessProbe } from "../../src/observability/readiness.js";

function gate() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const options = { timeoutMs: 200, cacheMs: 100, maxWaiters: 2 };
afterEach(() => vi.useRealTimers());

describe("bounded readiness", () => {
  it("shares one probe, caps waiters, and caches success without another DB call", async () => {
    vi.useFakeTimers();
    const g = gate(), ping = vi.fn(() => g.promise), probe = new ReadinessProbe(ping, options);
    const a = probe.check(), b = probe.check();
    await expect(probe.check()).resolves.toBe(false);
    expect(ping).toHaveBeenCalledOnce();
    g.resolve();
    expect(await Promise.all([a, b])).toEqual([true, true]);
    for (let i = 0; i < 50; i++) expect(await probe.check()).toBe(true);
    expect(ping).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(101);
    expect(await probe.check()).toBe(true);
    expect(ping).toHaveBeenCalledTimes(2);
  });

  it("times out callers but never starts another ping while the old operation is pending", async () => {
    vi.useFakeTimers();
    const g = gate(), ping = vi.fn(() => g.promise), probe = new ReadinessProbe(ping, options);
    const waiting = probe.check();
    await vi.advanceTimersByTimeAsync(200);
    expect(await waiting).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    for (let i = 0; i < 50; i++) expect(await probe.check()).toBe(false);
    expect(ping).toHaveBeenCalledOnce();
    // A late success cannot become a fresh ready result after its deadline.
    g.resolve(); await Promise.resolve();
    ping.mockResolvedValue(undefined);
    expect(await probe.check()).toBe(true);
    expect(ping).toHaveBeenCalledTimes(2);
  });

  it("caches failures, handles synchronous throws and recovers with a fresh successful probe", async () => {
    vi.useFakeTimers();
    const ping = vi.fn<() => Promise<void>>(() => { throw new Error("synthetic-private-readiness"); });
    const probe = new ReadinessProbe(ping, options);
    expect(await probe.check()).toBe(false);
    expect(await probe.check()).toBe(false);
    expect(ping).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(101);
    ping.mockRejectedValue(new Error("synthetic-private-readiness"));
    expect(await probe.check()).toBe(false);
    await vi.advanceTimersByTimeAsync(101);
    ping.mockResolvedValue(undefined);
    expect(await probe.check()).toBe(true);
  });

  it("stop releases waiting HTTP checks immediately and ignores late failure", async () => {
    vi.useFakeTimers();
    const g = gate(), ping = vi.fn(() => g.promise), probe = new ReadinessProbe(ping, options);
    const a = probe.check();
    probe.stop(); probe.stop();
    expect(await a).toBe(false);
    g.reject(new Error("synthetic-private-readiness"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(await probe.check()).toBe(false);
    expect(ping).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
