import { describe, it, expect } from 'vitest';
import { runBacktest } from '../src/engine/runner.js';
import { createTrustedRouter } from '../src/engine/module-executor.js';
import { createModuleRegistry } from '../src/engine/sandbox/routing.js';
import { marketTapeFromCanonicalRows } from '../src/engine/market-tape.js';
import { DEFAULT_RISK } from '../src/engine/profiles.js';
import { shortAfterPump } from '../src/engine/examples/short-after-pump.strategy.js';
import type {
  BacktestRunRequest,
  CanonicalRowV2,
  ExecutionProfile,
  StrategyModule,
} from '@trading/research-contracts/research';

// Regression for the twin-equivalence multi-symbol divergence (long_oi 11-sym scale-up): the
// in-process (curated) path reused ONE strategy instance across all symbols, so a stateful FSM in
// the factory closure leaked across symbol boundaries — while the sandbox (candidate) path opens a
// fresh per-symbol session (fresh factory call → isolated state). Sandbox is correct; the in-process
// path must instantiate the strategy fresh per symbol. This test pins the corrected in-process
// behaviour without needing Docker.

const SAME_BAR_NO_COST: ExecutionProfile = {
  id: 'paper_match',
  version: '1.0.0',
  fillModel: { kind: 'same_bar_close' } as never,
  feeModel: { kind: 'fixed_bps', bps: 0 },
  slippageModel: { kind: 'fixed_bps', bps: 0 },
};

const MANIFEST = {
  ...shortAfterPump.manifest,
  id: 'stateful_probe',
  version: '1.0.0',
  name: 'stateful probe',
  hooks: ['onBarClose'],
};

/**
 * A stateful trusted strategy: module-level FSM in the factory closure that enters long on the FIRST
 * bar this instance ever observes, then stays idle. Per-symbol isolation ⇒ each symbol's fresh
 * instance enters on its own first bar (2 entries). A shared instance ⇒ only the first symbol enters
 * (state leaks; the counter is already past 1 by the time the second symbol starts).
 */
function makeStatefulFactory(): () => StrategyModule {
  return () => {
    let seen = 0;
    return {
      manifest: MANIFEST,
      onBarClose: () => (++seen === 1 ? { kind: 'enter', side: 'long' } : { kind: 'idle' }),
    } as unknown as StrategyModule;
  };
}

function rows(symbol: string, n: number): CanonicalRowV2[] {
  const out: CanonicalRowV2[] = [];
  const t0 = 1_700_000_000_000;
  for (let i = 0; i < n; i += 1) {
    const px = 100 + i;
    out.push({
      schema_version: 2,
      minute_ts: t0 + i * 60_000,
      symbol,
      open: px,
      high: px,
      low: px,
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

describe('twin-equivalence: per-symbol module-state isolation', () => {
  it('instantiates a fresh strategy instance per symbol (FSM state does not leak across symbols)', async () => {
    const factory = makeStatefulFactory();
    const allRows = [...rows('AAAUSDT', 4), ...rows('BBBUSDT', 4)];
    const built = marketTapeFromCanonicalRows('multi', '1m', allRows);
    if (!built.ok) throw new Error('tape build failed: ' + built.detail);

    const probe = factory();
    const registry = createModuleRegistry({
      strategies: [Object.assign(probe, { moduleFactory: factory })],
      riskProfiles: [DEFAULT_RISK],
      executionProfiles: [SAME_BAR_NO_COST],
    });

    const req = {
      runId: 'multi',
      mode: 'research',
      moduleRef: { id: MANIFEST.id, version: MANIFEST.version },
      datasetRef: 'multi',
      symbols: ['AAAUSDT', 'BBBUSDT'],
      timeframe: '1m',
      period: {
        from: new Date(1_700_000_000_000).toISOString(),
        to: new Date(1_700_000_000_000 + 10 * 60_000).toISOString(),
      },
      riskProfileRef: { id: DEFAULT_RISK.id, version: DEFAULT_RISK.version },
      executionProfileRef: { id: 'paper_match', version: '1.0.0' },
      seed: 1,
      metrics: ['pnl'],
    } as unknown as BacktestRunRequest;

    const out = await runBacktest(req, {
      registry,
      marketTape: built.tape,
      router: createTrustedRouter(),
    });
    if (out.status !== 'completed') {
      throw new Error('not completed: ' + JSON.stringify('validation' in out ? out.validation : out));
    }

    const enters = out.baseline.decisionRecords
      .filter((r) => r.baseDecision.kind === 'enter')
      .map((r) => r.symbol);
    // Each symbol enters once on its own first bar. Leaked shared state ⇒ ['AAAUSDT'] only.
    expect(enters).toEqual(['AAAUSDT', 'BBBUSDT']);
  });
});
