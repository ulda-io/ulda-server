import { afterEach, expect, it, vi } from 'vitest';
import { ReadBudget } from '../../src/admission/read-budget.js';
import { sdkError } from '../../src/protocol/sdk-commands.js';

const signal = () => new AbortController().signal;
afterEach(() => vi.useRealTimers());

it('serves bounded FIFO waiters without exceeding the budget or starving large reads', async () => {
  const budget = new ReadBudget(100, 2), order: string[] = [];
  const release = await budget.reserve(60, signal());
  const first = budget.reserve(80, signal()).then(r => { order.push('large'); return r; });
  const second = budget.reserve(20, signal()).then(r => { order.push('small'); return r; });
  expect(budget.acquire(1)).toBe(false);
  await expect(budget.reserve(1, signal())).rejects.toMatchObject({ code: 'not_ready' });
  expect(budget.used).toBe(60); expect(budget.waiting).toBe(2);
  release(); release();
  const [a, b] = await Promise.all([first, second]);
  expect(order).toEqual(['large', 'small']); expect(budget.used).toBe(100); expect(budget.peak).toBe(100);
  a(); b(); expect(budget.used).toBe(0); expect(budget.waiting).toBe(0);
});

it('cancels a head waiter immediately and admits the next fitting request', async () => {
  const budget = new ReadBudget(100, 2), controller = new AbortController();
  const release = await budget.reserve(60, signal());
  const cancelled = budget.reserve(80, controller.signal).catch(sdkError);
  const next = budget.reserve(20, signal());
  controller.abort();
  expect(await cancelled).toEqual({ ok: false, error: 'not_ready' });
  const done = await next; expect(budget.used).toBe(80); expect(budget.waiting).toBe(0);
  done(); release(); expect(budget.used).toBe(0);
});

it('bounds waiting time and distinguishes overload from an impossible charge', async () => {
  vi.useFakeTimers();
  const budget = new ReadBudget(100, 1), release = await budget.reserve(100, signal());
  const pending = budget.reserve(1, signal()).catch(sdkError);
  await vi.advanceTimersByTimeAsync(4999); expect(budget.waiting).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toEqual({ ok: false, error: 'not_ready' });
  expect(await budget.reserve(101, signal()).catch(sdkError)).toEqual({ ok: false, error: 'too_large' });
  expect(budget.waiting).toBe(0); expect(budget.used).toBe(100);
  release(); expect(budget.used).toBe(0);
});

it('shutdown and already aborted requests never acquire capacity; active leases still release exactly once', async () => {
  const budget = new ReadBudget(100, 2), controller = new AbortController(); controller.abort();
  await expect(budget.reserve(1, controller.signal)).rejects.toMatchObject({ code: 'not_ready' });
  const release = await budget.reserve(100, signal());
  const pending = budget.reserve(1, signal()).catch(sdkError);
  budget.stop(); budget.stop();
  expect(await pending).toEqual({ ok: false, error: 'not_ready' });
  expect(budget.waiting).toBe(0); expect(budget.used).toBe(100);
  release(); release(); expect(budget.used).toBe(0);
  await expect(budget.reserve(1, signal())).rejects.toMatchObject({ code: 'not_ready' });
});
