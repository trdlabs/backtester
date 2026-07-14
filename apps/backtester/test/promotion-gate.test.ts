import { describe, expect, it } from 'vitest';
import type { EquityPoint, Trade } from '../src/engine/artifacts.js';
import { evaluatePromotionIntegrity, evaluatePromotionWindow } from '../src/evidence/promotion-gate.js';
import type { CompletedOutcome } from '../src/engine/window-eval.js';

const DAY = 86_400_000;
const pt = (d: number, e: number): EquityPoint => ({ barIndex: d, barTs: d * DAY, equity: e });
function oc(eq: EquityPoint[], tr: Trade[] = []): CompletedOutcome {
  return { status: 'completed', baseline: { trades: tr, evidence: { equityCurve: eq } } } as unknown as CompletedOutcome;
}
const THRESH = { minSharpe: 0, maxDrawdown: 1, minWinRate: 0, minTrades: 1 };
const POLICY = ['sharpe', 'max_drawdown', 'win_rate', 'total_trades'];
const holdout = { from: new Date(6 * DAY).toISOString(), to: new Date(10 * DAY).toISOString() };
const runPeriod = { from: new Date(0).toISOString(), to: new Date(10 * DAY).toISOString() };
const warmEquity = [pt(1, 100), pt(3, 105), pt(5, 108), pt(7, 120), pt(8, 118), pt(9, 130)]; // 3 pre-holdout steps
const trd = (entryDay: number, exitDay: number, pnl: number): Trade => ({ id: `t${entryDay}`, symbol: 'X', side: 'long', entryBarIndex: 0, entryTs: entryDay * DAY, entryFillPrice: 1, exitBarIndex: 1, exitTs: exitDay * DAY, exitFillPrice: 1 + pnl, size: 1, feePaid: 0, realizedPnl: pnl, closeReason: 'end_of_data' } as Trade);
// executedBarTimes: per-symbol ACTUAL bar start-timestamps of the FROZEN tape. Full daily grid [0..9]d so
// the window [6d,10d) is covered at BOTH boundaries (a bar at 6d covers the left, a bar at 9d reaches 10d).
// timeframe is the TRUSTED grid step (parsed to ms), never inferred from bar spacing.
const FULL_BARS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => d * DAY);
// Grid is built from the SERVER-DERIVED datasetTimeframe (trusted), and the request timeframe must equal it
// — a client can't relabel a sparse fine tape as a coarse one to fake full coverage.
const win = { holdoutWindow: holdout, runPeriod, thresholds: THRESH, policyMetrics: POLICY, minWarmupBars: 2, minTrades: 1, executedBarTimes: [FULL_BARS], requestTimeframe: '1d', datasetTimeframe: '1d' };

describe('evaluatePromotionIntegrity', () => {
  it('gate_rejected wins first', () => {
    expect(evaluatePromotionIntegrity({ bundleGateRejected: true, candidate: oc(warmEquity), curated: oc(warmEquity) }))
      .toEqual({ outcome: 'reject', reason: 'gate_rejected' });
  });
  it('twin_divergent when candidate != curated', () => {
    expect(evaluatePromotionIntegrity({ bundleGateRejected: false, candidate: oc(warmEquity, [trd(7, 8, 1)]), curated: oc(warmEquity) }))
      .toMatchObject({ outcome: 'reject', reason: 'twin_divergent' });
  });
  it('ok when valid + equivalent', () => {
    expect(evaluatePromotionIntegrity({ bundleGateRejected: false, candidate: oc(warmEquity), curated: oc(warmEquity) }))
      .toEqual({ outcome: 'ok' });
  });
});

describe('evaluatePromotionWindow', () => {
  it('holdout_not_covered when window not inside run period', () => {
    const shortRun = { from: new Date(0).toISOString(), to: new Date(7 * DAY).toISOString() };
    expect(evaluatePromotionWindow({ ...win, runPeriod: shortRun, candidate: oc(warmEquity), curated: oc(warmEquity) }))
      .toEqual({ outcome: 'reject', reason: 'holdout_not_covered' });
  });
  it('warmup_insufficient below minWarmupBars distinct pre-window steps', () => {
    const thin = [pt(5, 100), pt(7, 120), pt(9, 130)]; // only 1 distinct step < 6d
    expect(evaluatePromotionWindow({ ...win, candidate: oc(thin), curated: oc(thin) }))
      .toEqual({ outcome: 'reject', reason: 'warmup_insufficient' });
  });
  it('evaluation_insufficient when the holdout slice has < 2 points', () => {
    const noOos = [pt(1, 100), pt(3, 105), pt(5, 108)]; // nothing in [6d,10d), anchor pt(5) ⇒ 1 point
    expect(evaluatePromotionWindow({ ...win, candidate: oc(noOos), curated: oc(noOos) }))
      .toEqual({ outcome: 'reject', reason: 'evaluation_insufficient' });
  });
  it('evaluated → passed when holdout metrics pass thresholds', () => {
    const eq = oc(warmEquity, [trd(7, 8, 5)]);
    const r = evaluatePromotionWindow({ ...win, candidate: eq, curated: eq });
    expect(r.outcome).toBe('evaluated');
    if (r.outcome === 'evaluated') expect(r.verdict).toBe('passed');
  });
  it('evaluation_insufficient when the frozen tape tail ends inside the window (right boundary uncovered)', () => {
    // profitable sub-portion but the tape ends at 8d, INSIDE [6d,10d): no bar reaches wTo=10d.
    const eq = oc([pt(1, 100), pt(3, 105), pt(5, 108), pt(7, 120), pt(8, 130)], [trd(7, 8, 5)]);
    const tail = [[0, 1, 2, 3, 4, 5, 6, 7, 8].map((d) => d * DAY)]; // last bar 8d → 8d+1d=9d < 10d
    expect(evaluatePromotionWindow({ ...win, executedBarTimes: tail, candidate: eq, curated: eq }))
      .toEqual({ outcome: 'reject', reason: 'evaluation_insufficient' });
  });
  it('evaluation_insufficient on a gap RIGHT AT the left boundary (span brackets wFrom but no bar covers it)', () => {
    // firstTs (5d) <= wFrom (6d) AND lastTs (9d) reaches wTo — the OLD span-only guard would PASS — but
    // there is NO bar at 6d (gap 5d→7d), so the window's left edge is not actually covered.
    const eq = oc(warmEquity, [trd(7, 8, 5)]);
    const gapAtLeft = [[0, 1, 2, 3, 4, 5, 7, 8, 9].map((d) => d * DAY)]; // 6d MISSING
    expect(evaluatePromotionWindow({ ...win, executedBarTimes: gapAtLeft, candidate: eq, curated: eq }))
      .toEqual({ outcome: 'reject', reason: 'evaluation_insufficient' });
  });
  it('evaluation_insufficient when a LEADING gap would inflate an inferred interval and mask a short tail', () => {
    // bars [0d, 5d, 6d, 7d]: an interval inferred from bars[1]-bars[0] = 5d would make 7d+5d=12d ≥ 10d PASS
    // (false accept). With the trusted 1d timeframe, the tail (last bar 7d → 8d < 10d) is correctly rejected.
    const eq = oc([pt(1, 100), pt(5, 108), pt(6, 115), pt(7, 120)], [trd(6, 7, 5)]);
    const leadingGap = [[0, 5, 6, 7].map((d) => d * DAY)];
    expect(evaluatePromotionWindow({ ...win, executedBarTimes: leadingGap, candidate: eq, curated: eq }))
      .toEqual({ outcome: 'reject', reason: 'evaluation_insufficient' });
  });
  it('evaluation_insufficient on an INTERIOR gap (both edges present, middle bar missing)', () => {
    // 7d,8d missing inside [6d,10d): edges 6d & 9d present but the window is not fully covered — signing
    // metrics computed over the sparse subset as the FULL window would be a false scope claim.
    const eq = oc([pt(1, 100), pt(6, 110), pt(9, 130)], [trd(6, 9, 5)]);
    const interior = [[0, 1, 2, 3, 4, 5, 6, 9].map((d) => d * DAY)];
    expect(evaluatePromotionWindow({ ...win, executedBarTimes: interior, candidate: eq, curated: eq }))
      .toEqual({ outcome: 'reject', reason: 'evaluation_insufficient' });
  });
  it('evaluation_insufficient when declared timeframe is COARSER than the real tape cadence (extra in-window bars)', () => {
    const HOUR = 3_600_000;
    const eq = oc(warmEquity, [trd(7, 8, 5)]);
    // hourly bars 5d..10d but server timeframe '1d' (from win): 96 in-window bars vs 4 daily slots ⇒ mismatch.
    const hourly = [Array.from({ length: 24 * 5 }, (_, i) => 5 * DAY + i * HOUR)];
    expect(evaluatePromotionWindow({ ...win, executedBarTimes: hourly, candidate: eq, curated: eq }))
      .toEqual({ outcome: 'reject', reason: 'evaluation_insufficient' });
  });
  it('evaluation_insufficient when ANY symbol is uncovered even if others are complete (per-symbol guard)', () => {
    const eq = oc(warmEquity, [trd(7, 8, 5)]);
    const mixed = [FULL_BARS, [0, 1, 2, 3, 4, 5, 6, 7, 8].map((d) => d * DAY)]; // 2nd symbol tail short
    expect(evaluatePromotionWindow({ ...win, executedBarTimes: mixed, candidate: eq, curated: eq }))
      .toEqual({ outcome: 'reject', reason: 'evaluation_insufficient' });
  });
  it('evaluation_insufficient (fail-closed) on an unknown/unparseable timeframe even with full bars', () => {
    const eq = oc(warmEquity, [trd(7, 8, 5)]);
    expect(evaluatePromotionWindow({ ...win, requestTimeframe: 'bogus', datasetTimeframe: 'bogus', candidate: eq, curated: eq }))
      .toEqual({ outcome: 'reject', reason: 'evaluation_insufficient' });
  });
  it('evaluation_insufficient when request timeframe != server datasetTimeframe (relabel attack)', () => {
    // Attack: a sparse 1m tape with bars only at 6d & 8d, relabeled '2d' to fake full coverage of [6d,10d).
    // The grid is built from the SERVER datasetTimeframe, and request must equal it — so the mismatch rejects.
    const eq = oc([pt(1, 100), pt(6, 110), pt(8, 130)], [trd(6, 8, 5)]);
    const sparse = [[0, 6, 8].map((d) => d * DAY)];
    expect(evaluatePromotionWindow({ ...win, executedBarTimes: sparse, requestTimeframe: '2d', datasetTimeframe: '1m', candidate: eq, curated: eq }))
      .toEqual({ outcome: 'reject', reason: 'evaluation_insufficient' });
  });
  it('evaluation_insufficient when the sparse tape matches a relabeled coarse request but the SERVER timeframe is fine', () => {
    // Even if request==dataset were both honestly '1m', a sparse tape (bars 6d,8d only) can't cover [6d,10d)
    // on the 1m grid — thousands of slots missing. Confirms server-grid defeats the sparse-coarse fake.
    const eq = oc([pt(1, 100), pt(6, 110), pt(8, 130)], [trd(6, 8, 5)]);
    const sparse = [[0, 6, 8].map((d) => d * DAY)];
    expect(evaluatePromotionWindow({ ...win, executedBarTimes: sparse, requestTimeframe: '1m', datasetTimeframe: '1m', candidate: eq, curated: eq }))
      .toEqual({ outcome: 'reject', reason: 'evaluation_insufficient' });
  });
});
