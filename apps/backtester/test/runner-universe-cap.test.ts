// Task 8 (17c) — `maxUniverseN` pre-execution cap: reject a run whose symbol count exceeds the
// configured limit BEFORE any simulation/dispatch happens (SC-003 fail-fast; pre-exec, not the
// HTTP submit handler). Driven straight through `runBacktest` against a trusted in-process
// executor (no Docker/sandbox needed — the cap check runs before router/engine construction).
import { describe, expect, it } from 'vitest';
import { runBacktest, type RunDeps } from '../src/engine/runner.js';
import { createTrustedRegistry } from '../src/engine/registry.js';
import { createTrustedRouter } from '../src/engine/module-executor.js';
import type { CandleDataset } from '../src/engine/dataset.js';
import { DEFAULT_RISK, DEFAULT_EXEC } from '../src/engine/profiles.js';
import { shortAfterPump } from '../src/engine/examples/short-after-pump.strategy.js';
import type { BacktestRunRequest } from '@trading/research-contracts';
import type { Bar, StrategyModule } from '@trading/research-contracts/research';

const TS0 = 1_781_740_800_000;
const BAR_MS = 60_000;

function makeCandles(n: number): Bar[] {
  return Array.from({ length: n }, (_, i) => ({
    ts: TS0 + i * BAR_MS,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1000,
  })) as unknown as Bar[];
}

// P2-20: a multi-symbol trusted run requires a moduleFactory (per-symbol isolation). This module is
// stateless, so the factory returns a fresh equivalent instance — it lets the cap logic under test run.
function makeModule(): StrategyModule & { moduleFactory: () => StrategyModule } {
  const mk = (): StrategyModule => ({
    manifest: { ...shortAfterPump.manifest, id: 'universe-cap-mod', version: '1.0.0', name: 'universe-cap-mod', hooks: ['onBarClose'] },
    onBarClose: () => ({ kind: 'idle' }),
  } as unknown as StrategyModule);
  return Object.assign(mk(), { moduleFactory: mk });
}

function makeDataset(symbols: readonly string[], n: number): CandleDataset {
  const candles = makeCandles(n);
  return {
    datasetRef: 'fake',
    timeframe: '1m',
    symbols: () => symbols,
    candles: () => candles,
  };
}

function reqWithSymbols(count: number): BacktestRunRequest {
  const symbols = Array.from({ length: count }, (_, i) => `SYM${i}`);
  return {
    runId: `run-universe-cap-${count}`,
    mode: 'research',
    moduleRef: { id: 'universe-cap-mod', version: '1.0.0' },
    datasetRef: 'fake',
    symbols,
    timeframe: '1m',
    period: { from: new Date(TS0).toISOString(), to: new Date(TS0 + 5 * BAR_MS).toISOString() },
    riskProfileRef: { id: 'default_risk', version: '1.0.0' },
    executionProfileRef: { id: 'default_exec', version: '1.0.0' },
    seed: 1,
    metrics: ['pnl'],
  } as unknown as BacktestRunRequest;
}

function depsWithUniverse(universe: { enabled: boolean; maxN: number }): RunDeps {
  const module = makeModule();
  return {
    registry: createTrustedRegistry({ strategies: [module], riskProfiles: [DEFAULT_RISK], executionProfiles: [DEFAULT_EXEC] }),
    dataset: makeDataset(['SYM0', 'SYM1', 'SYM2'], 5),
    router: createTrustedRouter(),
    universe: { enabled: universe.enabled, maxN: universe.maxN, memBaseMb: 128, memPerSymbolMb: 8 },
  };
}

describe('runBacktest maxUniverseN', () => {
  it('rejects a run whose symbol count exceeds maxN (pre-exec, nothing spawned)', async () => {
    const out = await runBacktest(reqWithSymbols(3), depsWithUniverse({ enabled: true, maxN: 2 }));
    expect(out.status).toBe('rejected');
    expect(out.status === 'rejected' && out.validation.issues[0]?.message).toMatch(/universe|symbols|limit/i);
    expect(out.status === 'rejected' && out.validation.issues[0]?.path).toBe('/symbols');
  });

  it('does not reject when universe disabled or within maxN', async () => {
    expect((await runBacktest(reqWithSymbols(3), depsWithUniverse({ enabled: false, maxN: 2 }))).status).not.toBe('rejected');
    expect((await runBacktest(reqWithSymbols(2), depsWithUniverse({ enabled: true, maxN: 2 }))).status).not.toBe('rejected');
  });
});
