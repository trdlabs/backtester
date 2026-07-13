import { describe, expect, it } from 'vitest';
import type { EquityPoint, Trade } from '../src/engine/artifacts.js';
import { evaluateWindow, type CompletedOutcome } from '../src/engine/window-eval.js';

const DAY = 86_400_000;
function pt(day: number, equity: number): EquityPoint { return { barIndex: day, barTs: day * DAY, equity }; }
function trade(entryDay: number, exitDay: number, pnl: number): Trade {
  return { id: `t${entryDay}`, symbol: 'BTCUSDT', side: 'long', entryBarIndex: 0, entryTs: entryDay * DAY,
    entryFillPrice: 100, exitBarIndex: 1, exitTs: exitDay * DAY, exitFillPrice: 100 + pnl, size: 1, feePaid: 0,
    realizedPnl: pnl, closeReason: 'end_of_data' } as Trade;
}
function outcome(eq: EquityPoint[], tr: Trade[]): CompletedOutcome {
  return { status: 'completed', baseline: { trades: tr, evidence: { equityCurve: eq } } } as unknown as CompletedOutcome;
}
const window = { from: new Date(2 * DAY).toISOString(), to: new Date(4 * DAY).toISOString() };

describe('evaluateWindow', () => {
  it('anchors equity (last point before from) + counts warmup steps + filters fully-in-test trades', () => {
    const r = evaluateWindow(
      outcome([pt(0, 100), pt(1, 110), pt(2, 120), pt(3, 130)], [trade(2.2, 3.2, 5), trade(1, 2.5, 9)]),
      window, ['total_trades'],
    );
    // anchor = pt(1) (last < 2d); within = pt(2), pt(3) ⇒ 3 points
    expect(r.equity.map((p) => p.barIndex)).toEqual([1, 2, 3]);
    // warmup = distinct equity steps with barTs < window.from (days 0,1) ⇒ 2
    expect(r.warmupSteps).toBe(2);
    // in-test trade = entry>=2d && exit<4d ⇒ only trade(2.2,3.2); trade(1,2.5) is carry-in
    expect(r.metrics.total_trades).toBe(1);
    expect(r.carryInClosedTradeCount).toBe(1);
  });
  it('warmup counts DISTINCT barTs, not raw equity points (multi-symbol tape)', () => {
    // two equity points on the SAME pre-window barTs (day 1) ⇒ ONE warmup step, not two
    const r = evaluateWindow(
      outcome([pt(1, 100), { barIndex: 1, barTs: 1 * DAY, equity: 101 }, pt(2, 120), pt(3, 130)], []),
      window, ['total_trades'],
    );
    expect(r.warmupSteps).toBe(1);
  });
});
