/**
 * Deterministic paper↔backtest reconciliation report.
 * Loads the sub#1 exec-validation fixture, runs each symbol through the real engine
 * under the paper-match convention (makeReconcileReplayModule), calls reconcileTrades,
 * and prints a per-trade table + aggregate counts.
 *
 * Output is fully deterministic (sorted by symbol,entryTs; no timestamps/random).
 * Model: scripts/validate-execution.mts
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBacktest } from '../src/engine/runner.js';
import { createTrustedRouter } from '../src/engine/module-executor.js';
import { createModuleRegistry } from '../src/engine/sandbox/routing.js';
import { DEFAULT_RISK } from '../src/engine/profiles.js';
import {
  engineTradeToNormalized,
  makeReconcileReplayModule,
  paperToNormalized,
  reconcileTrades,
  type NormalizedTrade,
} from '../test/helpers-reconcile.js';
import { tapeFromRows, type PaperTrade } from '../test/helpers-replay.js';
import type { BacktestRunRequest, CanonicalRowV2, ExecutionProfile } from '@trading/research-contracts/research';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(
  HERE,
  '../test/fixtures/exec-validation/long-oi-time-exit.json',
);

/** Paper-match execution profile (mirrors helpers-replay.ts SAME_BAR_NO_COST; not exported there). */
const PAPER_MATCH: ExecutionProfile = {
  id: 'paper_match',
  version: '1.0.0',
  fillModel: { kind: 'same_bar_close' } as never,
  feeModel: { kind: 'fixed_bps', bps: 0 },
  slippageModel: { kind: 'fixed_bps', bps: 0 },
};

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

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

async function main() {
  let fixture: { trades: PaperTrade[]; rowsBySymbol: Record<string, CanonicalRowV2[]> };
  try {
    fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
  } catch (e: any) {
    console.error(`[reconcile-report] fixture not found: ${FIXTURE_PATH}`);
    process.exit(1);
  }

  // Group paper trades by symbol
  const bySymbol = new Map<string, PaperTrade[]>();
  for (const t of fixture.trades) {
    const arr = bySymbol.get(t.symbol) ?? [];
    arr.push(t);
    bySymbol.set(t.symbol, arr);
  }

  // Run engine replay per symbol (sorted for determinism)
  const backtest: NormalizedTrade[] = [];
  for (const symbol of [...bySymbol.keys()].sort()) {
    const trades = bySymbol.get(symbol)!;
    const rows = fixture.rowsBySymbol[symbol];
    backtest.push(...(await runBacktestTrades(symbol, rows, trades)));
  }

  const paper = fixture.trades.map(paperToNormalized);
  const r = reconcileTrades({ paper, backtest, rows: fixture.rowsBySymbol, pnlPctTol: 1e-3 });

  // Sort rows by (symbol, entryTs) for deterministic output
  const sorted = [...r.rows].sort((a, b) => {
    const sa = a.paper?.symbol ?? a.backtest?.symbol ?? '';
    const sb = b.paper?.symbol ?? b.backtest?.symbol ?? '';
    if (sa !== sb) return sa < sb ? -1 : 1;
    const ta = a.paper?.entryTs ?? a.backtest?.entryTs ?? 0;
    const tb = b.paper?.entryTs ?? b.backtest?.entryTs ?? 0;
    return ta - tb;
  });

  console.log('\n============== RECONCILIATION REPORT (paper ↔ backtest, paper-match) ==============');
  console.log('Fixture: apps/backtester/test/fixtures/exec-validation/long-oi-time-exit.json');
  console.log('');

  // Per-trade table header
  const COL = { key: 42, status: 18, exitTsMatch: 10, crMatch: 9, pnlDelta: 12, note: 0 };
  const header =
    pad('key', COL.key) +
    pad('status', COL.status) +
    pad('exitTs?', COL.exitTsMatch) +
    pad('closeR?', COL.crMatch) +
    pad('pnlPctΔ', COL.pnlDelta) +
    'note';
  console.log(header);
  console.log('-'.repeat(header.length + 20));

  for (const row of sorted) {
    const exitTsMatch =
      row.deltas !== undefined ? (row.deltas.exitTsMatch ? 'yes' : 'NO') : 'n/a';
    const crMatch =
      row.deltas !== undefined ? (row.deltas.closeReasonMatch ? 'yes' : 'NO') : 'n/a';
    const pnlDelta =
      row.deltas !== undefined ? row.deltas.pnlPctDelta.toFixed(6) : 'n/a';
    const note = row.note ?? '';
    console.log(
      pad(row.key, COL.key) +
      pad(row.status, COL.status) +
      pad(exitTsMatch, COL.exitTsMatch) +
      pad(crMatch, COL.crMatch) +
      pad(pnlDelta, COL.pnlDelta) +
      note,
    );
  }

  // Aggregate block
  const s = r.summary;
  console.log('');
  console.log('─── Aggregate ───────────────────────────────────────────────────────────────────');
  console.log(`  total          : ${s.total}`);
  console.log(`  matched        : ${s.matched}`);
  console.log(`  data_divergent : ${s.dataDivergent}`);
  console.log(`  engine_divergent: ${s.engineDivergent}`);
  console.log(`  paper_only     : ${s.paperOnly}`);
  console.log(`  backtest_only  : ${s.backtestOnly}`);
  console.log(`  ambiguous      : ${s.ambiguous}`);
  console.log(`  matchRate      : ${(s.matchRate * 100).toFixed(1)}%`);
  console.log('═════════════════════════════════════════════════════════════════════════════════');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
