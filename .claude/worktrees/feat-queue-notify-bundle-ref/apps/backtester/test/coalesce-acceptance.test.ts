// Task 10 (result-dedup) — headline acceptance: a burst of N identical momentum runs, driven through
// the dedup/coalescing gate + a wake round, executes runBacktest EXACTLY once; all N end terminal
// `completed`; exactly ONE result_cache entry for the shared computeIdentity.
//
// Drive variant (documented per the Task 10 brief's explicit-drive fallback): InMemory `drainQueue`
// cannot be trusted to produce genuine concurrency (single-threaded event loop; claimNextQueued's
// internal transitions have no real await barrier, so a bounded pool's "concurrent" slots tend to
// race however the fs-backed FixtureDataPort reads happen to interleave — nondeterministic, and NOT
// something a test should pin). Rather than rely on that race, this test forces the "4 simultaneous
// waiters" shape DETERMINISTICALLY by seeding an ACTIVE compute lock for the shared momentum
// computeIdentity (the exact `seedActiveLockForMomentum` pattern from Task 6's coalesce-gate.test.ts,
// reimplemented locally since it is not exported) BEFORE any of the 4 burst jobs reach the gate. Every
// one of the 4 then deterministically LOSES the election and defers to `waiting_for_compute` — no
// race, no timing assumption. A `bypassCache:true` companion job (which never coalesces, per
// Task 6's INV-1) stands in for "the external lock-holder's own run" and is what actually executes the
// engine once and populates the cache — this is the ONE real engine invocation the whole burst
// produces. A single `wakeComputeWaiters` round then finds the cache populated and releases ALL 4
// waiters (`cache_ready`); re-draining them re-stamps each from the cached template — no further
// engine calls, one cache entry.
//
// A second, dedicated test pins the single-follower `waiting_for_compute` → wake → `completed` path
// explicitly and in isolation (same seed-lock + bypass-populate technique), per the brief's explicit
// requirement that the deferral+wake+restamp path be covered even if the N=4 burst's own shape
// degenerates.

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { drainQueue, processNextQueued, type WorkerDeps } from '../src/jobs/worker.js';
import { InMemoryComputeLockStore } from '../src/jobs/coalesce/compute-lock.js';
import { InMemoryJobStore, type NewJob } from '../src/jobs/job-store.js';
import { InMemoryArtifactStore } from '../src/artifacts/store.js';
import { FixtureDataPort } from '../src/data/reader.js';
import { FIXTURES_DIR } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { InMemoryResultCache } from '../src/jobs/dedup/result-cache.js';
import { computeIdentity } from '../src/jobs/dedup/compute-identity.js';
import { wakeComputeWaiters } from '../src/jobs/coalesce/wake.js';
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

interface CoalesceCtx {
  store: InMemoryJobStore;
  cache: InMemoryResultCache;
  lock: InMemoryComputeLockStore;
  deps: WorkerDeps;
}

// dedup-worker.test.ts::makeCtx, extended per the Task 10 brief: coalesceEnabled:true + a shared
// InMemoryComputeLockStore on deps.computeLock + a worker lease.
function makeCoalesceCtx(): CoalesceCtx {
  const config = loadConfig();
  const store = new InMemoryJobStore();
  const cache = new InMemoryResultCache();
  const lock = new InMemoryComputeLockStore();
  const deps = {
    store,
    clock: () => CLOCK,
    uid: () => randomUUID(),
    postWebhook: async () => {},
    dataPort: new FixtureDataPort(FIXTURES_DIR),
    artifactStore: new InMemoryArtifactStore(),
    overlaySandbox: config.overlaySandbox,
    resultCache: cache,
    dedupEnabled: true,
    coalesceEnabled: true,
    computeLock: lock,
    lease: { workerId: 'w1', ttlMs: 60_000, maxAttempts: 3 },
  } as WorkerDeps;
  return { store, cache, lock, deps };
}

async function enqueue(store: InMemoryJobStore, runId: string): Promise<void> {
  await store.insertOrGet(momentumJob(runId));
  await store.transition(runId, 'accepted', 'queued', { atMs: CLOCK, queuedAtMs: CLOCK });
}

// bypassCache never coalesces (Task 6, INV-1) — it always runs the engine directly. Used here as the
// stand-in for "the external lock-holder's own in-flight run": it is the one call that actually
// executes the engine and populates the cache while every other identical job is deferring.
async function enqueueBypass(store: InMemoryJobStore, runId: string): Promise<void> {
  await store.insertOrGet(momentumJob(runId, { bypassCache: true }));
  await store.transition(runId, 'accepted', 'queued', { atMs: CLOCK, queuedAtMs: CLOCK });
}

// Derive the deterministic momentum computeIdentity the gate will compute, WITHOUT touching the
// test's result cache: a throwaway probe run with dedup OFF just persists datasetFingerprint.
// (Mirrors coalesce-gate.test.ts::momentumIdentity — not exported there, reimplemented locally.)
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

// Seed an ALIVE lock owned by another worker for the momentum computeIdentity, so every real run
// below deterministically loses the election and defers. (Mirrors coalesce-gate.test.ts's
// seedActiveLockForMomentum — not exported there, reimplemented locally.)
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

describe('coalescing acceptance — engine runs once for a concurrent identical burst', () => {
  it('N=4 identical → 1 engine run, 4 completed, 1 cache entry', async () => {
    const { store, cache, deps, lock } = makeCoalesceCtx();

    // Seed BEFORE spying: the probe inside the seed helper runs the momentum engine once (dedup off).
    // Long ttl so the seeded lock stays alive across the whole "4 defer" round below.
    await seedActiveLockForMomentum(lock, deps, 'run-external-leader', 10_000_000);

    const runSpy = vi.spyOn(runBacktestModule, 'runBacktest');
    const putSpy = vi.spyOn(cache, 'put');

    const ids = ['b1', 'b2', 'b3', 'b4'];
    for (const id of ids) await enqueue(store, id);

    // Round 1: each of the 4 loses the (externally-held) lock and defers — deterministic, no race:
    // none of them can ever win against a lock none of them holds.
    for (const id of ids) {
      const row = await processNextQueued(deps);
      expect(row?.runId).toBe(id);
      expect(row?.status).toBe('waiting_for_compute');
    }
    expect(runSpy).not.toHaveBeenCalled();
    const waiting = (await Promise.all(ids.map((i) => store.get(i)))).filter(
      (j) => j?.status === 'waiting_for_compute',
    );
    expect(waiting.length).toBe(4);

    // The external lock-holder's own run: bypassCache skips coalescing entirely (INV-1) and runs the
    // engine directly — this is the ONE real engine invocation the whole burst produces, and it
    // populates the cache under the SAME computeIdentity the 4 waiters are blocked on.
    await enqueueBypass(store, 'run-external-leader');
    const leaderRow = await processNextQueued(deps);
    expect(leaderRow?.status).toBe('completed');
    expect(runSpy).toHaveBeenCalledTimes(1);

    // Wake: cache now present → release all 4 waiters (cache_ready) → re-drain → HIT re-stamp.
    const wake = await wakeComputeWaiters({
      store,
      resultCache: cache,
      computeLock: lock,
      clock: deps.clock,
      computeWaitMaxAttempts: 3,
    });
    expect(wake.released).toBe(4);
    expect(wake.poisoned).toBe(0);
    for (const id of ids) expect((await store.get(id))?.status).toBe('queued');

    await drainQueue(deps, 4);

    expect(runSpy).toHaveBeenCalledTimes(1); // STILL once — no follower ran the engine
    const hashes = new Set<string>();
    for (const id of ids) {
      const row = await store.get(id);
      expect(row?.status).toBe('completed');
      expect(row?.dedupedFrom).toBeDefined();
      expect(row?.computeWakeReason).toBe('cache_ready');
      expect(row?.resultHash).toBeDefined();
      hashes.add(row!.resultHash!);
    }
    // followers' result_hash are distinct runId-stamped hashes (never the leader's own hash, and
    // never collide with each other — restamp is keyed by runId).
    expect(hashes.size).toBe(4);
    expect(hashes.has(leaderRow!.resultHash!)).toBe(false);

    // Exactly one result_cache entry for the shared fingerprint: InMemoryResultCache.put was called
    // exactly once across the whole burst (the bypass-populate run only — no follower ever populates).
    expect(putSpy).toHaveBeenCalledTimes(1);
  });

  it('single follower: waiting_for_compute → wake(cache_ready) → completed via re-stamp (no engine call)', async () => {
    const { store, cache, deps, lock } = makeCoalesceCtx();

    // Seed BEFORE spying: the probe inside the seed helper runs the momentum engine once (dedup off).
    await seedActiveLockForMomentum(lock, deps, 'run-other', 10_000_000);

    const runSpy = vi.spyOn(runBacktestModule, 'runBacktest');

    await enqueue(store, 'run-follower');
    const deferred = await processNextQueued(deps);
    expect(runSpy).not.toHaveBeenCalled();
    expect(deferred?.status).toBe('waiting_for_compute');
    expect((await store.get('run-follower'))?.computeWaitAttempts).toBe(1);

    // Populate the cache via a bypassCache run (never coalesces — runs the engine directly).
    await enqueueBypass(store, 'run-other');
    const leaderRow = await processNextQueued(deps);
    expect(leaderRow?.status).toBe('completed');
    expect(runSpy).toHaveBeenCalledTimes(1);

    const wake = await wakeComputeWaiters({
      store,
      resultCache: cache,
      computeLock: lock,
      clock: deps.clock,
      computeWaitMaxAttempts: 3,
    });
    expect(wake.released).toBe(1);
    expect((await store.get('run-follower'))?.status).toBe('queued');
    expect((await store.get('run-follower'))?.computeWakeReason).toBe('cache_ready');

    const restamped = await processNextQueued(deps);
    expect(restamped?.status).toBe('completed');
    expect(restamped?.dedupedFrom).toBeDefined();
    expect(restamped?.resultHash).toBeDefined();
    expect(restamped?.resultHash).not.toBe(leaderRow?.resultHash);
    expect(runSpy).toHaveBeenCalledTimes(1); // still just the one bypass-populate call
  });
});
