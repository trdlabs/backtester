import { describe, expect, it } from 'vitest';
import type { Bar } from '@trading/research-contracts/research';
import { pointInTimeDataApi } from '../src/engine/dataset.js';

// D2 / analysis/19 defect #5. The window is now built once per (bar, lookback) instead of on every
// call, which makes the freeze load-bearing — these pin both halves of that trade.
describe('closedCandles — one window per (bar, lookback)', () => {
  const bars: readonly Readonly<Bar>[] = Object.freeze(
    Array.from({ length: 10 }, (_, i) =>
      Object.freeze({ ts: 1_700_000_000_000 + i * 60_000, open: i, high: i + 1, low: i - 1, close: i + 0.5, volume: 100 + i }),
    ),
  ) as readonly Readonly<Bar>[];

  it('is strictly BEFORE t and respects the lookback', () => {
    const api = pointInTimeDataApi(bars, 5);
    expect(api.closedCandles(3).map((b) => b.open)).toEqual([2, 3, 4]);
    expect(api.closedCandles(100).map((b) => b.open)).toEqual([0, 1, 2, 3, 4]);
    expect(pointInTimeDataApi(bars, 0).closedCandles(10)).toHaveLength(0);
  });

  it('repeats the same lookback without rebuilding, and a different lookback still answers', () => {
    const api = pointInTimeDataApi(bars, 6);
    const first = api.closedCandles(4);
    expect(api.closedCandles(4)).toBe(first);
    expect(api.closedCandles(2).map((b) => b.open)).toEqual([4, 5]);
    // the cache is one-slot, so coming back re-materializes an EQUAL window, never a stale one
    expect(api.closedCandles(4).map((b) => b.open)).toEqual(first.map((b) => b.open));
  });

  it('hands out a frozen window — a shared window must not be mutable by its first reader', () => {
    const w = pointInTimeDataApi(bars, 4).closedCandles(3);
    expect(Object.isFrozen(w)).toBe(true);
    expect(() => {
      (w as Bar[]).push(bars[0] as Bar);
    }).toThrow();
  });

  it('windows of different bars are independent', () => {
    expect(pointInTimeDataApi(bars, 3).closedCandles(2).map((b) => b.open)).toEqual([1, 2]);
    expect(pointInTimeDataApi(bars, 8).closedCandles(2).map((b) => b.open)).toEqual([6, 7]);
  });
});
