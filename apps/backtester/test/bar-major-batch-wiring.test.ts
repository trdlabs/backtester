// Task 6 (Slice B bar-major batch transport) — Docker-free wiring test for the config → app →
// worker → engine path. Mirrors bar-major-wiring.test.ts (Slice A) at the level of coverage
// exercisable without a sandbox container:
//   1. `loadConfig` parses `BACKTESTER_BAR_MAJOR_BATCH` into `AppConfig.barMajorBatch` (env → config hop).
//   2. `buildApp` threads `AppConfig.barMajorBatch` into `WorkerDeps.barMajorBatch` (config → app hop).
//   3. `runStrategyBacktest` folds `StrategyRunDeps.barMajorBatch` into the `RunDeps` handed to
//      `runBacktest` (engine fold hop) — proven by spying on the runner module's `runBacktest`
//      export, the same cross-named-import interception technique used in bar-major-wiring.test.ts.
// The remaining hop — `WorkerDeps.barMajorBatch` folded into `StrategyRunDeps` inside
// `processNextQueued`'s strategy branch (worker.ts, immediately below the `barMajor` fold) — is a
// one-line addition using the identical `...(deps.X === true ? { X: true } : {})` idiom as the
// (also untested-at-that-exact-seam) `barMajor` fold beside it; see task-6-report.md.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { testConfig } from './helpers.js';
import * as runnerModule from '../src/engine/runner.js';
import { runStrategyBacktest, type StrategyRunDeps } from '../src/engine/run-strategy.js';
import type { BacktestRunRequest } from '@trading/research-contracts';
import type { RunOutcome } from '../src/engine/artifacts.js';
import type { TrustedModuleRegistry } from '../src/engine/registry.js';

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
  vi.restoreAllMocks();
});

const FAKE_OUTCOME = {
  status: 'completed',
  baseline: {},
  variant: null,
  comparison: null,
} as unknown as RunOutcome;

const REQ = {
  runId: 'run-bar-major-batch-wiring',
  mode: 'research',
  moduleRef: { id: 'wiring', version: '1.0.0' },
  datasetRef: 'fake',
  symbols: ['TST'],
  timeframe: '1m',
  period: { from: '2023-01-01T00:00:00.000Z', to: '2023-01-01T01:00:00.000Z' },
  riskProfileRef: { id: 'default_risk', version: '1.0.0' },
  executionProfileRef: { id: 'default_exec', version: '1.0.0' },
  seed: 1,
  metrics: ['pnl'],
  engine: 'strategy',
} as unknown as BacktestRunRequest;

const FAKE_REGISTRY = {} as unknown as TrustedModuleRegistry;

describe('BACKTESTER_BAR_MAJOR_BATCH config parsing (env → config hop)', () => {
  it('defaults barMajorBatch to false', () => {
    expect(loadConfig({}).barMajorBatch).toBe(false);
  });

  it('parses BACKTESTER_BAR_MAJOR_BATCH=true', () => {
    expect(loadConfig({ BACKTESTER_BAR_MAJOR_BATCH: 'true' }).barMajorBatch).toBe(true);
  });
});

describe('buildApp barMajorBatch wiring (config → app hop)', () => {
  it('threads config.barMajorBatch:true into workerDeps.barMajorBatch', async () => {
    const app = await buildApp(testConfig({ barMajorBatch: true }));
    dispose = app.dispose;
    expect(app.workerDeps.barMajorBatch).toBe(true);
  });

  it('config.barMajorBatch:false (default) → workerDeps.barMajorBatch is false', async () => {
    const app = await buildApp(testConfig({ barMajorBatch: false }));
    dispose = app.dispose;
    expect(app.workerDeps.barMajorBatch).toBe(false);
  });
});

describe('runStrategyBacktest barMajorBatch fold (engine deps → RunDeps hop)', () => {
  it('threads barMajorBatch:true into the RunDeps handed to runBacktest', async () => {
    const spy = vi.spyOn(runnerModule, 'runBacktest').mockResolvedValue(FAKE_OUTCOME);
    const deps: StrategyRunDeps = { registry: FAKE_REGISTRY, barMajor: true, barMajorBatch: true };
    await runStrategyBacktest(REQ, deps);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ barMajorBatch: true });
  });

  it('barMajorBatch absent or false ⇒ RunDeps carries no barMajorBatch key (flag-off byte-identical)', async () => {
    const spy = vi.spyOn(runnerModule, 'runBacktest').mockResolvedValue(FAKE_OUTCOME);

    const depsAbsent: StrategyRunDeps = { registry: FAKE_REGISTRY };
    await runStrategyBacktest(REQ, depsAbsent);
    expect(spy.mock.calls[0]?.[1]).not.toHaveProperty('barMajorBatch');

    const depsFalse: StrategyRunDeps = { registry: FAKE_REGISTRY, barMajorBatch: false };
    await runStrategyBacktest(REQ, depsFalse);
    expect(spy.mock.calls[1]?.[1]).not.toHaveProperty('barMajorBatch');
  });
});
