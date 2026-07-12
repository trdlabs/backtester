// Shared fixture wiring for the bar-major driver tests (Task 4). Modeled on
// twin-equivalence-multisymbol.test.ts: a trusted, Docker-free multi-symbol `runBacktest` setup via
// `createTrustedRouter` (module-executor.js), `createModuleRegistry` (sandbox/routing.js),
// `marketTapeFromCanonicalRows` (market-tape.js), and `DEFAULT_RISK` (profiles.js).
//
// The strategy is a stateful per-instance FSM (module-level closure via `moduleFactory`): each
// symbol's fresh instance enters long on the FIRST bar it observes, then stays idle. Per-symbol
// isolation gives every symbol its own entry — enough to produce a real, non-trivial equity curve
// (the position is force-closed mark-to-market at end-of-data by `finalizeSymbol`), while keeping
// the fixture deterministic and Docker-free.

import { createTrustedRouter } from '../../src/engine/module-executor.js';
import { createModuleRegistry } from '../../src/engine/sandbox/routing.js';
import { marketTapeFromCanonicalRows } from '../../src/engine/market-tape.js';
import { DEFAULT_RISK } from '../../src/engine/profiles.js';
import { contentRef } from '../../src/determinism/hash.js';
import type { RunDeps } from '../../src/engine/runner.js';
import type { RunOutcome } from '../../src/engine/artifacts.js';
import { CONTRACT_VERSION } from '@trading/research-contracts/research';
import type {
  BacktestRunRequest,
  CanonicalRowV2,
  ExecutionProfile,
  StrategyModule,
} from '@trading/research-contracts/research';

const SAME_BAR_NO_COST: ExecutionProfile = {
  id: 'paper_match',
  version: '1.0.0',
  fillModel: { kind: 'same_bar_close' } as never,
  feeModel: { kind: 'fixed_bps', bps: 0 },
  slippageModel: { kind: 'fixed_bps', bps: 0 },
};

const MANIFEST = {
  id: 'bar_major_probe',
  version: '1.0.0',
  kind: 'strategy',
  name: 'bar-major probe',
  summary: 'stateful per-symbol-instance long-entry probe for bar-major driver tests',
  rationale: 'deterministic, non-trivial multi-symbol equity curve without Docker',
  author: 'agent',
  contractVersion: CONTRACT_VERSION,
  status: 'research_only',
  paramsSchema: { type: 'object', additionalProperties: false, properties: {} },
  params: {},
  capabilities: { platformSdk: true },
  dataNeeds: {},
  hooks: ['onBarClose'],
} as const;

const CANDLES_PER_SYMBOL = 6;
const T0 = 1_700_000_000_000;

/** A stateful trusted strategy: enters long on the FIRST bar its instance ever observes, then idles. */
function makeStatefulFactory(): () => StrategyModule {
  return () => {
    let seen = 0;
    return {
      manifest: MANIFEST,
      onBarClose: () => (++seen === 1 ? { kind: 'enter', side: 'long' } : { kind: 'idle' }),
    } as unknown as StrategyModule;
  };
}

function rows(symbol: string, n: number, priceOffset: number): CanonicalRowV2[] {
  const out: CanonicalRowV2[] = [];
  for (let i = 0; i < n; i += 1) {
    const px = 100 + priceOffset + i * 2;
    out.push({
      schema_version: 2,
      minute_ts: T0 + i * 60_000,
      symbol,
      open: px,
      high: px + 1,
      low: px - 1,
      close: px,
      volume: 1000,
      turnover: px * 1000,
      oi_total_usd: null,
      funding_rate: null,
      liq_long_usd: null,
      liq_short_usd: null,
      has_oi: false,
      has_funding: false,
      has_liquidations: false,
      taker_buy_volume_usd: null,
      taker_sell_volume_usd: null,
      has_taker_flow: false,
    } as unknown as CanonicalRowV2);
  }
  return out;
}

const SYMBOL_PRICE_OFFSET: Record<string, number> = {
  BTCUSDT: 0,
  ETHUSDT: 37,
};

/** Deterministic `BacktestRunRequest` covering `symbols`, each with `CANDLES_PER_SYMBOL` bars. */
export function makeRequest(symbols: readonly string[]): BacktestRunRequest {
  return {
    runId: 'bar-major-fixture',
    mode: 'research',
    moduleRef: { id: MANIFEST.id, version: MANIFEST.version },
    datasetRef: 'bar-major-fixture',
    symbols: [...symbols],
    timeframe: '1m',
    period: {
      from: new Date(T0).toISOString(),
      to: new Date(T0 + CANDLES_PER_SYMBOL * 60_000).toISOString(),
    },
    riskProfileRef: { id: DEFAULT_RISK.id, version: DEFAULT_RISK.version },
    executionProfileRef: { id: SAME_BAR_NO_COST.id, version: SAME_BAR_NO_COST.version },
    seed: 1,
    metrics: ['pnl'],
  } as unknown as BacktestRunRequest;
}

/** Trusted `RunDeps` (Docker-free) for a multi-symbol run, with `barMajor` set per `opts`. */
export function makeMultiSymbolDeps(opts: { readonly barMajor: boolean; readonly barMajorBatch?: boolean }): RunDeps {
  const factory = makeStatefulFactory();
  const probe = factory();
  const registry = createModuleRegistry({
    strategies: [Object.assign(probe, { moduleFactory: factory })],
    riskProfiles: [DEFAULT_RISK],
    executionProfiles: [SAME_BAR_NO_COST],
  });

  const allRows = [
    ...rows('BTCUSDT', CANDLES_PER_SYMBOL, SYMBOL_PRICE_OFFSET.BTCUSDT),
    ...rows('ETHUSDT', CANDLES_PER_SYMBOL, SYMBOL_PRICE_OFFSET.ETHUSDT),
  ];
  const built = marketTapeFromCanonicalRows('bar-major-fixture', '1m', allRows);
  if (!built.ok) throw new Error('bar-major fixture tape build failed: ' + built.detail);

  return {
    registry,
    marketTape: built.tape,
    router: createTrustedRouter(),
    barMajor: opts.barMajor,
    barMajorBatch: opts.barMajorBatch,
  };
}

/** Hash the completed `RunOutcome.baseline` deterministically (same route as existing golden tests). */
export function resultHash(outcome: RunOutcome): string {
  if (outcome.status !== 'completed') {
    throw new Error('resultHash: expected a completed RunOutcome, got: ' + JSON.stringify('validation' in outcome ? outcome.validation : outcome));
  }
  return contentRef(outcome.baseline);
}
