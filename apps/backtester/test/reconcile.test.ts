import { describe, expect, it } from 'vitest';
import type { CanonicalRowV2 } from '@trading/research-contracts/research';
import {
  closeToClosePnlPct,
  engineTradeToNormalized,
  makeReconcileReplayModule,
  paperToNormalized,
  reconcileTrades,
  type NormalizedTrade,
} from './helpers-reconcile.js';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tapeFromRows, type PaperTrade } from './helpers-replay.js';
import { runBacktest } from '../src/engine/runner.js';
import { createTrustedRouter } from '../src/engine/module-executor.js';
import { createModuleRegistry } from '../src/engine/sandbox/routing.js';
import { DEFAULT_RISK } from '../src/engine/profiles.js';
import type { BacktestRunRequest, ExecutionProfile } from '@trading/research-contracts/research';

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

  it('data_divergent (conservative): near-zero paper pnl + missing exit-minute row is NOT engine_divergent', () => {
    // paper run_terminated-style pnlPct 0; rows have an entry-minute row but NO exit-minute row (gap).
    const paper = [N({ symbol: 'AAA', side: 'long', entryTs: 1, exitTs: 5, closeReason: 'run_terminated', pnlPct: 0 })];
    const backtest = [N({ symbol: 'AAA', side: 'long', entryTs: 1, exitTs: 5, closeReason: 'time_exit', pnlPct: 0 })];
    const rows = { AAA: [{ minute_ts: 1, close: 100 } as unknown as CanonicalRowV2] }; // only the entry minute exists
    const r = reconcileTrades({ paper, backtest, rows, pnlPctTol: 1e-3 });
    expect(r.rows[0].status).toBe('data_divergent'); // NOT engine_divergent — exit-minute data is missing
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

// ────────────────────────────────────────────────────────────────────────────
// Real-engine self-test (Task 2): runs the reconcile-replay through the real
// backtester under the paper-match convention and asserts engineDivergent === 0.
// Fixture: apps/backtester/test/fixtures/exec-validation/long-oi-time-exit.json
// Symbols: BEATUSDT + SIRENUSDT (reproducible → matched), LABUSDT (data-divergent)
// ────────────────────────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(HERE, 'fixtures/exec-validation/long-oi-time-exit.json'), 'utf8'),
) as { trades: PaperTrade[]; rowsBySymbol: Record<string, CanonicalRowV2[]> };

/** Paper-match execution profile (mirrors helpers-replay.ts SAME_BAR_NO_COST; not exported there). */
const PAPER_MATCH: ExecutionProfile = {
  id: 'paper_match',
  version: '1.0.0',
  fillModel: { kind: 'same_bar_close' } as never,
  feeModel: { kind: 'fixed_bps', bps: 0 },
  slippageModel: { kind: 'fixed_bps', bps: 0 },
};

/**
 * Run the reconcile-replay through the real engine under the paper-match profile.
 * Mirrors replayPnlPct's runBacktest wiring (same registry/request shape).
 * Module = makeReconcileReplayModule (carries paper closeReason — prevents false divergence).
 */
async function runBacktestTrades(
  symbol: string,
  rows: CanonicalRowV2[],
  trades: PaperTrade[],
): Promise<NormalizedTrade[]> {
  const tape = tapeFromRows(symbol, rows);
  const mod = makeReconcileReplayModule(symbol, trades);
  const registry = createModuleRegistry({
    strategies: [mod],
    riskProfiles: [DEFAULT_RISK],
    executionProfiles: [PAPER_MATCH],
  });
  const req = {
    runId: `reconcile-${symbol}`,
    mode: 'research',
    moduleRef: { id: mod.manifest.id, version: '1.0.0' },
    datasetRef: symbol,
    symbols: [symbol],
    timeframe: '1m',
    period: {
      from: new Date(rows[0].minute_ts).toISOString(),
      to: new Date(rows[rows.length - 1].minute_ts + 60_000).toISOString(),
    },
    riskProfileRef: { id: 'default_risk', version: '1.0.0' },
    executionProfileRef: { id: 'paper_match', version: '1.0.0' },
    seed: 1,
    metrics: ['pnl'],
  } as unknown as BacktestRunRequest;

  const out = await runBacktest(req, { registry, marketTape: tape, router: createTrustedRouter() });
  if (out.status !== 'completed') {
    throw new Error(
      `reconcile run not completed: ${JSON.stringify('validation' in out ? out.validation : out)}`,
    );
  }

  return out.baseline.trades.map((t) => engineTradeToNormalized({ ...t, symbol }));
}

describe('reconcile — real engine self-test (sub#1 replay, paper convention)', () => {
  it('engine reproduces paper where data permits: engineDivergent===0, ambiguous===0, knowns are data_divergent', async () => {
    const bySymbol = new Map<string, PaperTrade[]>();
    for (const t of fixture.trades) {
      const arr = bySymbol.get(t.symbol) ?? [];
      arr.push(t);
      bySymbol.set(t.symbol, arr);
    }

    const backtest: NormalizedTrade[] = [];
    for (const [symbol, trades] of bySymbol) {
      const rows = fixture.rowsBySymbol[symbol];
      backtest.push(...(await runBacktestTrades(symbol, rows, trades)));
    }

    const paper = fixture.trades.map(paperToNormalized);
    const r = reconcileTrades({ paper, backtest, rows: fixture.rowsBySymbol, pnlPctTol: 1e-3 });

    expect(r.summary.ambiguous).toBe(0); // hard assertEmpty — corrupt-data sentinel
    expect(r.summary.engineDivergent).toBe(0); // engine reproduces paper where data permits

    // Known sub#1 data-divergent trade — snapshot bars ≠ paper engine's live fills
    const dataDivergentSymbols = r.rows
      .filter((x) => x.status === 'data_divergent')
      .map((x) => x.paper?.symbol);
    expect(dataDivergentSymbols).toEqual(expect.arrayContaining(['LABUSDT']));

    // Reproducible trades — matched by all criteria (exitTs + closeReason + pnlPct ≤ tol)
    const matchedSymbols = r.rows
      .filter((x) => x.status === 'matched')
      .map((x) => x.paper?.symbol);
    expect(matchedSymbols).toEqual(expect.arrayContaining(['BEATUSDT', 'SIRENUSDT']));

    expect(r.summary.matched + r.summary.dataDivergent).toBe(r.summary.total);
  });
});
