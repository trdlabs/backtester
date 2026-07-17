// E5a — pure hypothesis-novelty kernel: daily-PnL-delta extraction, Pearson correlation, and a
// nearest-neighbour novelty score. No I/O. The behavioral (L3) arbiter of family identity. Advisory:
// results ride the summary projection only.

import type { Novelty } from '@trdlabs/backtester-sdk/contracts';
import type { EquityPoint } from './artifacts.js';
import { quantize } from '../determinism/canonical-json.js';

export interface DailyDelta {
  readonly day: string; // 'YYYY-MM-DD' UTC
  readonly delta: number;
}
export interface NoveltyPoolMember {
  readonly ref: string;
  readonly runId: string;
  readonly dailyDeltas: readonly DailyDelta[];
}
export interface NoveltyOpts {
  readonly minOverlapDays: number;
  readonly threshold: number;
  readonly comparabilityKey: string;
}

/** Config-layer error (thrown from loadConfig when the flag is on and a threshold is out of range). */
export class NoveltyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoveltyConfigError';
  }
}

/**
 * UTC-daily close-to-close PnL deltas. Buckets equity by UTC day, takes each day's LAST point as the
 * close, and emits `close_i − close_{i-1}` for adjacent AVAILABLE close-days (missing calendar days do
 * NOT synthesize zero deltas). Each delta is labelled with the LATER close-day (the alignment key).
 * PRECONDITION: `equity` is in ascending `barTs` order — this is an engine invariant (the equity curve
 * is emitted bar-by-bar in time order); this function relies on it and does NOT re-sort. If that
 * invariant is ever in doubt, sort upstream, not here (keeps this kernel O(n) and allocation-light).
 */
export function toDailyPnlDeltas(equity: readonly EquityPoint[]): DailyDelta[] {
  const closeByDay = new Map<string, number>();
  const order: string[] = [];
  for (const p of equity) {
    const day = new Date(p.barTs).toISOString().slice(0, 10);
    if (!closeByDay.has(day)) order.push(day);
    closeByDay.set(day, p.equity); // ascending ts ⇒ last write of a day == close
  }
  const out: DailyDelta[] = [];
  for (let i = 1; i < order.length; i++) {
    const prev = closeByDay.get(order[i - 1])!;
    const cur = closeByDay.get(order[i])!;
    out.push({ day: order[i], delta: quantize(cur - prev) });
  }
  return out;
}

function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  const n = xs.length;
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx === 0 || vy === 0) return null;
  return cov / Math.sqrt(vx * vy);
}

/** Pearson ρ over the intersection of the two series' day labels; null below minOverlap or zero-variance. */
export function pnlDeltaCorrelation(
  a: readonly DailyDelta[],
  b: readonly DailyDelta[],
  minOverlapDays: number,
): { rho: number; overlapDays: number } | null {
  const bByDay = new Map(b.map((d) => [d.day, d.delta]));
  const xs: number[] = [];
  const ys: number[] = [];
  for (const d of a) {
    const y = bByDay.get(d.day);
    if (y !== undefined) {
      xs.push(d.delta);
      ys.push(y);
    }
  }
  const overlapDays = xs.length;
  if (overlapDays < minOverlapDays) return null;
  const rho = pearson(xs, ys);
  if (rho === null) return null;
  return { rho: quantize(rho), overlapDays };
}

/** Novelty = 1 − max|ρ| over comparable pool members; status union handles the cold-start cases. */
export function computeNovelty(
  candidate: readonly DailyDelta[],
  pool: readonly NoveltyPoolMember[],
  opts: NoveltyOpts,
): Novelty {
  const policy = { threshold: opts.threshold, minOverlapDays: opts.minOverlapDays };
  const comparabilityKey = opts.comparabilityKey;
  if (candidate.length < 2) {
    return { status: 'no_comparators', reason: 'empty_candidate', comparabilityKey, policy };
  }
  if (pool.length === 0) {
    return { status: 'no_comparators', reason: 'empty_pool', comparabilityKey, policy };
  }
  const comparators: { ref: string; runId: string; rho: number; overlapDays: number }[] = [];
  for (const m of pool) {
    const c = pnlDeltaCorrelation(candidate, m.dailyDeltas, opts.minOverlapDays);
    if (c) comparators.push({ ref: m.ref, runId: m.runId, rho: c.rho, overlapDays: c.overlapDays });
  }
  if (comparators.length === 0) {
    return { status: 'no_comparators', reason: 'insufficient_overlap', comparabilityKey, policy };
  }
  let best = comparators[0];
  for (const c of comparators) {
    const ca = Math.abs(c.rho);
    const ba = Math.abs(best.rho);
    if (ca > ba || (ca === ba && c.ref < best.ref)) best = c;
  }
  const maxAbs = Math.abs(best.rho);
  return {
    status: 'resolved',
    score: quantize(1 - maxAbs),
    maxAbsCorrelation: quantize(maxAbs),
    nearest: { ref: best.ref, runId: best.runId, correlation: best.rho, overlapDays: best.overlapDays },
    comparabilityKey,
    comparedAgainst: comparators.length,
    behavioralDuplicate: maxAbs >= opts.threshold,
    policy,
  };
}
