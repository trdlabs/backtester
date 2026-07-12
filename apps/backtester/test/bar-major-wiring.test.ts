// Task 7 (17d bar-major flag chain) — Docker-free wiring test for the config → app → worker →
// engine path. Mirrors the level of coverage the existing `barBatching` wiring has (no existing test
// drives `barBatching`/`barMajor` through `processNextQueued`'s strategy branch without Docker — see
// dedup-worker.test.ts's Docker-gated strategy suite for the only precedent at that seam). Proves the
// two hops that ARE exercisable without a sandbox container:
//   1. `buildApp` threads `AppConfig.barMajor` into `WorkerDeps.barMajor` (config → app hop).
//   2. `runStrategyBacktest` folds `StrategyRunDeps.barMajor` into the `RunDeps` handed to
//      `runBacktest` (engine fold hop) — proven by spying on the runner module's `runBacktest`
//      export, the exact same cross-named-import interception technique already used in this suite
//      (dedup-worker.test.ts: `vi.spyOn(runStrategyModule, 'runStrategyBacktest')`).
// The remaining hop — `WorkerDeps.barMajor` folded into `StrategyRunDeps` inside
// `processNextQueued`'s strategy branch (worker.ts, immediately below the `barBatching` fold) — is a
// one-line addition using the identical `...(deps.X === true ? { X: true } : {})` idiom as the
// (also untested-at-that-exact-seam) `barBatching` fold beside it; see task-7-report.md.
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  runId: 'run-bar-major-wiring',
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

describe('buildApp barMajor wiring (config → app hop)', () => {
  it('threads config.barMajor:true into workerDeps.barMajor', async () => {
    const app = await buildApp(testConfig({ barMajor: true }));
    dispose = app.dispose;
    expect(app.workerDeps.barMajor).toBe(true);
  });

  it('config.barMajor:false (default) → workerDeps.barMajor is false', async () => {
    const app = await buildApp(testConfig({ barMajor: false }));
    dispose = app.dispose;
    expect(app.workerDeps.barMajor).toBe(false);
  });
});

describe('runStrategyBacktest barMajor fold (engine deps → RunDeps hop)', () => {
  it('threads barMajor:true into the RunDeps handed to runBacktest', async () => {
    const spy = vi.spyOn(runnerModule, 'runBacktest').mockResolvedValue(FAKE_OUTCOME);
    const deps: StrategyRunDeps = { registry: FAKE_REGISTRY, barMajor: true };
    await runStrategyBacktest(REQ, deps);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ barMajor: true });
  });

  it('barMajor absent or false ⇒ RunDeps carries no barMajor key (flag-off byte-identical)', async () => {
    const spy = vi.spyOn(runnerModule, 'runBacktest').mockResolvedValue(FAKE_OUTCOME);

    const depsAbsent: StrategyRunDeps = { registry: FAKE_REGISTRY };
    await runStrategyBacktest(REQ, depsAbsent);
    expect(spy.mock.calls[0]?.[1]).not.toHaveProperty('barMajor');

    const depsFalse: StrategyRunDeps = { registry: FAKE_REGISTRY, barMajor: false };
    await runStrategyBacktest(REQ, depsFalse);
    expect(spy.mock.calls[1]?.[1]).not.toHaveProperty('barMajor');
  });
});
