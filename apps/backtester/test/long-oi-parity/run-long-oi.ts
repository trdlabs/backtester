import { runBacktest } from '../../src/engine/runner.js';
import { createTrustedRouter } from '../../src/engine/module-executor.js';
import { createModuleRegistry } from '../../src/engine/sandbox/routing.js';
import { DEFAULT_RISK } from '../../src/engine/profiles.js';
import { tapeFromRows } from '../helpers-replay.js';
import { LONG_OI_MODULE } from '../fixtures/strategies/long_oi/module.js';
import type {
  BacktestRunRequest,
  CanonicalRowV2,
  ExecutionProfile,
} from '@trading/research-contracts/research';

/**
 * Mirrors helpers-replay.ts's SAME_BAR_NO_COST exactly (not exported from that module).
 */
const SAME_BAR_NO_COST: ExecutionProfile = {
  id: 'paper_match',
  version: '1.0.0',
  fillModel: { kind: 'same_bar_close' } as never,
  feeModel: { kind: 'fixed_bps', bps: 0 },
  slippageModel: { kind: 'fixed_bps', bps: 0 },
};

export interface GeneratedTrade {
  entryTs: number;
  exitTs: number;
  side: 'long' | 'short';
  closeReason: string;
  entryFillPrice: number;
  exitFillPrice: number;
  pnlPct: number;
}

/**
 * Runs the REAL long_oi StrategyModule (vendored, Task 0) through the real engine
 * (`runBacktest`) over the given raw 1-minute rows and returns the generated trades.
 * Mirrors helpers-replay.ts::replayPnlPct's wiring verbatim, swapping the replay-stub
 * module for LONG_OI_MODULE — the signal-parity smoke test (Task 3, G7 Stage 1).
 */
export async function runLongOiOnRows(
  rows: CanonicalRowV2[],
  symbol: string,
): Promise<GeneratedTrade[]> {
  const tape = tapeFromRows(symbol, rows);
  const registry = createModuleRegistry({
    strategies: [LONG_OI_MODULE],
    riskProfiles: [DEFAULT_RISK],
    executionProfiles: [SAME_BAR_NO_COST],
  });
  const req = {
    runId: `long-oi-parity-${symbol}`,
    mode: 'research',
    moduleRef: { id: LONG_OI_MODULE.manifest.id, version: LONG_OI_MODULE.manifest.version },
    datasetRef: symbol,
    symbols: [symbol],
    timeframe: '1m',
    period: {
      from: new Date(rows[0].minute_ts).toISOString(),
      // Exclusive upper bound: +60_000 keeps the last minute bar in the run (matches helpers-replay.ts).
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
      `runBacktest rejected: ${JSON.stringify('validation' in out ? out.validation : out)}`,
    );
  }

  return out.baseline.trades.map((t) => ({
    entryTs: t.entryTs,
    exitTs: t.exitTs,
    side: t.side,
    closeReason: t.closeReason,
    entryFillPrice: t.entryFillPrice,
    exitFillPrice: t.exitFillPrice,
    pnlPct: ((t.exitFillPrice - t.entryFillPrice) / t.entryFillPrice) * 100,
  }));
}
