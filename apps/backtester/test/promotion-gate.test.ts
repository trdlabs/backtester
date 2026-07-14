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
// executedSpans: per-symbol [firstTs,lastTs] of the FROZEN tape. Full coverage of [6d,10d) by default so
// the existing cases exercise the downstream checks; barIntervalMs = 1 day (fixture grid).
const FULL_SPANS = [{ firstTs: 0, lastTs: 10 * DAY }];
const win = { holdoutWindow: holdout, runPeriod, thresholds: THRESH, policyMetrics: POLICY, minWarmupBars: 2, minTrades: 1, executedSpans: FULL_SPANS, barIntervalMs: DAY };

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
  it('evaluation_insufficient when the frozen tape does not cover the full holdout window (partial tail)', () => {
    // A profitable sub-portion [6d,8d] (2 points + a winning trade) that WOULD pass — but the tape ends at
    // 8d, INSIDE [6d,10d). Signing these metrics as the full evaluationWindow would be a false scope claim.
    const eq = oc([pt(1, 100), pt(3, 105), pt(5, 108), pt(7, 120), pt(8, 130)], [trd(7, 8, 5)]);
    const partial = [{ firstTs: 0, lastTs: 8 * DAY }]; // last bar at 8d + 1d interval = 9d < wTo (10d)
    expect(evaluatePromotionWindow({ ...win, executedSpans: partial, candidate: eq, curated: eq }))
      .toEqual({ outcome: 'reject', reason: 'evaluation_insufficient' });
  });
  it('evaluation_insufficient when a symbol tape STARTS after the window opens (left boundary uncovered)', () => {
    const eq = oc(warmEquity, [trd(7, 8, 5)]);
    const lateStart = [{ firstTs: 7 * DAY, lastTs: 10 * DAY }]; // starts at 7d > wFrom (6d)
    expect(evaluatePromotionWindow({ ...win, executedSpans: lateStart, candidate: eq, curated: eq }))
      .toEqual({ outcome: 'reject', reason: 'evaluation_insufficient' });
  });
  it('evaluation_insufficient when ANY symbol is uncovered even if others are complete (per-symbol guard)', () => {
    const eq = oc(warmEquity, [trd(7, 8, 5)]);
    const mixed = [{ firstTs: 0, lastTs: 10 * DAY }, { firstTs: 0, lastTs: 8 * DAY }]; // 2nd symbol short
    expect(evaluatePromotionWindow({ ...win, executedSpans: mixed, candidate: eq, curated: eq }))
      .toEqual({ outcome: 'reject', reason: 'evaluation_insufficient' });
  });
});
