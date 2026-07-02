// Task 6 (compute-coalescing) — worker gate leader/follower + engine-commit attempts charge.
//
// Momentum path only (Docker-free). Extends the dedup-worker.test.ts momentum harness with a
// ComputeLockStore + coalesceEnabled + a worker lease, and asserts:
//   1. Leader (won the lock) runs the engine and completes.
//   2. A run that LOSES an already-held lock defers to `waiting_for_compute` WITHOUT running the
//      engine — attempts stays 0 (the claim deferred the charge) and computeWaitAttempts is bumped.
//   3. bypassCache=true bypasses coalescing entirely: even with an ACTIVE lock the run does NOT
//      defer — the engine runs fresh.
//
// The lock is pre-seeded under ANOTHER worker while the result cache is EMPTY, so the run-under-test
// finds a genuine cache MISS, reaches the coalescing gate, and loses the election. The identity is
// derived from a throwaway probe run (dedup OFF ⇒ no cache pollution) so the seed matches the
// deterministic computeIdentity the gate derives.

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { processNextQueued, type WorkerDeps } from '../src/jobs/worker.js';
import { InMemoryComputeLockStore } from '../src/jobs/coalesce/compute-lock.js';
import { InMemoryJobStore, type NewJob } from '../src/jobs/job-store.js';
import { InMemoryArtifactStore } from '../src/artifacts/store.js';
import { FixtureDataPort } from '../src/data/reader.js';
import { FIXTURES_DIR } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { InMemoryResultCache } from '../src/jobs/dedup/result-cache.js';
import { computeIdentity } from '../src/jobs/dedup/compute-identity.js';
import * as runBacktestModule from '../src/runner/run-backtest.js';

const CLOCK = 1_700_000_000_000;
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

function momentumJob(runId: string, extraRequest: Record<string, unknown> = {}): NewJob {
  return {
    jobId: runId,
    runId,
    requestFingerprint: SHARED_FP,
    request: { ...REQ, ...extraRequest } as never,
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

function makeCtx(opts: {
  dedupEnabled?: boolean;
  coalesceEnabled?: boolean;
  computeLock?: InMemoryComputeLockStore;
} = {}): Ctx {
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
    // Coalescing requires a lease (workerId identifies the leader).
    lease: { workerId: 'worker-self', ttlMs: 60_000, maxAttempts: 5 },
    ...(opts.dedupEnabled !== undefined ? { dedupEnabled: opts.dedupEnabled } : {}),
    ...(opts.coalesceEnabled !== undefined ? { coalesceEnabled: opts.coalesceEnabled } : {}),
    ...(opts.computeLock !== undefined ? { computeLock: opts.computeLock } : {}),
  } as WorkerDeps;
  return { store, cache, deps };
}

async function enqueue(store: InMemoryJobStore, runId: string): Promise<void> {
  await store.insertOrGet(momentumJob(runId));
  await store.transition(runId, 'accepted', 'queued', { atMs: CLOCK, queuedAtMs: CLOCK });
}

async function enqueueBypass(store: InMemoryJobStore, runId: string): Promise<void> {
  await store.insertOrGet(momentumJob(runId, { bypassCache: true }));
  await store.transition(runId, 'accepted', 'queued', { atMs: CLOCK, queuedAtMs: CLOCK });
}

// curatedBaselineRef set ⇒ dedupOn === false (evidence_bypass, INV-5). Momentum ignores
// curatedBaselineRef for evidence production, but the dedup/coalescing gate still reads it.
async function enqueueEvidence(store: InMemoryJobStore, runId: string): Promise<void> {
  await store.insertOrGet(momentumJob(runId, { curatedBaselineRef: { id: 'baseline', version: '1.0.0' } }));
  await store.transition(runId, 'accepted', 'queued', { atMs: CLOCK, queuedAtMs: CLOCK });
}

// Derive the deterministic momentum computeIdentity the gate will compute, WITHOUT touching the
// test's result cache: a throwaway probe run with dedup OFF just persists datasetFingerprint.
async function momentumIdentity(deps: WorkerDeps): Promise<string> {
  const probeStore = new InMemoryJobStore();
  const probeDeps = {
    ...deps,
    store: probeStore,
    dedupEnabled: false,
    coalesceEnabled: false,
    computeLock: undefined,
  } as WorkerDeps;
  await probeStore.insertOrGet(momentumJob('run-probe'));
  await probeStore.transition('run-probe', 'accepted', 'queued', { atMs: CLOCK, queuedAtMs: CLOCK });
  const row = await processNextQueued(probeDeps);
  const dsFingerprint = row?.datasetFingerprint;
  if (dsFingerprint === undefined) throw new Error('probe run produced no datasetFingerprint');
  const policy = deps.overlaySandbox.policy;
  return computeIdentity({
    requestFingerprint: SHARED_FP,
    datasetFingerprint: dsFingerprint,
    sandboxPolicyVersion: `${policy.id}@${policy.version}`,
  });
}

// Seed an ALIVE lock owned by another worker for the momentum computeIdentity, so a normal run loses
// the election and defers. (bypassCache runs must ignore it.)
async function seedActiveLockForMomentum(
  lock: InMemoryComputeLockStore,
  deps: WorkerDeps,
  leaderRunId: string,
  ttlMs: number,
): Promise<void> {
  const identity = await momentumIdentity(deps);
  const won = await lock.acquire(identity, leaderRunId, 'other-worker', CLOCK, ttlMs);
  if (!won) throw new Error('seed lock acquire unexpectedly lost');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('coalescing gate — momentum', () => {
  it('leader (won the lock, no prior holder) runs the engine and completes', async () => {
    const lock = new InMemoryComputeLockStore();
    const { store, deps } = makeCtx({ dedupEnabled: true, coalesceEnabled: true, computeLock: lock });
    const runSpy = vi.spyOn(runBacktestModule, 'runBacktest');

    await enqueue(store, 'run-leader');
    const a = await processNextQueued(deps); // no prior lock → leader → runs engine
    expect(a?.status).toBe('completed');
    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it('a run that LOSES an active lock defers → waiting_for_compute, engine NOT called, attempts 0, computeWaitAttempts 1', async () => {
    const lock = new InMemoryComputeLockStore();
    const { store, deps } = makeCtx({ dedupEnabled: true, coalesceEnabled: true, computeLock: lock });

    // Hold the lock as another worker for this identity BEFORE the run reaches the gate; long ttl so
    // it stays alive under the fixed test clock. The cache is EMPTY ⇒ the run MISSes and reaches the gate.
    // Seed BEFORE spying: the probe inside the seed helper runs the momentum engine once.
    await seedActiveLockForMomentum(lock, deps, 'run-other', 10_000_000);
    const runSpy = vi.spyOn(runBacktestModule, 'runBacktest');

    await enqueue(store, 'run-follower');
    const b = await processNextQueued(deps);
    expect(runSpy).not.toHaveBeenCalled(); // engine skipped
    const row = await store.get('run-follower');
    expect(row?.status).toBe('waiting_for_compute'); // internal status
    expect(row?.attempts).toBe(0); // claim deferred the charge; follower never runs the engine
    expect(row?.computeWaitAttempts).toBe(1); // one wait cycle
    expect(b?.status).toBe('waiting_for_compute');
  });

  it('bypassCache=true bypasses coalescing: even with an ACTIVE lock the run does NOT defer — engine runs fresh', async () => {
    const lock = new InMemoryComputeLockStore();
    const { store, deps } = makeCtx({ dedupEnabled: true, coalesceEnabled: true, computeLock: lock });
    // Seed BEFORE spying: the probe inside the seed helper runs the momentum engine once.
    await seedActiveLockForMomentum(lock, deps, 'run-other', 10_000_000);
    const runSpy = vi.spyOn(runBacktestModule, 'runBacktest');

    await enqueueBypass(store, 'run-bypass'); // same momentum request but request.bypassCache = true
    const r = await processNextQueued(deps);
    expect(r?.status).toBe('completed');
    expect(runSpy).toHaveBeenCalledTimes(1); // engine ran fresh despite the active lock
    expect((await store.get('run-bypass'))?.status).not.toBe('waiting_for_compute');
  });

  it('evidence run (curatedBaselineRef set ⇒ dedupOn false) under coalescing: engine runs directly (no lock election), attempts charged at engine-commit', async () => {
    const lock = new InMemoryComputeLockStore();
    const { store, deps } = makeCtx({ dedupEnabled: true, coalesceEnabled: true, computeLock: lock });
    const runSpy = vi.spyOn(runBacktestModule, 'runBacktest');

    await enqueueEvidence(store, 'run-evidence');
    const r = await processNextQueued(deps);
    expect(r?.status).toBe('completed');
    expect(runSpy).toHaveBeenCalledTimes(1); // dedupOn false → no lock election → runs directly
    const row = await store.get('run-evidence');
    expect(row?.status).not.toBe('waiting_for_compute');
    expect(row?.attempts).toBe(1); // deferred at claim, charged once at engine-commit
    expect(row?.engineAttemptCharged).toBe(true);
  });
});
