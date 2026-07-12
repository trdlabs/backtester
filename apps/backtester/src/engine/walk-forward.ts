// E3a — pure walk-forward substrate. `splitWalkForward` turns a period + scheme into ordered
// train/test fold windows; `aggregateFolds` reduces per-fold metrics to a transparent cross-fold
// stats surface. Both pure & deterministic; nothing here executes a backtest (that is E3b).

import type {
  FoldWindow,
  RunPeriod,
  WalkForwardAggregate,
  WalkForwardFoldMetrics,
  WalkForwardMetricStats,
  WalkForwardScheme,
} from '@trading-backtester/sdk/contracts';
import { quantize } from '../determinism/canonical-json.js';

/** Malformed walk-forward configuration — thrown fail-fast so a bad config never silently no-ops. */
export class WalkForwardConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalkForwardConfigError';
  }
}

/**
 * Partition `[from, to]` into `folds + 1` equal integer-ms segments. Segment 0 is the initial
 * in-sample/warmup region (never a test window). Fold `i`: test = `[boundary(i+1), boundary(i+2)]`;
 * train = `[from, testFrom]` (expanding) or `[boundary(i), testFrom]` (rolling). Fail-fast on a
 * non-positive/non-integer fold count, `to ≤ from`, or unparseable bounds.
 */
export function splitWalkForward(period: RunPeriod, scheme: WalkForwardScheme): FoldWindow[] {
  const fromMs = Date.parse(period.from);
  const toMs = Date.parse(period.to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    throw new WalkForwardConfigError('walk-forward: period bounds are not parseable dates');
  }
  if (toMs <= fromMs) {
    throw new WalkForwardConfigError('walk-forward: period `from` must precede `to`');
  }
  if (!Number.isSafeInteger(scheme.folds) || scheme.folds < 1) {
    throw new WalkForwardConfigError('walk-forward: `folds` must be a positive integer');
  }
  if (scheme.mode !== 'rolling' && scheme.mode !== 'expanding') {
    throw new WalkForwardConfigError('walk-forward: `mode` must be "rolling" or "expanding"');
  }

  const segments = scheme.folds + 1;
  const total = toMs - fromMs;
  const boundary = (k: number): number => fromMs + Math.round((total * k) / segments);
  const iso = (ms: number): string => new Date(ms).toISOString();

  const folds: FoldWindow[] = [];
  for (let i = 0; i < scheme.folds; i += 1) {
    const testFrom = boundary(i + 1);
    const testTo = boundary(i + 2);
    const trainFrom = scheme.mode === 'expanding' ? fromMs : boundary(i);
    folds.push({
      index: i,
      train: { from: iso(trainFrom), to: iso(testFrom) },
      test: { from: iso(testFrom), to: iso(testTo) },
    });
  }
  return folds;
}

/** Metric names present in EVERY fold (omit-safe intersection). */
function commonMetricNames(perFold: readonly WalkForwardFoldMetrics[]): string[] {
  if (perFold.length === 0) return [];
  return Object.keys(perFold[0].metrics).filter((name) =>
    perFold.every((f) => name in f.metrics),
  );
}

/**
 * Reduce per-fold metrics to `{ mean, stddev (population), min, max, positiveFraction }` per metric
 * present in all folds. Empty input ⇒ `{ foldCount: 0, metrics: {} }` (valid "no folds", not an error).
 */
export function aggregateFolds(perFold: readonly WalkForwardFoldMetrics[]): WalkForwardAggregate {
  const foldCount = perFold.length;
  const metrics: Record<string, WalkForwardMetricStats> = {};
  for (const name of commonMetricNames(perFold)) {
    const values = perFold.map((f) => f.metrics[name]);
    const mean = values.reduce((a, b) => a + b, 0) / foldCount;
    const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / foldCount; // population
    const positives = values.filter((v) => v > 0).length;
    metrics[name] = {
      mean: quantize(mean),
      stddev: quantize(Math.sqrt(variance)),
      min: quantize(Math.min(...values)),
      max: quantize(Math.max(...values)),
      positiveFraction: quantize(positives / foldCount),
    };
  }
  return { foldCount, metrics };
}
