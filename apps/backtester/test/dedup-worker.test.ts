// Task 7 (result-dedup) — worker dedup-gate integration.
//
// Drives processNextQueued twice with the SAME momentum request (distinct runIds) through a shared
// InMemoryJobStore + InMemoryResultCache + InMemoryArtifactStore, asserting: a second identical run
// HITS the cache and re-stamps the cached template instead of re-running the engine — and performs
// NONE of the sandbox/executor/router/engine work (the compute-skip proof that catches an incomplete
// restructuring). Also: the deduped run is terminal-`completed` with a runId-stamped result_hash and a
// recorded `dedupedFrom`; the kill-switch (`dedupEnabled:false`) disables all of it; and a run whose
// engine throws ends `failed` and writes NO cache row.
//
// Momentum path only — Docker-free, mirrors the momentum wiring of worker-loop.test.ts /
// dedup-equivalence.test.ts (seed 42, smoke-btc-1m, BTCUSDT). Two identical requests share ONE
// requestFingerprint (the fingerprint is runId-independent by construction), which is what makes the
// second run's computeIdentity collide with the first.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { BacktestRunRequest, ModuleBundle, RunSubmitRequest } from '@trading/research-contracts';
import { InMemoryJobStore, type NewJob } from '../src/jobs/job-store.js';
import { processNextQueued, workerInternals, type WorkerDeps } from '../src/jobs/worker.js';
import { InMemoryArtifactStore } from '../src/artifacts/store.js';
import { InMemoryBundleStore } from '../src/sandbox/bundle-store.js';
import { FixtureDataPort, materialize } from '../src/data/reader.js';
import { FIXTURES_DIR } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { InMemoryResultCache } from '../src/jobs/dedup/result-cache.js';
import { contentRef } from '../src/determinism/hash.js';
import * as runBacktestModule from '../src/runner/run-backtest.js';
import * as runStrategyModule from '../src/engine/run-strategy.js';
import { buildOverlayDataset } from '../src/engine/data-adapter.js';
import {
  buildSandboxStrategyBaselineDeps,
  materializeReadableBundle,
} from './helpers-overlay-sandbox.js';
import { DOCKER_AVAILABLE } from './store-factories.js';

const CLOCK = 1_700_000_000_000;
// Two identical requests differ ONLY by runId ⇒ they share a runId-independent requestFingerprint.
const SHARED_FP = 'fp-momentum-shared';

const REQ = {
  mode: 'research',
  moduleRef: { id: 'smoke', version: '1.0.0' },
  datasetRef: 'smoke-btc-1m',
  symbols: ['BTCUSDT'],
  timeframe: '1m',
  period: { from: '2023-11-14T00:00:00.000Z', to: '2023-11-15T00:00:00.000Z' },
  seed: 42,
  metrics: [],
} as const;

function momentumJob(runId: string): NewJob {
  return {
    jobId: runId,
    runId,
    requestFingerprint: SHARED_FP,
    request: REQ as never,
    effectiveSeed: 42,
    datasetRef: 'smoke-btc-1m',
    runTimeoutMs: 3_600_000,
    acceptedAtMs: CLOCK,
  };
}

interface Ctx {
  store: InMemoryJobStore;
  cache: InMemoryResultCache;
  deps: WorkerDeps;
}

function makeCtx(opts: { dedupEnabled?: boolean } = {}): Ctx {
  const config = loadConfig();
  const store = new InMemoryJobStore();
  const cache = new InMemoryResultCache();
  const deps = {
    store,
    clock: () => CLOCK,
    uid: () => randomUUID(),
    postWebhook: async () => {},
    dataPort: new FixtureDataPort(FIXTURES_DIR),
    artifactStore: new InMemoryArtifactStore(),
    overlaySandbox: config.overlaySandbox,
    resultCache: cache,
    ...(opts.dedupEnabled !== undefined ? { dedupEnabled: opts.dedupEnabled } : {}),
  } as WorkerDeps;
  return { store, cache, deps };
}

async function enqueue(store: InMemoryJobStore, runId: string): Promise<void> {
  await store.insertOrGet(momentumJob(runId));
  await store.transition(runId, 'accepted', 'queued', { atMs: CLOCK, queuedAtMs: CLOCK });
}

// Fresh momentum run computed OUTSIDE the worker — the canonical hash a real run of runId Y produces.
async function loadMomentumDataset() {
  const port = new FixtureDataPort(FIXTURES_DIR);
  const reader = await port.openDataset('smoke-btc-1m');
  if (!reader) throw new Error('fixture missing');
  return materialize(reader, 'smoke-btc-1m', {
    tsFrom: 0,
    tsTo: Number.MAX_SAFE_INTEGER,
    symbols: ['BTCUSDT'],
  });
}
const momentumFreshRun = async (runId: string) =>
  runBacktestModule.runBacktest(
    { ...(REQ as unknown as BacktestRunRequest), runId },
    { dataset: await loadMomentumDataset() },
  );

afterEach(() => {
  vi.restoreAllMocks();
});

describe('worker dedup gate — momentum', () => {
  it('MISS then identical second run HITS: engine runs exactly ONCE; deduped run is completed, runId-stamped, records dedupedFrom', async () => {
    const { store, deps } = makeCtx({ dedupEnabled: true });
    const runSpy = vi.spyOn(runBacktestModule, 'runBacktest');

    await enqueue(store, 'run-AAAAAAAA');
    const a = await processNextQueued(deps); // MISS — runs engine, populates cache
    expect(a?.status).toBe('completed');
    expect(runSpy).toHaveBeenCalledTimes(1);

    await enqueue(store, 'run-BBBBBBBB');
    const b = await processNextQueued(deps); // HIT — must NOT re-run the engine
    expect(runSpy).toHaveBeenCalledTimes(1);

    expect(b?.status).toBe('completed');
    expect(b?.dedupedFrom).toBeDefined();
    // result_hash is runId-stamped ⇒ B's hash is NOT A's, but IS a fresh run(B)'s hash.
    expect(b?.resultHash).not.toBe(a?.resultHash);
    const freshHashB = contentRef(await momentumFreshRun('run-BBBBBBBB'));
    expect(b?.resultHash).toBe(freshHashB);
  });

  it('HIT performs NO sandbox/executor/router/engine work (compute-skip proof)', async () => {
    const { store, deps } = makeCtx({ dedupEnabled: true });
    const runSpy = vi.spyOn(runBacktestModule, 'runBacktest');
    const bundleSpy = vi.spyOn(workerInternals, 'sandboxBundleFor');
    const executorSpy = vi.spyOn(workerInternals, 'executorFor');
    const routerSpy = vi.spyOn(workerInternals, 'overlayRouterFor');

    await enqueue(store, 'run-AAAAAAAA');
    await processNextQueued(deps); // MISS
    // The miss-path DID build an executor + run the engine — proves the spies actually intercept.
    expect(executorSpy).toHaveBeenCalledTimes(1);
    expect(runSpy).toHaveBeenCalledTimes(1);

    bundleSpy.mockClear();
    executorSpy.mockClear();
    routerSpy.mockClear();
    runSpy.mockClear();

    await enqueue(store, 'run-BBBBBBBB');
    await processNextQueued(deps); // HIT
    expect(bundleSpy).not.toHaveBeenCalled();
    expect(executorSpy).not.toHaveBeenCalled();
    expect(routerSpy).not.toHaveBeenCalled();
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('kill-switch off (dedupEnabled:false): the second identical run ALSO runs the engine; nothing is cached', async () => {
    const { store, cache, deps } = makeCtx({ dedupEnabled: false });
    const runSpy = vi.spyOn(runBacktestModule, 'runBacktest');
    const putSpy = vi.spyOn(cache, 'put');

    await enqueue(store, 'run-AAAAAAAA');
    await processNextQueued(deps);
    await enqueue(store, 'run-BBBBBBBB');
    await processNextQueued(deps);

    expect(runSpy).toHaveBeenCalledTimes(2); // engine ran both times — no dedup
    expect(putSpy).not.toHaveBeenCalled(); // dedup off ⇒ no cache write
  });

  it('engine failure ends `failed` and writes NO cache row (only successful runs cache)', async () => {
    const { store, cache, deps } = makeCtx({ dedupEnabled: true });
    const putSpy = vi.spyOn(cache, 'put');
    vi.spyOn(runBacktestModule, 'runBacktest').mockRejectedValueOnce(new Error('boom'));

    await enqueue(store, 'run-AAAAAAAA');
    const a = await processNextQueued(deps);

    expect(a?.status).toBe('failed');
    expect(putSpy).not.toHaveBeenCalled();
  });
});

// -------------------------------------------------------------------------------------------------
// Bundle-carrying HIT path (Docker-gated) — closes the gap left by the momentum-only suite above:
// `sandboxSpy.not.toHaveBeenCalled()` only ever proved something for a request that never carries a
// bundle in the first place. The STRATEGY engine (kind:'strategy' lifecycle bundle, runs inside the
// sandbox — see strategy-route-worker.integration.test.ts) is the real bundle-carrying path Task 7's
// accepted partial is about. Skips cleanly with no Docker daemon (WSL2 dev machines); runs in CI —
// same DOCKER_AVAILABLE gate as dedup-equivalence.test.ts's strategy golden.
// -------------------------------------------------------------------------------------------------

const OVERLAY_REQUESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/overlay/requests');
const OVERLAY_BUNDLES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/overlay/bundles');

function loadOverlayRequest(name: string): BacktestRunRequest {
  return JSON.parse(readFileSync(resolve(OVERLAY_REQUESTS_DIR, name), 'utf8')) as BacktestRunRequest;
}
function loadInlineBundle(name: string): ModuleBundle {
  return JSON.parse(readFileSync(resolve(OVERLAY_BUNDLES_DIR, name), 'utf8')) as ModuleBundle;
}

// baseline.json: moduleRef short_after_pump@0.1.0, datasetRef 'pump-fixture-1m' — matches the bundle
// manifest below (strategy pre-flight validation requires moduleRef == manifest.id/version).
const { runId: _baselineRunId, ...STRATEGY_REQ_BASE } = loadOverlayRequest('baseline.json');
const STRATEGY_BUNDLE = loadInlineBundle('short-after-pump.bundle.json');
// Two requests differ ONLY by runId ⇒ share this runId-independent requestFingerprint (same
// construction as SHARED_FP above, mirrored for the strategy engine).
const SHARED_STRATEGY_FP = 'fp-strategy-shared';

describe.skipIf(!DOCKER_AVAILABLE)('worker dedup gate — strategy (bundle-carrying, Docker)', () => {
  it(
    'MISS then identical second run HITS: engine+router are skipped; bundle STILL loads (accepted partial)',
    async () => {
      const config = loadConfig();
      const store = new InMemoryJobStore();
      const cache = new InMemoryResultCache();
      const bundleStore = new InMemoryBundleStore();
      const bundleHash = await bundleStore.put(STRATEGY_BUNDLE);

      const deps = {
        store,
        clock: () => CLOCK,
        uid: () => randomUUID(),
        postWebhook: async () => {},
        dataPort: new FixtureDataPort(FIXTURES_DIR),
        artifactStore: new InMemoryArtifactStore(),
        bundleStore,
        overlaySandbox: config.overlaySandbox,
        resultCache: cache,
        dedupEnabled: true,
      } as WorkerDeps;

      function strategyJob(runId: string): NewJob {
        return {
          jobId: runId,
          runId,
          requestFingerprint: SHARED_STRATEGY_FP,
          request: {
            ...STRATEGY_REQ_BASE,
            engine: 'strategy',
            metrics: ['pnl', 'win_rate'],
          } as RunSubmitRequest,
          effectiveSeed: STRATEGY_REQ_BASE.seed,
          datasetRef: STRATEGY_REQ_BASE.datasetRef,
          bundleHash,
          runTimeoutMs: 3_600_000,
          acceptedAtMs: CLOCK,
        };
      }
      async function enqueueStrategy(runId: string): Promise<void> {
        await store.insertOrGet(strategyJob(runId));
        await store.transition(runId, 'accepted', 'queued', { atMs: CLOCK, queuedAtMs: CLOCK });
      }

      const runSpy = vi.spyOn(runStrategyModule, 'runStrategyBacktest');
      const bundleSpy = vi.spyOn(workerInternals, 'sandboxBundleFor');
      const routerSpy = vi.spyOn(workerInternals, 'overlayRouterFor');

      await enqueueStrategy('run-strat-AAAAAAAA');
      const a = await processNextQueued(deps); // MISS — real sandbox run, populates cache
      expect(a?.status).toBe('completed');
      expect(runSpy).toHaveBeenCalledTimes(1);
      expect(bundleSpy).toHaveBeenCalledTimes(1);
      expect(routerSpy).toHaveBeenCalledTimes(1);

      runSpy.mockClear();
      bundleSpy.mockClear();
      routerSpy.mockClear();

      await enqueueStrategy('run-strat-BBBBBBBB');
      const b = await processNextQueued(deps); // HIT

      // The expensive engine + sandbox EXECUTION is what dedup skips.
      expect(runSpy).not.toHaveBeenCalled();
      expect(routerSpy).not.toHaveBeenCalled();
      // accepted partial: bundle still loads early (strategy validation-before-materialization /
      // error-taxonomy); the expensive engine+sandbox EXECUTION is what dedup skips. Follow-up:
      // split load into validate-early + materialize-lazy.
      expect(bundleSpy).toHaveBeenCalledTimes(1);

      expect(b?.status).toBe('completed');
      expect(b?.dedupedFrom).toBeDefined();
      expect(b?.resultHash).not.toBe(a?.resultHash);
      expect(b?.resultHash).toMatch(/^sha256:/);

      // Strongest available correctness check without a 3rd container boot: the equivalence golden
      // (dedup-equivalence.test.ts, strategy block) already proves restamp(normalize(run(X)), Y) is
      // byte-identical to a FRESH run(Y) for this exact engine. Here we additionally spend one more
      // real sandbox boot to confirm b's resultHash matches a fresh run(run-strat-BBBBBBBB) directly,
      // closing the loop end-to-end through the worker.
      const spB = await materializeReadableBundle(STRATEGY_BUNDLE);
      try {
        const marketTape = await buildOverlayDataset(new FixtureDataPort(FIXTURES_DIR), {
          datasetRef: STRATEGY_REQ_BASE.datasetRef,
          symbols: STRATEGY_REQ_BASE.symbols,
          timeframe: STRATEGY_REQ_BASE.timeframe,
          period: STRATEGY_REQ_BASE.period,
        });
        const freshDeps = buildSandboxStrategyBaselineDeps({ spDir: spB.bundleDir });
        try {
          const fresh = await runStrategyModule.runStrategyBacktest(
            { ...STRATEGY_REQ_BASE, runId: 'run-strat-BBBBBBBB', engine: 'strategy' },
            { registry: freshDeps.registry, marketTape, router: freshDeps.router },
          );
          expect(b?.resultHash).toBe(contentRef(fresh));
        } finally {
          freshDeps.router.closeAll();
        }
      } finally {
        await spB.cleanup();
      }
    },
    180_000, // generous: 1 worker-driven sandbox boot (MISS) + 1 direct comparison boot (fresh run(B))
  );
});
