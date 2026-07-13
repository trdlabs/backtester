import { describe, expect, it } from 'vitest';
import type { EquityPoint } from '../src/engine/artifacts.js';
import {
  toDailyPnlDeltas,
  pnlDeltaCorrelation,
  computeNovelty,
  type DailyDelta,
  type NoveltyPoolMember,
} from '../src/engine/novelty.js';

const DAY = 86_400_000;
function eq(day: number, equity: number, hourOffset = 0): EquityPoint {
  return { barIndex: day, barTs: day * DAY + hourOffset * 3_600_000, equity };
}
function deltas(days: string[], vals: number[]): DailyDelta[] {
  return days.map((day, i) => ({ day, delta: vals[i] }));
}
const OPTS = { minOverlapDays: 2, threshold: 0.8, comparabilityKey: 'k' };

describe('toDailyPnlDeltas', () => {
  it('takes the last point of each UTC day as close and diffs adjacent available days', () => {
    // day 0: two points (close=110); day 1: close=105; day 2: close=130
    const out = toDailyPnlDeltas([eq(0, 100, 1), eq(0, 110, 5), eq(1, 105), eq(2, 130)]);
    expect(out).toEqual([
      { day: '1970-01-02', delta: -5 }, // 105 − 110, labelled with the LATER day
      { day: '1970-01-03', delta: 25 }, // 130 − 105
    ]);
  });
  it('a gap produces one spanning delta, not zero-filled days', () => {
    const out = toDailyPnlDeltas([eq(0, 100), eq(3, 130)]); // 3-day gap
    expect(out).toEqual([{ day: '1970-01-04', delta: 30 }]);
  });
  it('a single close-day yields no deltas', () => {
    expect(toDailyPnlDeltas([eq(0, 100), eq(0, 105)])).toEqual([]);
  });
});

describe('pnlDeltaCorrelation', () => {
  const a = deltas(['d1', 'd2', 'd3'], [1, 2, 3]);
  it('identical series → ρ=1', () => {
    expect(pnlDeltaCorrelation(a, a, 2)).toEqual({ rho: 1, overlapDays: 3 });
  });
  it('scaled series → ρ=1 (scale-invariant)', () => {
    const b = deltas(['d1', 'd2', 'd3'], [2, 4, 6]);
    expect(pnlDeltaCorrelation(a, b, 2)?.rho).toBe(1);
  });
  it('anti-correlated → ρ=-1', () => {
    const b = deltas(['d1', 'd2', 'd3'], [3, 2, 1]);
    expect(pnlDeltaCorrelation(a, b, 2)?.rho).toBe(-1);
  });
  it('overlap below min → null', () => {
    const b = deltas(['d3', 'd4', 'd5'], [3, 9, 9]); // shares only d3
    expect(pnlDeltaCorrelation(a, b, 2)).toBeNull();
  });
  it('zero-variance series → null', () => {
    const flat = deltas(['d1', 'd2', 'd3'], [5, 5, 5]);
    expect(pnlDeltaCorrelation(a, flat, 2)).toBeNull();
  });
});

describe('computeNovelty', () => {
  const cand = deltas(['d1', 'd2', 'd3'], [1, 2, 3]);
  it('empty candidate (<2 deltas) → no_comparators:empty_candidate', () => {
    const r = computeNovelty(deltas(['d1'], [1]), [], OPTS);
    expect(r).toMatchObject({ status: 'no_comparators', reason: 'empty_candidate', comparabilityKey: 'k' });
  });
  it('empty pool → no_comparators:empty_pool', () => {
    expect(computeNovelty(cand, [], OPTS)).toMatchObject({ status: 'no_comparators', reason: 'empty_pool' });
  });
  it('members present but none meet overlap → insufficient_overlap', () => {
    const m: NoveltyPoolMember = { ref: 'h1', runId: 'r1', dailyDeltas: deltas(['x1', 'x2', 'x3'], [1, 2, 3]) };
    expect(computeNovelty(cand, [m], OPTS)).toMatchObject({ status: 'no_comparators', reason: 'insufficient_overlap' });
  });
  it('resolved: score=1−maxAbs, behavioralDuplicate at threshold, correct nearest', () => {
    const twin: NoveltyPoolMember = { ref: 'h_twin', runId: 'r_twin', dailyDeltas: cand };
    const noise: NoveltyPoolMember = { ref: 'h_noise', runId: 'r_noise', dailyDeltas: deltas(['d1', 'd2', 'd3'], [3, 1, 2]) };
    const r = computeNovelty(cand, [noise, twin], OPTS);
    expect(r).toMatchObject({
      status: 'resolved',
      score: 0,
      maxAbsCorrelation: 1,
      behavioralDuplicate: true,
      comparedAgainst: 2,
      nearest: { ref: 'h_twin', runId: 'r_twin', correlation: 1 },
    });
  });
  it('nearest ties broken by smallest ref', () => {
    const twinB: NoveltyPoolMember = { ref: 'b', runId: 'rb', dailyDeltas: cand };
    const twinA: NoveltyPoolMember = { ref: 'a', runId: 'ra', dailyDeltas: cand };
    const r = computeNovelty(cand, [twinB, twinA], OPTS);
    expect(r.status).toBe('resolved');
    if (r.status === 'resolved') expect(r.nearest.ref).toBe('a');
  });
});
