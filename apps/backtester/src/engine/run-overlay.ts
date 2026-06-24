import { runBacktest } from './runner.js';
import type { ExecutorRouter } from './module-executor.js';
import type { TrustedModuleRegistry } from './registry.js';
import type { MarketTapeDataset } from '@trading/research-contracts/research';
import type { BacktestRunRequest } from '@trading/research-contracts';
import type { RunOutcome } from './artifacts.js';

export interface OverlayRunDeps {
  readonly registry: TrustedModuleRegistry;
  readonly marketTape?: MarketTapeDataset;
  readonly router?: ExecutorRouter;
}

/**
 * Trusted overlay run. Strips the backtester-only `engine` discriminator BEFORE the lifted runner
 * (and its 017 backtest-run-request validation, additionalProperties:false) — `engine` is not a 017
 * field and must never reach the engine or the hashed RunOutcome (platform parity).
 */
export async function runOverlayBacktest(request: BacktestRunRequest, deps: OverlayRunDeps): Promise<RunOutcome> {
  const { engine: _engine, ...engineRequest } = request;
  return await runBacktest(engineRequest, {
    registry: deps.registry,
    marketTape: deps.marketTape,
    ...(deps.router ? { router: deps.router } : {}),
  });
}
