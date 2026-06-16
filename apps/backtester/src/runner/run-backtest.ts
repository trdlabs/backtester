// Minimal deterministic runner for the Slice 1 golden smoke path.
//
// This is intentionally a small momentum simulation — NOT a lift of the full platform engine. Its job
// is to exercise the determinism machinery end to end (seeded RNG + decimal-quantized metrics +
// canonical-JSON result_hash) so the real `runBacktest` from trading-platform `src/research/backtest`
// can later drop into the same `(request, deps) => result` seam without touching the service around it.

import type { BacktestRunRequest, RunMode } from '@trading/research-contracts';
import { quantize } from '../determinism/canonical-json';
import { createSeededRng } from '../determinism/rng';
import type { MaterializedDataset } from '../data/reader';

const INITIAL_EQUITY = 10_000;

export interface RunDeps {
  readonly dataset: MaterializedDataset;
}

export interface TradeRecord {
  readonly symbol: string;
  readonly barIndex: number;
  readonly entryTs: number;
  readonly entryClose: number;
  readonly exitClose: number;
  readonly ret: number;
}

export interface BacktestResult {
  readonly runId: string;
  readonly mode: RunMode;
  readonly runKind: 'baseline-only';
  readonly status: 'completed';
  readonly metrics: Record<string, number>;
  readonly trades: readonly TradeRecord[];
  readonly evidence: {
    readonly seed: number;
    readonly datasetRef: string;
    readonly moduleRef: { id: string; version: string };
  };
}

interface SymbolSim {
  equity: number;
  longBars: number;
  wins: number;
  trades: TradeRecord[];
}

/**
 * Trivial momentum: a bar is "long" when the previous bar closed up vs. the bar before it; the long
 * bar then captures that bar's close-to-close return. Pure over `(candles, logic)` — deterministic.
 */
function simulateSymbol(dataset: MaterializedDataset, symbol: string): SymbolSim {
  const candles = dataset.candles(symbol);
  const sim: SymbolSim = { equity: INITIAL_EQUITY, longBars: 0, wins: 0, trades: [] };
  for (let i = 2; i < candles.length; i++) {
    const prevPrev = candles[i - 2];
    const prev = candles[i - 1];
    const cur = candles[i];
    const signalLong = prev.close > prevPrev.close;
    if (!signalLong || prev.close === 0) continue;
    const ret = (cur.close - prev.close) / prev.close;
    sim.equity = sim.equity * (1 + ret);
    sim.longBars += 1;
    if (ret > 0) sim.wins += 1;
    sim.trades.push({
      symbol,
      barIndex: i,
      entryTs: cur.minute_ts,
      entryClose: quantize(prev.close),
      exitClose: quantize(cur.close),
      ret: quantize(ret),
    });
  }
  return sim;
}

export function runBacktest(request: BacktestRunRequest, deps: RunDeps): BacktestResult {
  const symbols = deps.dataset.symbols();
  let pnl = 0;
  let totalBars = 0;
  let longBars = 0;
  let wins = 0;
  const trades: TradeRecord[] = [];

  for (const symbol of symbols) {
    const sim = simulateSymbol(deps.dataset, symbol);
    pnl += sim.equity - INITIAL_EQUITY;
    totalBars += Math.max(0, deps.dataset.candles(symbol).length - 2);
    longBars += sim.longBars;
    wins += sim.wins;
    trades.push(...sim.trades);
  }

  const denom = INITIAL_EQUITY * Math.max(1, symbols.length);
  // A single deterministic RNG draw proves the seeded-randomness path is wired (echoed, not used in sim).
  const seedProbe = createSeededRng(request.seed).next();

  const full: Record<string, number> = {
    pnl: quantize(pnl),
    return_pct: quantize((pnl / denom) * 100),
    total_bars: totalBars,
    long_bars: longBars,
    win_rate: quantize(longBars > 0 ? wins / longBars : 0),
    seed_probe: quantize(seedProbe),
  };

  const requested = request.metrics.length > 0 ? request.metrics : Object.keys(full);
  const metrics: Record<string, number> = {};
  for (const name of [...requested].sort()) {
    if (name in full) metrics[name] = full[name];
  }

  return {
    runId: request.runId,
    mode: request.mode,
    runKind: 'baseline-only',
    status: 'completed',
    metrics,
    trades,
    evidence: {
      seed: request.seed,
      datasetRef: request.datasetRef,
      moduleRef: { id: request.moduleRef.id, version: request.moduleRef.version },
    },
  };
}
