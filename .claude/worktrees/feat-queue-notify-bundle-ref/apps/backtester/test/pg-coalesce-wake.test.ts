// Postgres-gated regression test for the coalescing wake-store helpers on PgJobStore
// (releaseAllComputeWaiters / electOneComputeWaiter / listComputeWaiters / poisonComputeWaiter) and
// wakeComputeWaiters. Those helpers were exercised ONLY against InMemoryJobStore before this suite
// (see coalesce-wake.test.ts) — a missing/unbound SQL param in PgJobStore.releaseAllComputeWaiters
// threw 42P18 indeterminate_datatype on EVERY call on real Postgres, 100%-breaking the "cache-ready
// -> release all waiters" path (fixed in d46cf5e). This suite drives the same scenarios against a
// REAL PgJobStore + PgResultCache + PgComputeLockStore so CI's Postgres lane catches any regression.
//
// Gating/pool-construction mirrors the sibling Pg conformance suites (pg-compute-lock.test.ts,
// dedup-result-cache.test.ts): BACKTESTER_TEST_DATABASE_URL / DATABASE_URL, probed once in
// store-factories.ts's PG_AVAILABLE, createPool + migrate over a throwaway per-run schema. Skips
// cleanly (does not fail) when no DB is reachable.

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/db/pool';
import { DEFAULT_MIGRATIONS_DIR, migrate } from '../src/db/migrate';
import { PG_AVAILABLE } from './store-factories';
import { PgJobStore } from '../src/jobs/pg-job-store';
import type { JobStore, NewJob } from '../src/jobs/job-store.js';
import { PgResultCache } from '../src/jobs/dedup/pg-result-cache';
import { PgComputeLockStore } from '../src/jobs/coalesce/pg-compute-lock';
import { wakeComputeWaiters } from '../src/jobs/coalesce/wake.js';

function newJob(runId: string, ci: string): NewJob {
  return {
    jobId: runId,
    runId,
    requestFingerprint: `fp-${runId}`,
    request: {} as never,
    effectiveSeed: 1,
    datasetRef: 'ds',
    runTimeoutMs: 3_600_000,
    acceptedAtMs: 1000,
  };
}

// Puts a job into waiting_for_compute with a given computeIdentity via insertOrGet + transitions:
// accepted -> queued -> running -> waiting_for_compute (mirrors the real gate's path). Same shape as
// coalesce-wake.test.ts's InMemory seedWaiter, ported to a JobStore-typed store (works for Pg too).
async function seedWaiter(
  store: JobStore,
  runId: string,
  ci: string,
  waitAttempts = 0,
): Promise<void> {
  await store.insertOrGet(newJob(runId, ci));
  await store.transition(runId, 'accepted', 'queued', { atMs: 1000, queuedAtMs: 1000 });
  await store.transition(runId, 'queued', 'running', { atMs: 1000, startedAtMs: 1000 });
  await store.transition(runId, 'running', 'waiting_for_compute', {
    atMs: 1000,
    computeIdentity: ci,
    computeWaitAttempts: waitAttempts,
    waitDeadlineMs: 999_999,
  });
}

describe.skipIf(!PG_AVAILABLE)('wakeComputeWaiters on PgJobStore (Postgres conformance)', () => {
  const PG_URL = (process.env.BACKTESTER_TEST_DATABASE_URL ?? process.env.DATABASE_URL) as string;
  const schema = `bt_test_cw_${process.pid}_${Date.now().toString(36)}`;
  let adminPool: Pool;
  let pool: ReturnType<typeof createPool>;
  let store: PgJobStore;
  let resultCache: PgResultCache;
  let computeLock: PgComputeLockStore;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: PG_URL });
    await adminPool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    pool = createPool(PG_URL, schema);
    await migrate(pool, DEFAULT_MIGRATIONS_DIR);
    store = new PgJobStore(pool);
    resultCache = new PgResultCache(pool);
    computeLock = new PgComputeLockStore(pool);
  });

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  });

  const deps = (clock = () => 5000) => ({
    store,
    resultCache,
    computeLock,
    clock,
    computeWaitMaxAttempts: 3,
  });

  it('cache present -> releases ALL waiters to queued with reason cache_ready (THE regressor: this ' +
    'call executes PgJobStore.releaseAllComputeWaiters, which threw 42P18 indeterminate_datatype on ' +
    'every call pre-fix)', async () => {
    const CI = 'ci-releaseall';
    await seedWaiter(store, 'pg-w-a', CI);
    await seedWaiter(store, 'pg-w-b', CI);
    const queuedAtMsBefore = (await store.get('pg-w-a'))?.queuedAtMs;
    expect(queuedAtMsBefore).toBe(1000);

    await resultCache.put({
      computeIdentity: CI,
      requestFingerprint: 'f',
      datasetFingerprint: 'g',
      computeVersion: '1',
      sandboxPolicyVersion: 'p',
      templateRef: 't',
      createdAtMs: 1,
    });

    // Pre-fix this threw 42P18 indeterminate_datatype (unbound $3 in the UPDATE) — must not throw.
    const r = await wakeComputeWaiters(deps());
    expect(r.released).toBe(2);
    expect(r.poisoned).toBe(0);

    const a = await store.get('pg-w-a');
    const b = await store.get('pg-w-b');
    expect(a?.status).toBe('queued');
    expect(a?.computeWakeReason).toBe('cache_ready');
    expect(a?.queuedAtMs).toBe(queuedAtMsBefore); // preserved FIFO position, not restamped
    expect(b?.status).toBe('queued');
    expect(b?.computeWakeReason).toBe('cache_ready');
  });

  it('no cache + expired lock -> elects exactly ONE (reason lock_expired), rest stay waiting', async () => {
    const CI = 'ci-electone';
    await seedWaiter(store, 'pg-w-c', CI);
    await seedWaiter(store, 'pg-w-d', CI);
    await computeLock.acquire(CI, 'leader', 'w0', 0, 100); // expires 100, clock()=5000 -> expired

    const r = await wakeComputeWaiters(deps());
    expect(r.released).toBe(1);
    expect(r.poisoned).toBe(0);

    const statuses = [
      (await store.get('pg-w-c'))?.status,
      (await store.get('pg-w-d'))?.status,
    ].sort();
    expect(statuses).toEqual(['queued', 'waiting_for_compute']); // exactly one released

    const released = (await store.get('pg-w-c'))?.status === 'queued' ? 'pg-w-c' : 'pg-w-d';
    expect((await store.get(released))?.computeWakeReason).toBe('lock_expired');
  });

  it('compute_wait_attempts >= cap -> poison to failed(compute_wait_exhausted)', async () => {
    const CI = 'ci-poison';
    await seedWaiter(store, 'pg-w-e', CI, /* waitAttempts */ 3);
    await computeLock.acquire(CI, 'leader', 'w0', 0, 100); // expired, irrelevant to poisoning order

    const r = await wakeComputeWaiters(deps());
    expect(r.poisoned).toBe(1);

    const row = await store.get('pg-w-e');
    expect(row?.status).toBe('failed');
    expect(row?.terminalCode).toBe('compute_wait_exhausted');
  });
});
