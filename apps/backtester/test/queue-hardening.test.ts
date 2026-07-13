// Queue-hardening P2-2 / P2-3 / P2-4 (CODE-REVIEW-2026-07-12). Momentum smoke fixture drives a real
// engine run without Docker.
//   P2-2 — a worker whose terminal transition lost the CAS (a reaper already terminalized the row)
//          must NOT publish a duplicate completion event.
//   P2-3 — the deadline reaper's requeue must reset engine_attempt_charged (coalescing), else a job
//          that charged once then keeps crashing before the next charge requeues forever.
//   P2-4 — advisory subsystems on the critical path must be best-effort: a dedup-cache populate fault
//          must not fail an otherwise-successful run.

import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { InMemoryJobStore, type NewJob, type JobEventRow } from '../src/jobs/job-store.js';
import { processNextQueued, type WorkerDeps } from '../src/jobs/worker.js';
import { InMemoryArtifactStore } from '../src/artifacts/store.js';
import { FixtureDataPort } from '../src/data/reader.js';
import { FIXTURES_DIR } from './helpers.js';
import { loadConfig } from '../src/config.js';
import type { ResultCache } from '../src/jobs/dedup/result-cache.js';
import type { JobStore } from '../src/jobs/job-store.js';
import { PG_AVAILABLE, createPgSchema } from './store-factories.js';

const T0 = 1_700_000_000_000;

function momentumJob(runId: string, seed = 42): NewJob {
  return {
    jobId: runId,
    runId,
    requestFingerprint: `fp-${runId}`,
    request: {
      mode: 'research',
      moduleRef: { id: 'smoke', version: '1.0.0' },
      datasetRef: 'smoke-btc-1m',
      symbols: ['BTCUSDT'],
      timeframe: '1m',
      period: { from: '2023-11-14T00:00:00.000Z', to: '2023-11-15T00:00:00.000Z' },
      seed,
      metrics: [],
    } as never,
    effectiveSeed: seed,
    datasetRef: 'smoke-btc-1m',
    runTimeoutMs: 3_600_000,
    acceptedAtMs: T0,
  };
}

function baseDeps(store: InMemoryJobStore): WorkerDeps {
  const config = loadConfig();
  return {
    store,
    clock: () => T0,
    uid: () => randomUUID(),
    postWebhook: async () => {},
    dataPort: new FixtureDataPort(FIXTURES_DIR),
    artifactStore: new InMemoryArtifactStore(),
    overlaySandbox: config.overlaySandbox,
    lease: { workerId: 'w1', ttlMs: 30_000, maxAttempts: 3 },
  } as WorkerDeps;
}

async function queueJob(store: InMemoryJobStore, job: NewJob): Promise<void> {
  await store.insertOrGet(job);
  await store.transition(job.runId, 'accepted', 'queued', { atMs: T0, queuedAtMs: T0 });
}

const COMPLETION_EVENTS = new Set(['job_completed', 'job_failed', 'job_canceled', 'job_expired', 'job_timed_out']);

// ─── P2-2 ───────────────────────────────────────────────────────────────────
/** Simulates the worker/reaper race: when the worker attempts its terminal `completed` transition,
 *  a reaper has already terminalized the row (timed_out) — so the worker's CAS returns false. Counts
 *  the completion events published, to prove the worker doesn't double-publish. */
class RaceStore extends InMemoryJobStore {
  completionEvents = 0;
  override async appendEvent(ev: JobEventRow): Promise<void> {
    if (COMPLETION_EVENTS.has(ev.eventType)) this.completionEvents += 1;
    return super.appendEvent(ev);
  }
  override async transition(
    runId: string,
    from: Parameters<InMemoryJobStore['transition']>[1],
    to: Parameters<InMemoryJobStore['transition']>[2],
    patch: Parameters<InMemoryJobStore['transition']>[3],
    expectLeasedBy?: string,
  ): Promise<boolean> {
    if (from === 'running' && to === 'completed') {
      await super.transition(runId, 'running', 'timed_out', {
        atMs: patch.atMs,
        terminalAtMs: patch.atMs,
        terminalCode: 'run_deadline_exceeded',
      });
      return false; // the worker's completed-CAS lost the race
    }
    return super.transition(runId, from, to, patch, expectLeasedBy);
  }
}

describe('P2-2: no duplicate completion event when the terminal transition lost the CAS', () => {
  it('the worker does not publish when a reaper already terminalized the row', async () => {
    const store = new RaceStore();
    await queueJob(store, momentumJob('race-1'));
    await processNextQueued(baseDeps(store));
    expect((await store.get('race-1'))!.status).toBe('timed_out'); // the reaper owns the terminal state
    expect(store.completionEvents).toBe(0); // the worker must NOT double-publish (reaper publishes it)
  });
});

// ─── P2-3 ───────────────────────────────────────────────────────────────────
describe('P2-3: reaper requeue resets engine_attempt_charged (coalescing)', () => {
  it('a lease-expired job that charged its engine attempt is requeued with charged=false', async () => {
    const store = new InMemoryJobStore();
    await queueJob(store, momentumJob('req-1'));
    await store.claimNextQueued(T0, { workerId: 'w1', ttlMs: 800 }); // running, lease_expires = T0+800
    await store.transition('req-1', 'running', 'running', { atMs: T0, engineAttemptCharged: true }); // engine-commit
    expect((await store.get('req-1'))!.engineAttemptCharged).toBe(true);

    await store.reapDeadlines(T0 + 5000, { coalesceEnabled: true, leaseMaxAttempts: 3 }); // past lease, under cap

    const row = await store.get('req-1');
    expect(row!.status).toBe('queued');
    expect(row!.engineAttemptCharged).toBe(false); // reset → the next crash-before-charge is now counted
  });

  it('does NOT reset engine_attempt_charged when coalescing is OFF (INV-6 byte-identical)', async () => {
    const store = new InMemoryJobStore();
    await queueJob(store, momentumJob('req-2'));
    await store.claimNextQueued(T0, { workerId: 'w1', ttlMs: 800 });
    await store.transition('req-2', 'running', 'running', { atMs: T0, engineAttemptCharged: true });

    await store.reapDeadlines(T0 + 5000, { coalesceEnabled: false, leaseMaxAttempts: 3 });

    const row = await store.get('req-2');
    expect(row!.status).toBe('queued');
    expect(row!.engineAttemptCharged).toBe(true); // untouched when coalescing OFF
  });
});

// ─── P2-4a ──────────────────────────────────────────────────────────────────
describe('P2-4a: a dedup-cache populate fault does not fail a successful run', () => {
  it('completes the run when resultCache.put throws (best-effort populate)', async () => {
    const store = new InMemoryJobStore();
    await queueJob(store, momentumJob('cache-1'));
    const throwingCache: ResultCache = {
      lookup: async () => undefined,
      put: async () => {
        throw new Error('cache backend unavailable');
      },
    };
    const deps = { ...baseDeps(store), resultCache: throwingCache, dedupEnabled: true } as WorkerDeps;

    await processNextQueued(deps);

    expect((await store.get('cache-1'))!.status).toBe('completed'); // NOT failed(runner_failure)
  });
});


// ─── P2-3 [postgres] — the SQL requeue path (pg-job-store) mirrors the in-memory behaviour ─────────
describe.skipIf(!PG_AVAILABLE)('P2-3 [postgres]: reaper requeue resets engine_attempt_charged', () => {
  async function chargedRunningJob(store: JobStore, runId: string): Promise<void> {
    await store.insertOrGet(momentumJob(runId));
    await store.transition(runId, 'accepted', 'queued', { atMs: T0, queuedAtMs: T0 });
    await store.claimNextQueued(T0, { workerId: 'w1', ttlMs: 800 }); // running, lease_expires = T0+800
    await store.transition(runId, 'running', 'running', { atMs: T0, engineAttemptCharged: true }); // engine-commit
    expect((await store.get(runId))!.engineAttemptCharged).toBe(true);
  }

  it('coalescing ON: a lease-expired charged job requeues with charged=false', async () => {
    const { makeStore, teardown } = await createPgSchema();
    try {
      const store = makeStore();
      await chargedRunningJob(store, 'pg-req-on');
      await store.reapDeadlines(T0 + 5000, { coalesceEnabled: true, leaseMaxAttempts: 3 });
      const row = await store.get('pg-req-on');
      expect(row!.status).toBe('queued');
      expect(row!.engineAttemptCharged).toBe(false);
    } finally {
      await teardown();
    }
  });

  it('coalescing OFF: engine_attempt_charged is untouched (INV-6 byte-identical)', async () => {
    const { makeStore, teardown } = await createPgSchema();
    try {
      const store = makeStore();
      await chargedRunningJob(store, 'pg-req-off');
      await store.reapDeadlines(T0 + 5000, { coalesceEnabled: false, leaseMaxAttempts: 3 });
      const row = await store.get('pg-req-off');
      expect(row!.status).toBe('queued');
      expect(row!.engineAttemptCharged).toBe(true);
    } finally {
      await teardown();
    }
  });
});
