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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { BacktestRunRequest } from '@trading/research-contracts';
import { InMemoryJobStore, type NewJob } from '../src/jobs/job-store.js';
import { processNextQueued, workerInternals, type WorkerDeps } from '../src/jobs/worker.js';
import { InMemoryArtifactStore } from '../src/artifacts/store.js';
import { FixtureDataPort, materialize } from '../src/data/reader.js';
import { FIXTURES_DIR } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { InMemoryResultCache } from '../src/jobs/dedup/result-cache.js';
import { contentRef } from '../src/determinism/hash.js';
import * as runBacktestModule from '../src/runner/run-backtest.js';

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
