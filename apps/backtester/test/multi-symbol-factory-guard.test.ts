// P2-20 — a multi-symbol TRUSTED in-process run reuses ONE module object across symbols (the
// non-factory branch in simulateTarget/runBarMajor), so a stateful module leaks state between symbols
// and diverges from the per-symbol-isolated sandbox twin. runBacktest fails-fast: N>1 requires a
// moduleFactory. Single-symbol runs and factory-carrying strategies are unaffected; bundle (sandbox)
// strategies are exempt (one isolated session per symbol). Pure in-process — no Docker.
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

const makeCandles = (n: number): Bar[] =>
  Array.from({ length: n }, (_, i) => ({ ts: TS0 + i * BAR_MS, open: 100, high: 101, low: 99, close: 100, volume: 1000 })) as unknown as Bar[];

const bareModule = (): StrategyModule =>
  ({
    manifest: { ...shortAfterPump.manifest, id: 'guard-mod', version: '1.0.0', name: 'guard-mod', hooks: ['onBarClose'] },
    onBarClose: () => ({ kind: 'idle' }),
  } as unknown as StrategyModule);

const dataset = (symbols: readonly string[]): CandleDataset => ({
  datasetRef: 'fake',
  timeframe: '1m',
  symbols: () => symbols,
  candles: () => makeCandles(5),
});

function req(count: number): BacktestRunRequest {
  return {
    runId: `p2-20-${count}`,
    mode: 'research',
    moduleRef: { id: 'guard-mod', version: '1.0.0' },
    datasetRef: 'fake',
    symbols: Array.from({ length: count }, (_, i) => `SYM${i}`),
    timeframe: '1m',
    period: { from: new Date(TS0).toISOString(), to: new Date(TS0 + 5 * BAR_MS).toISOString() },
    riskProfileRef: { id: 'default_risk', version: '1.0.0' },
    executionProfileRef: { id: 'default_exec', version: '1.0.0' },
    seed: 1,
    metrics: ['pnl'],
  } as unknown as BacktestRunRequest;
}

function deps(module: StrategyModule): RunDeps {
  return {
    registry: createTrustedRegistry({ strategies: [module], riskProfiles: [DEFAULT_RISK], executionProfiles: [DEFAULT_EXEC] }),
    dataset: dataset(['SYM0', 'SYM1', 'SYM2']),
    router: createTrustedRouter(),
  };
}

describe('P2-20 — multi-symbol trusted run requires a moduleFactory', () => {
  it('rejects a multi-symbol trusted run whose strategy has NO moduleFactory', async () => {
    const out = await runBacktest(req(3), deps(bareModule()));
    expect(out.status).toBe('rejected');
    if (out.status === 'rejected') {
      expect(out.validation.issues[0]?.code).toBe('invalid_module_ref');
      expect(out.validation.issues[0]?.path).toBe('/symbols');
      expect(out.validation.issues[0]?.message).toMatch(/moduleFactory/);
    }
  });

  it('does NOT reject a SINGLE-symbol trusted run without a moduleFactory (reuse is safe for one symbol)', async () => {
    const single = { ...req(1), symbols: ['SYM0'] } as BacktestRunRequest;
    const out = await runBacktest(single, deps(bareModule()));
    expect(out.status).not.toBe('rejected');
  });

  it('does NOT reject a multi-symbol trusted run WITH a moduleFactory (per-symbol isolation provided)', async () => {
    const withFactory = Object.assign(bareModule(), { moduleFactory: () => bareModule() });
    const out = await runBacktest(req(3), deps(withFactory as unknown as StrategyModule));
    expect(out.status).not.toBe('rejected');
  });

  // Regression: provenance is metadata, not a privilege. A forged/incomplete resolved strategy claiming
  // provenance:'bundle' but carrying NO bundle handle would run TRUSTED in-process (the router routes to
  // the sandbox only when `provenance === 'bundle' && bundle !== undefined`), so it MUST still be
  // rejected — the guard mirrors the router's exact predicate.
  it('rejects a bundle-provenance strategy with NO bundle handle (guard mirrors the router predicate)', async () => {
    const module = bareModule();
    const forgedRegistry = {
      resolveStrategy: () => ({ module, manifest: module.manifest, provenance: 'bundle' as const }), // no bundle handle
      resolveOverlay: () => undefined,
      resolveRiskProfile: () => DEFAULT_RISK,
      resolveExecutionProfile: () => DEFAULT_EXEC,
    };
    const out = await runBacktest(req(3), {
      registry: forgedRegistry as unknown as RunDeps['registry'],
      dataset: dataset(['SYM0', 'SYM1', 'SYM2']),
      router: createTrustedRouter(),
    });
    expect(out.status).toBe('rejected');
    if (out.status === 'rejected') {
      expect(out.validation.issues[0]?.path).toBe('/symbols');
      expect(out.validation.issues[0]?.message).toMatch(/moduleFactory/);
    }
  });
});
