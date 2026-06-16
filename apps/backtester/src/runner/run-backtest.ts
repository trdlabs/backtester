// Deterministic runner for the Slice 1 golden smoke path, now driven by a ModuleExecutor seam.
//
// The runner owns sizing / execution / metrics (trusted); the executor only supplies per-bar long/flat
// signals. With the default TrustedMomentumExecutor the output is byte-identical to Slice 1/2 (the
// golden result_hash is unchanged). With a SandboxModuleExecutor the same loop consumes signals from an
// untrusted bundle — so the result is a pure function of (bundle, data, seed), independent of the
// sandbox environment. This is still NOT a lift of the platform engine; the seam is `(request, deps)`.

import type { BacktestRunRequest, ReaderRow, RunMode } from '@trading/research-contracts';
import { quantize } from '../determinism/canonical-json';
import { createSeededRng } from '../determinism/rng';
import type { MaterializedDataset } from '../data/reader';
import { TrustedMomentumExecutor, type ModuleExecutor } from './module-executor';

const INITIAL_EQUITY = 10_000;

export interface RunDeps {
  readonly dataset: MaterializedDataset;
  /** Defaults to the trusted in-process momentum executor. */
  readonly executor?: ModuleExecutor;
  /** Content hash of the executed bundle (sandboxed runs) — recorded in evidence. */
  readonly bundleHash?: string;
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
    readonly bundleHash?: string;
  };
}

interface SymbolSim {
  equity: number;
  longBars: number;
  wins: number;
  trades: TradeRecord[];
}

/** Apply long/flat signals to candles: a long bar `i` captures bar `i`'s close-to-close return. */
function simulateSymbol(
  symbol: string,
  candles: readonly ReaderRow[],
  signals: readonly boolean[],
): SymbolSim {
  const sim: SymbolSim = { equity: INITIAL_EQUITY, longBars: 0, wins: 0, trades: [] };
  for (let i = 2; i < candles.length; i++) {
    const prev = candles[i - 1]!;
    const cur = candles[i]!;
    if (!signals[i] || prev.close === 0) continue;
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

export async function runBacktest(request: BacktestRunRequest, deps: RunDeps): Promise<BacktestResult> {
  const executor = deps.executor ?? new TrustedMomentumExecutor();
  const symbols = deps.dataset.symbols();
  const series = symbols.map((symbol) => ({ symbol, candles: deps.dataset.candles(symbol) }));
  const signalMap = await executor.computeSignals(series, request.seed);

  let pnl = 0;
  let totalBars = 0;
  let longBars = 0;
  let wins = 0;
  const trades: TradeRecord[] = [];

  for (const symbol of symbols) {
    const candles = deps.dataset.candles(symbol);
    const signals = signalMap.get(symbol) ?? [];
    const sim = simulateSymbol(symbol, candles, signals);
    pnl += sim.equity - INITIAL_EQUITY;
    totalBars += Math.max(0, candles.length - 2);
    longBars += sim.longBars;
    wins += sim.wins;
    trades.push(...sim.trades);
  }

  const denom = INITIAL_EQUITY * Math.max(1, symbols.length);
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
    if (name in full) metrics[name] = full[name]!;
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
      ...(deps.bundleHash !== undefined ? { bundleHash: deps.bundleHash } : {}),
    },
  };
}
