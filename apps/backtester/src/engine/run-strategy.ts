import { runBacktest } from './runner.js';
import type { ExecutorRouter } from './module-executor.js';
import type { TrustedModuleRegistry } from './registry.js';
import type { MarketTapeDataset } from '@trading/research-contracts/research';
import type { BacktestRunRequest } from '@trading/research-contracts';
import type { RunOutcome } from './artifacts.js';

export interface StrategyRunDeps {
  readonly registry: TrustedModuleRegistry;
  readonly marketTape?: MarketTapeDataset;
  readonly router?: ExecutorRouter;
  /** 17b: batch flat-stretch onBarClose calls into one sandbox message. Absent ⇒ lockstep. */
  readonly barBatching?: { readonly maxBars: number };
  /** 17d: bar-major execution mode — one bar across all symbols before advancing. Absent/false ⇒ symbol-major (byte-identical). */
  readonly barMajor?: boolean;
  /** Slice B: collapse bar-major per-bar IPC into 3-phase batched transport. Pure sub-mode of barMajor — inert unless barMajor is also on. Absent/false ⇒ no batching (byte-identical). */
  readonly barMajorBatch?: boolean;
  /** 17c: universe-session cap + scaled-policy memory knobs. Absent/disabled ⇒ no cap (byte-identical). */
  readonly universe?: { readonly enabled: boolean; readonly maxN: number; readonly memBaseMb: number; readonly memPerSymbolMb: number };
}

/**
 * Strategy-bundle run. Baseline = the submitted kind:'strategy' bundle (provenance:'bundle' → sandbox),
 * NO overlays (baseline-only). Strips the backtester-only `engine` discriminator AND `overlayRefs`
 * BEFORE the lifted runner (and its 017 backtest-run-request validation, additionalProperties:false) —
 * `engine` is not a 017 field and must never reach the engine or the hashed RunOutcome (platform parity).
 */
export async function runStrategyBacktest(
  request: BacktestRunRequest,
  deps: StrategyRunDeps,
): Promise<RunOutcome> {
  const { engine: _engine, overlayRefs: _overlayRefs, ...engineRequest } = request;
  return await runBacktest(engineRequest, {
    registry: deps.registry,
    marketTape: deps.marketTape,
    ...(deps.router ? { router: deps.router } : {}),
    ...(deps.barBatching ? { barBatching: deps.barBatching } : {}),
    ...(deps.barMajor ? { barMajor: true } : {}),
    ...(deps.barMajorBatch ? { barMajorBatch: true } : {}),
    ...(deps.universe ? { universe: deps.universe } : {}),
  });
}
