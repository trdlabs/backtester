import { describe, expect, it } from 'vitest';
import type { EquityPoint, Trade } from '../src/engine/artifacts.js';
import {
  runWalkForward, WalkForwardFoldError, type CompletedOutcome, type RunFold,
} from '../src/engine/walk-forward-exec.js';

const DAY = 86_400_000;
// A 4-day period → folds partition it. Fixture outcomes are built to land inside each fold's test window.
const PERIOD = { from: new Date(0).toISOString(), to: new Date(4 * DAY).toISOString() };

function outcome(equity: EquityPoint[], trades: Trade[]): CompletedOutcome {
  return { status: 'completed', baseline: { trades, evidence: { equityCurve: equity } } } as unknown as CompletedOutcome;
}
function pt(dayFrac: number, equity: number): EquityPoint {
  return { barIndex: Math.round(dayFrac * 24), barTs: Math.round(dayFrac * DAY), equity };
}
function trade(entryDay: number, exitDay: number, pnl: number): Trade {
  return {
    id: `t${entryDay}`, symbol: 'BTCUSDT', side: 'long',
    entryBarIndex: 0, entryTs: entryDay * DAY, entryFillPrice: 100,
    exitBarIndex: 1, exitTs: exitDay * DAY, exitFillPrice: 100 + pnl,
    size: 1, feePaid: 0, realizedPnl: pnl, closeReason: 'end_of_data',
  } as Trade;
}
const input = (over = {}) => ({
  scheme: { folds: 2, mode: 'rolling' as const }, period: PERIOD,
  requestedMetrics: ['returns_count'], maxFolds: 20, deadlineExceeded: () => false, ...over,
});
// An outcome rich enough that every fold's test slice has >= 2 anchored points.
const richOutcome = outcome(
  [pt(0.5, 100), pt(1.5, 110), pt(2.5, 120), pt(3.5, 130)],
  [trade(1.2, 1.8, 5)],
);
const okRunFold: RunFold = async () => ({ outcome: richOutcome, hash: 'h' });

describe('runWalkForward', () => {
  it('all folds complete ⇒ resolved with matching counts', async () => {
    const wf = await runWalkForward(input(), okRunFold);
    expect(wf.status).toBe('resolved');
    if (wf.status === 'resolved') {
      expect(wf.folds.length).toBe(2);
      expect(wf.aggregate.requestedFoldCount).toBe(2);
      expect(wf.aggregate.completedFoldCount).toBe(2);
      expect(wf.failedFolds).toEqual([]);
    }
  });
  it('one fold throws a coded error ⇒ partial + normalized code', async () => {
    let n = 0;
    const rf: RunFold = async () => { if (n++ === 0) throw new WalkForwardFoldError('sandbox_failure', 'boom'); return { outcome: richOutcome, hash: 'h' }; };
    const wf = await runWalkForward(input(), rf);
    expect(wf.status).toBe('partial');
    if (wf.status !== 'unavailable') expect(wf.failedFolds).toEqual([{ index: 0, code: 'sandbox_failure' }]);
  });
  it('an un-coded throw maps to runner_failure', async () => {
    const rf: RunFold = async () => { throw new Error('plain'); };
    const wf = await runWalkForward(input(), rf);
    expect(wf.status).toBe('unavailable');
    if (wf.status === 'unavailable') {
      expect(wf.reason).toBe('all_folds_failed');
      expect(wf.failedFolds.every((f) => f.code === 'runner_failure')).toBe(true);
    }
  });
  it('folds > maxFolds ⇒ unavailable folds_exceeds_max (empty arrays)', async () => {
    const wf = await runWalkForward(input({ maxFolds: 1 }), okRunFold);
    expect(wf).toMatchObject({ status: 'unavailable', reason: 'folds_exceeds_max', failedFolds: [], insufficientFolds: [] });
  });
  it('a fold whose anchored test slice has <2 points ⇒ insufficientFolds, excluded', async () => {
    const thin = outcome([pt(3.9, 100)], []); // one point, no anchor before an early test window
    const wf = await runWalkForward(input(), async () => ({ outcome: thin, hash: 'h' }));
    expect(wf.status).toBe('unavailable');
    if (wf.status === 'unavailable') expect(wf.reason).toBe('insufficient_folds');
  });
  it('deadline flips true after fold 0 ⇒ remaining folds budget_exhausted, partial', async () => {
    let calls = 0;
    const wf = await runWalkForward(input({ deadlineExceeded: () => calls > 0 }), async () => { calls++; return { outcome: richOutcome, hash: 'h' }; });
    expect(wf.status).toBe('partial');
    if (wf.status !== 'unavailable') expect(wf.failedFolds).toEqual([{ index: 1, code: 'budget_exhausted' }]);
  });
  it('split error (bad scheme) ⇒ unavailable split_error', async () => {
    const wf = await runWalkForward(input({ scheme: { folds: 0, mode: 'rolling' } }), okRunFold);
    // maxFolds check passes (0 <= 20); splitWalkForward throws on folds < 1
    expect(wf).toMatchObject({ status: 'unavailable', reason: 'split_error' });
  });
});

describe('runWalkForward — test-window evaluation', () => {
  it('excludes carry-in trades from trade metrics but counts them', async () => {
    // test window of fold 0 (rolling, 2 folds over 4 days): boundaries at 0,1.33,2.67,4 →
    // fold0 test ≈ [1.33d, 2.67d). Carry-in trade enters at 1.0d (train), exits 2.0d (in test).
    const carry = outcome(
      [pt(1.0, 100), pt(1.5, 105), pt(2.0, 108), pt(2.5, 112)],
      [trade(1.0, 2.0, 8)], // entryTs before test.from ⇒ carry-in, excluded from trade metrics
    );
    const wf = await runWalkForward(input({ requestedMetrics: ['total_trades'] }), async () => ({ outcome: carry, hash: 'h' }));
    if (wf.status !== 'unavailable') {
      const f0 = wf.folds.find((f) => f.index === 0)!;
      expect(f0.carryInClosedTradeCount).toBe(1);
      expect(f0.metrics.total_trades).toBe(0); // the carry-in trade is not an in-test trade
    }
  });
});
