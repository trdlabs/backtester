// E3a — pure walk-forward substrate: split (period → train/test folds) and aggregate (per-fold
// metrics → transparent cross-fold stats). Executes nothing; no submit/result wiring.

import { describe, expect, it } from 'vitest';
import type { WalkForwardFoldMetrics } from '@trdlabs/backtester-sdk/contracts';
import { aggregateFolds, splitWalkForward, WalkForwardConfigError } from '../src/engine/walk-forward.js';

// 7-day window ⇒ folds=6 ⇒ 7 equal 1-day segments; boundary(k) = 2023-01-(01+k).
const PERIOD = { from: '2023-01-01T00:00:00.000Z', to: '2023-01-08T00:00:00.000Z' };

describe('splitWalkForward', () => {
  it('produces exactly `folds` folds', () => {
    expect(splitWalkForward(PERIOD, { folds: 6, mode: 'expanding' })).toHaveLength(6);
  });

  it('test windows tile [boundary(1), to] contiguously and the last ends at `to`', () => {
    const folds = splitWalkForward(PERIOD, { folds: 6, mode: 'expanding' });
    expect(folds[0].test.from).toBe('2023-01-02T00:00:00.000Z');
    expect(folds[0].test.to).toBe('2023-01-03T00:00:00.000Z');
    for (let i = 0; i < folds.length - 1; i += 1) {
      expect(folds[i].test.to).toBe(folds[i + 1].test.from);
    }
    expect(folds[5].test.to).toBe('2023-01-08T00:00:00.000Z');
  });

  it('expanding: every train window starts at the period start', () => {
    const folds = splitWalkForward(PERIOD, { folds: 6, mode: 'expanding' });
    for (const f of folds) expect(f.train.from).toBe('2023-01-01T00:00:00.000Z');
    expect(folds[5].train.to).toBe('2023-01-07T00:00:00.000Z');
  });

  it('rolling: train is the single segment preceding the test window', () => {
    const folds = splitWalkForward(PERIOD, { folds: 6, mode: 'rolling' });
    expect(folds[5].train.from).toBe('2023-01-06T00:00:00.000Z');
    expect(folds[5].train.to).toBe('2023-01-07T00:00:00.000Z');
    expect(folds[0].train.from).toBe('2023-01-01T00:00:00.000Z');
  });

  it('fail-fast on a non-positive fold count', () => {
    expect(() => splitWalkForward(PERIOD, { folds: 0, mode: 'rolling' })).toThrow(WalkForwardConfigError);
  });
  it('fail-fast on a non-integer fold count', () => {
    expect(() => splitWalkForward(PERIOD, { folds: 2.5, mode: 'rolling' })).toThrow(WalkForwardConfigError);
  });
  it('fail-fast when to <= from', () => {
    expect(() =>
      splitWalkForward({ from: PERIOD.to, to: PERIOD.from }, { folds: 3, mode: 'rolling' }),
    ).toThrow(WalkForwardConfigError);
  });
  it('fail-fast on an unparseable date', () => {
    expect(() => splitWalkForward({ from: 'nonsense', to: PERIOD.to }, { folds: 3, mode: 'rolling' })).toThrow(
      WalkForwardConfigError,
    );
  });
  it('fail-fast on an unknown mode (must not silently default to rolling)', () => {
    expect(() =>
      splitWalkForward(PERIOD, { folds: 6, mode: 'bogus' as unknown as 'rolling' }),
    ).toThrow(WalkForwardConfigError);
  });
});

describe('aggregateFolds', () => {
  const folds: WalkForwardFoldMetrics[] = [
    { index: 0, metrics: { sharpe: 0.1, pnl: 10 } },
    { index: 1, metrics: { sharpe: 0.3, pnl: -5 } },
    { index: 2, metrics: { sharpe: 0.2, pnl: 15 } },
  ];

  it('computes mean / population stddev / min / max / positiveFraction per metric', () => {
    const agg = aggregateFolds(folds);
    expect(agg.foldCount).toBe(3);
    expect(agg.metrics.sharpe.mean).toBeCloseTo(0.2, 8);
    expect(agg.metrics.sharpe.stddev).toBeCloseTo(0.08164966, 8); // population
    expect(agg.metrics.sharpe.min).toBeCloseTo(0.1, 8);
    expect(agg.metrics.sharpe.max).toBeCloseTo(0.3, 8);
    expect(agg.metrics.sharpe.positiveFraction).toBeCloseTo(1, 8);
    expect(agg.metrics.pnl.mean).toBeCloseTo(6.66666667, 8);
    expect(agg.metrics.pnl.positiveFraction).toBeCloseTo(0.66666667, 8); // 2 of 3 > 0
  });

  it('omits a metric absent from any fold', () => {
    const agg = aggregateFolds([
      { index: 0, metrics: { sharpe: 0.1, extra: 1 } },
      { index: 1, metrics: { sharpe: 0.3 } },
    ]);
    expect('sharpe' in agg.metrics).toBe(true);
    expect('extra' in agg.metrics).toBe(false);
  });

  it('single fold ⇒ stddev 0', () => {
    const agg = aggregateFolds([{ index: 0, metrics: { sharpe: 0.4 } }]);
    expect(agg.metrics.sharpe.stddev).toBe(0);
    expect(agg.metrics.sharpe.mean).toBeCloseTo(0.4, 8);
  });

  it('empty input ⇒ foldCount 0 and no metrics', () => {
    expect(aggregateFolds([])).toEqual({ foldCount: 0, metrics: {} });
  });
});
