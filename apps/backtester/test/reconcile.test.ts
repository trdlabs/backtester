import { describe, expect, it } from 'vitest';
import type { CanonicalRowV2 } from '@trading/research-contracts/research';
import {
  closeToClosePnlPct,
  engineTradeToNormalized,
  reconcileTrades,
  type NormalizedTrade,
} from './helpers-reconcile.js';

const N = (o: Partial<NormalizedTrade> & { symbol: string; side: 'long' | 'short'; entryTs: number; exitTs: number; closeReason: string; pnlPct: number }): NormalizedTrade => o;

// minimal rows: two minutes whose closes reproduce a chosen long pnlPct
const rowsFor = (symbol: string, entryTs: number, exitTs: number, entryClose: number, exitClose: number): Record<string, CanonicalRowV2[]> => ({
  [symbol]: [
    { minute_ts: entryTs, close: entryClose } as unknown as CanonicalRowV2,
    { minute_ts: exitTs, close: exitClose } as unknown as CanonicalRowV2,
  ],
});

describe('reconcileTrades — taxonomy', () => {
  it('matched: exitTs + closeReason + pnlPct all within tol', () => {
    const paper = [N({ symbol: 'AAA', side: 'long', entryTs: 1, exitTs: 2, closeReason: 'tp2', pnlPct: 5 })];
    const backtest = [N({ symbol: 'AAA', side: 'long', entryTs: 1, exitTs: 2, closeReason: 'tp2', pnlPct: 5.0005 })];
    const r = reconcileTrades({ paper, backtest, rows: {}, pnlPctTol: 1e-3 });
    expect(r.rows[0].status).toBe('matched');
    expect(r.summary.matched).toBe(1);
    expect(r.summary.matchRate).toBe(1);
  });

  it('engine_divergent: pnlPct differs AND rows reproduce paper', () => {
    // paper long +5% (close 100→105); backtest says +2% → engine/strategy wrong, data is fine
    const paper = [N({ symbol: 'AAA', side: 'long', entryTs: 1, exitTs: 2, closeReason: 'tp2', pnlPct: 5 })];
    const backtest = [N({ symbol: 'AAA', side: 'long', entryTs: 1, exitTs: 2, closeReason: 'tp2', pnlPct: 2 })];
    const r = reconcileTrades({ paper, backtest, rows: rowsFor('AAA', 1, 2, 100, 105), pnlPctTol: 1e-3 });
    expect(r.rows[0].status).toBe('engine_divergent');
    expect(r.summary.engineDivergent).toBe(1);
  });

  it('data_divergent: pnlPct differs AND rows do NOT reproduce paper', () => {
    // paper +5% but rows say -1.76% (close 100→98.24) → data issue, not engine
    const paper = [N({ symbol: 'AAA', side: 'long', entryTs: 1, exitTs: 2, closeReason: 'time_exit', pnlPct: 5 })];
    const backtest = [N({ symbol: 'AAA', side: 'long', entryTs: 1, exitTs: 2, closeReason: 'time_exit', pnlPct: -1.76 })];
    const r = reconcileTrades({ paper, backtest, rows: rowsFor('AAA', 1, 2, 100, 98.24), pnlPctTol: 1e-3 });
    expect(r.rows[0].status).toBe('data_divergent');
    expect(r.summary.dataDivergent).toBe(1);
  });

  it('data_divergent (conservative): divergent but rows missing for the minute', () => {
    const paper = [N({ symbol: 'AAA', side: 'long', entryTs: 1, exitTs: 2, closeReason: 'tp2', pnlPct: 5 })];
    const backtest = [N({ symbol: 'AAA', side: 'long', entryTs: 1, exitTs: 2, closeReason: 'tp2', pnlPct: 2 })];
    const r = reconcileTrades({ paper, backtest, rows: {}, pnlPctTol: 1e-3 }); // no rows → cannot blame engine
    expect(r.rows[0].status).toBe('data_divergent');
    expect(r.rows[0].note).toMatch(/rows missing/i);
  });

  it('paper_only and backtest_only', () => {
    const paper = [N({ symbol: 'AAA', side: 'long', entryTs: 1, exitTs: 2, closeReason: 'tp2', pnlPct: 5 })];
    const backtest = [N({ symbol: 'BBB', side: 'long', entryTs: 9, exitTs: 10, closeReason: 'tp2', pnlPct: 1 })];
    const r = reconcileTrades({ paper, backtest, rows: {}, pnlPctTol: 1e-3 });
    const byStatus = Object.fromEntries(r.rows.map((x) => [x.status, x]));
    expect(byStatus.paper_only.paper!.symbol).toBe('AAA');
    expect(byStatus.backtest_only.backtest!.symbol).toBe('BBB');
    expect(r.summary.paperOnly).toBe(1);
    expect(r.summary.backtestOnly).toBe(1);
  });

  it('ambiguous: >1 trade on a single key (never silently greedy-paired)', () => {
    const paper = [
      N({ symbol: 'AAA', side: 'long', entryTs: 1, exitTs: 2, closeReason: 'tp2', pnlPct: 5 }),
      N({ symbol: 'AAA', side: 'long', entryTs: 1, exitTs: 3, closeReason: 'time_exit', pnlPct: 1 }),
    ];
    const r = reconcileTrades({ paper, backtest: [], rows: {}, pnlPctTol: 1e-3 });
    expect(r.rows[0].status).toBe('ambiguous');
    expect(r.summary.ambiguous).toBe(1);
  });
});

describe('engineTradeToNormalized — pnlPct from fillPrice, NOT realizedPnl (contract)', () => {
  it('uses side-aware fillPrice return even when realizedPnl would imply a different pct', () => {
    // long entry 100 → exit 110 = +10% on price; realizedPnl (USD, leveraged) is irrelevant to pnlPct
    const trade = { symbol: 'AAA', side: 'long', entryTs: 1, exitTs: 2, entryFillPrice: 100, exitFillPrice: 110, closeReason: 'tp2', realizedPnl: 999 } as never;
    expect(engineTradeToNormalized(trade).pnlPct).toBeCloseTo(10, 8);
    const short = { symbol: 'BBB', side: 'short', entryTs: 1, exitTs: 2, entryFillPrice: 100, exitFillPrice: 90, closeReason: 'tp2', realizedPnl: -5 } as never;
    expect(engineTradeToNormalized(short).pnlPct).toBeCloseTo(10, 8); // short profits when price falls
  });
});

describe('closeToClosePnlPct', () => {
  it('side-aware; undefined when a minute has no row', () => {
    const rows = [{ minute_ts: 1, close: 100 }, { minute_ts: 2, close: 105 }] as unknown as CanonicalRowV2[];
    expect(closeToClosePnlPct(rows, 1, 2, 'long')).toBeCloseTo(5, 8);
    expect(closeToClosePnlPct(rows, 1, 2, 'short')).toBeCloseTo(-5, 8);
    expect(closeToClosePnlPct(rows, 0, 2, 'long')).toBeUndefined(); // entryTs 0 is below the first minute → no floor row
    expect(closeToClosePnlPct([] as unknown as CanonicalRowV2[], 1, 2, 'long')).toBeUndefined();
  });
});
