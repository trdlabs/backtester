import { describe, expect, it } from 'vitest';
import { compareBacktestRuns } from '../src/engine/equivalence.js';
import type { RunOutcome, Trade } from '../src/engine/artifacts.js';

// Minimal Trade stub using REAL field names:
//   entryFillPrice (not entryPrice), exitFillPrice (not exitPrice), realizedPnl (not pnlPct).
function trade(over: Partial<Trade>): Trade {
  return {
    id: 'test',
    symbol: 'BTC',
    side: 'long',
    entryBarIndex: 0,
    entryTs: 1,
    entryFillPrice: 100,
    exitBarIndex: 1,
    exitTs: 2,
    exitFillPrice: 110,
    size: 1,
    feePaid: 0,
    realizedPnl: 10,
    closeReason: 'end_of_data',
    ...over,
  } as Trade;
}

function completed(trades: Trade[]): RunOutcome {
  return {
    status: 'completed',
    baseline: { trades, evidence: { equityCurve: [] } } as any,
    variant: null,
    comparison: null,
  };
}

describe('compareBacktestRuns', () => {
  it('идентичные прогоны эквивалентны', () => {
    const a = completed([trade({})]);
    const r = compareBacktestRuns(a, completed([trade({})]));
    expect(r.equivalent).toBe(true);
    expect(r.resultHashMatch).toBe(true);
  });

  it('расхождение в realizedPnl → первый расходящийся бар + diff', () => {
    const curated = completed([trade({}), trade({ entryTs: 3, exitTs: 4, realizedPnl: 5 })]);
    const candidate = completed([trade({}), trade({ entryTs: 3, exitTs: 4, realizedPnl: 7 })]);
    const r = compareBacktestRuns(curated, candidate);
    expect(r.equivalent).toBe(false);
    expect(r.firstDivergence).toEqual({ index: 1, field: 'realizedPnl', expected: 5, actual: 7 });
  });

  it('разное число сделок → не эквивалентны', () => {
    const r = compareBacktestRuns(completed([trade({})]), completed([]));
    expect(r.equivalent).toBe(false);
    expect(r.candidateTradeCount).toBe(0);
  });

  it('rejected-прогон → не эквивалентен', () => {
    const rej = { status: 'rejected', validation: { issues: [] } } as RunOutcome;
    expect(compareBacktestRuns(rej, completed([])).equivalent).toBe(false);
  });
});
