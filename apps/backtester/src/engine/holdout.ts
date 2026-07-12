// E4a — held-out OOS qualification: pure, deterministic. Carves a reserved window from the tail of a
// dataset's coverage span and classifies whether a run's period touches it (half-open intervals).
// Advisory: the marker rides the result projection only, never a hashed payload. NOT the worker's
// pre-existing curated-baseline "E4" evidence block — different feature.

import type { HoldoutResolved, RunPeriod } from '@trading-backtester/sdk/contracts';

/** Malformed holdout configuration — thrown fail-fast so a bad fraction/coverage never silently no-ops. */
export class HoldoutConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HoldoutConfigError';
  }
}

/**
 * Reserved window = the last `fraction` of `[coverageFrom, coverageTo]`:
 * `[coverageTo − round(fraction·span), coverageTo]`. Fail-fast on `fraction ∉ (0,1)` or unparseable
 * / non-increasing coverage bounds (no silent clamp).
 */
export function computeHoldoutWindow(coverage: RunPeriod, fraction: number): RunPeriod {
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction >= 1) {
    throw new HoldoutConfigError('holdout: `fraction` must be a finite number in (0, 1)');
  }
  const fromMs = Date.parse(coverage.from);
  const toMs = Date.parse(coverage.to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    throw new HoldoutConfigError('holdout: coverage bounds are not parseable dates');
  }
  if (toMs <= fromMs) {
    throw new HoldoutConfigError('holdout: coverage `from` must precede `to`');
  }
  const holdoutFromMs = toMs - Math.round(fraction * (toMs - fromMs));
  return { from: new Date(holdoutFromMs).toISOString(), to: coverage.to };
}

/**
 * Classify a run period against the holdout as HALF-OPEN `[from, to)`: `overlaps = rFrom < hTo &&
 * hFrom < rTo` (a boundary touch is NOT overlap). `containment` is `'full'` when the run lies
 * entirely inside the holdout (`run ⊆ holdout`), `'none'` when disjoint, else `'partial'`.
 */
export function holdoutOverlap(
  runPeriod: RunPeriod,
  holdout: RunPeriod,
): { overlaps: boolean; containment: 'none' | 'partial' | 'full' } {
  const rFrom = Date.parse(runPeriod.from);
  const rTo = Date.parse(runPeriod.to);
  const hFrom = Date.parse(holdout.from);
  const hTo = Date.parse(holdout.to);
  const overlaps = rFrom < hTo && hFrom < rTo;
  if (!overlaps) return { overlaps: false, containment: 'none' };
  const containment = hFrom <= rFrom && rTo <= hTo ? 'full' : 'partial';
  return { overlaps: true, containment };
}

/** Compose the window + overlap into the provenance-bearing resolved marker. */
export function buildHoldoutMarker(coverage: RunPeriod, fraction: number, runPeriod: RunPeriod): HoldoutResolved {
  const window = computeHoldoutWindow(coverage, fraction);
  const { overlaps, containment } = holdoutOverlap(runPeriod, window);
  return {
    status: 'resolved',
    policy: 'coverage_fraction',
    fraction,
    coverage,
    window,
    overlaps,
    containment,
  };
}
