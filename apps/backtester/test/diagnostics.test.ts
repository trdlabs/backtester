// E1b — pure run diagnostics: deterministic fact vector + engine-derivable flags.

import { describe, expect, it } from 'vitest';
import type { EquityPoint, Trade } from '../src/engine/artifacts.js';
import { computeRunDiagnostics } from '../src/engine/diagnostics.js';

function trade(i: number, entryBar: number, exitBar: number, realizedPnl: number): Trade {
  return {
    id: `t${i}`,
    symbol: 'BTCUSDT',
    side: realizedPnl >= 0 ? 'long' : 'short',
    entryBarIndex: entryBar,
    entryTs: entryBar * 60_000,
    entryFillPrice: 100,
    exitBarIndex: exitBar,
    exitTs: exitBar * 60_000,
    exitFillPrice: 100 + realizedPnl,
    size: 1,
    feePaid: 0,
    realizedPnl,
    closeReason: 'end_of_data',
  };
}

function eq(values: readonly number[]): EquityPoint[] {
  return values.map((equity, i) => ({ barIndex: i, barTs: i * 60_000, equity }));
}

const POLICY = { minTrades: 30, concentrationPct: 80 };

describe('computeRunDiagnostics — facts', () => {
  // 3 trades: bars 2+1+3=6 of 10; pnl 30/-10/5 ⇒ 2 win 1 loss; top 30/35=85.71%; returns 4.
  const trades = [trade(0, 0, 2, 30), trade(1, 3, 4, -10), trade(2, 5, 8, 5)];
  const equity = eq([100, 110, 105, 115, 112]);
  const input = { trades, equity, barsProcessed: 10, orderCount: 6, policy: POLICY };

  it('computes the exact fact vector', () => {
    const d = computeRunDiagnostics(input);
    expect(d.facts.tradeCount).toBe(3);
    expect(d.facts.orderCount).toBe(6);
    expect(d.facts.barsProcessed).toBe(10);
    expect(d.facts.exposureFraction).toBeCloseTo(0.6, 8);
    expect(d.facts.winningTrades).toBe(2);
    expect(d.facts.losingTrades).toBe(1);
    expect(d.facts.topTradeContributionPct).toBeCloseTo(85.71428571, 8);
    expect(d.facts.returnsCount).toBe(4);
  });

  it('echoes the policy for provenance', () => {
    expect(computeRunDiagnostics(input).policy).toEqual(POLICY);
  });

  it('exposureFraction may exceed 1 with concurrent positions', () => {
    const d = computeRunDiagnostics({
      trades: [trade(0, 0, 5, 1), trade(1, 2, 7, 1)], // 5 + 5 position-bars over 8
      equity: eq([100, 101, 102]),
      barsProcessed: 8,
      orderCount: 4,
      policy: POLICY,
    });
    expect(d.facts.exposureFraction).toBeCloseTo(1.25, 8);
  });
});

describe('computeRunDiagnostics — flags', () => {
  const equity = eq([100, 110, 105, 115, 112]);

  it('flags underpowered and single_trade_dominated for the base fixture', () => {
    const d = computeRunDiagnostics({
      trades: [trade(0, 0, 2, 30), trade(1, 3, 4, -10), trade(2, 5, 8, 5)],
      equity,
      barsProcessed: 10,
      orderCount: 6,
      policy: POLICY, // 3 < 30 ⇒ underpowered; 85.7 > 80 ⇒ concentrated
    });
    expect(d.flags).toEqual(['underpowered', 'single_trade_dominated']);
  });

  it('empty run ⇒ no_entries + underpowered + zero_exposure (stable order, no crash)', () => {
    const d = computeRunDiagnostics({ trades: [], equity: eq([100, 100]), barsProcessed: 10, orderCount: 0, policy: POLICY });
    expect(d.flags).toEqual(['no_entries', 'underpowered', 'zero_exposure']);
  });

  it('all_losing when every closed trade lost', () => {
    const d = computeRunDiagnostics({
      trades: [trade(0, 0, 1, -5), trade(1, 2, 3, -3)],
      equity,
      barsProcessed: 10,
      orderCount: 4,
      policy: POLICY,
    });
    expect(d.flags).toContain('all_losing');
    expect(d.flags).not.toContain('no_entries');
  });

  it('underpowered toggles strictly at minTrades', () => {
    const trades = [trade(0, 0, 1, 1), trade(1, 2, 3, 1), trade(2, 4, 5, 1)]; // 3 trades
    const base = { trades, equity, barsProcessed: 10, orderCount: 3 };
    expect(computeRunDiagnostics({ ...base, policy: { minTrades: 3, concentrationPct: 80 } }).flags).not.toContain(
      'underpowered',
    );
    expect(computeRunDiagnostics({ ...base, policy: { minTrades: 4, concentrationPct: 80 } }).flags).toContain(
      'underpowered',
    );
  });

  it('single_trade_dominated toggles around concentrationPct', () => {
    const trades = [trade(0, 0, 2, 30), trade(1, 3, 4, -10), trade(2, 5, 8, 5)]; // top 85.71%
    const base = { trades, equity, barsProcessed: 10, orderCount: 6 };
    expect(computeRunDiagnostics({ ...base, policy: { minTrades: 1, concentrationPct: 86 } }).flags).not.toContain(
      'single_trade_dominated',
    );
    expect(computeRunDiagnostics({ ...base, policy: { minTrades: 1, concentrationPct: 85 } }).flags).toContain(
      'single_trade_dominated',
    );
  });
});
