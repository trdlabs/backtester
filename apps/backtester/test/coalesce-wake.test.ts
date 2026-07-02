// Task 7 (inflight coalescing) — wakeComputeWaiters release-policy.
//
// Drives the wake step directly against InMemoryJobStore + InMemoryResultCache +
// InMemoryComputeLockStore: cache-present releases ALL waiters (cache_ready); an
// expired/absent lock elects exactly ONE waiter (lock_expired/leader_failed); an alive lock
// keeps everyone waiting; and a waiter at/over computeWaitMaxAttempts is poisoned to
// failed(compute_wait_exhausted) before any cache/lock check.

import { describe, expect, it } from 'vitest';
import { InMemoryJobStore, type JobStore, type NewJob } from '../src/jobs/job-store.js';
import { InMemoryResultCache } from '../src/jobs/dedup/result-cache.js';
import { InMemoryComputeLockStore } from '../src/jobs/coalesce/compute-lock.js';
import { wakeComputeWaiters } from '../src/jobs/coalesce/wake.js';

const CI = 'ci-1';

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
// accepted -> queued -> running -> waiting_for_compute (mirrors the real gate's path).
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

const mk = () => ({
  store: new InMemoryJobStore(),
  resultCache: new InMemoryResultCache(),
  computeLock: new InMemoryComputeLockStore(),
});
const deps = (d: ReturnType<typeof mk>, clock = () => 5000) => ({
  ...d,
  clock,
  computeWaitMaxAttempts: 3,
});

describe('wakeComputeWaiters', () => {
  it('cache present → releases ALL waiters to queued with reason cache_ready', async () => {
    const d = mk();
    await seedWaiter(d.store, 'w-a', CI);
    await seedWaiter(d.store, 'w-b', CI);
    await d.resultCache.put({
      computeIdentity: CI,
      requestFingerprint: 'f',
      datasetFingerprint: 'g',
      computeVersion: '1',
      sandboxPolicyVersion: 'p',
      templateRef: 't',
      createdAtMs: 1,
    });
    const r = await wakeComputeWaiters(deps(d));
    expect(r.released).toBe(2);
    expect((await d.store.get('w-a'))?.status).toBe('queued');
    expect((await d.store.get('w-a'))?.computeWakeReason).toBe('cache_ready');
    expect((await d.store.get('w-b'))?.status).toBe('queued');
  });

  it('no cache + expired lock → elects exactly ONE (reason lock_expired), rest stay waiting', async () => {
    const d = mk();
    await seedWaiter(d.store, 'w-a', CI);
    await seedWaiter(d.store, 'w-b', CI);
    await d.computeLock.acquire(CI, 'leader', 'w0', 0, 100); // expires 100, now 5000 → expired
    const r = await wakeComputeWaiters(deps(d));
    expect(r.released).toBe(1);
    const statuses = [
      (await d.store.get('w-a'))?.status,
      (await d.store.get('w-b'))?.status,
    ].sort();
    expect(statuses).toEqual(['queued', 'waiting_for_compute']); // exactly one released
  });

  it('no cache + alive lock → keeps all waiting', async () => {
    const d = mk();
    await seedWaiter(d.store, 'w-a', CI);
    await d.computeLock.acquire(CI, 'leader', 'w0', 4990, 1000); // alive until 5990
    const r = await wakeComputeWaiters(deps(d));
    expect(r.released).toBe(0);
    expect((await d.store.get('w-a'))?.status).toBe('waiting_for_compute');
  });

  it('compute_wait_attempts >= cap → poison to failed(compute_wait_exhausted)', async () => {
    const d = mk();
    await seedWaiter(d.store, 'w-a', CI, /* waitAttempts */ 3);
    await d.computeLock.acquire(CI, 'leader', 'w0', 0, 100); // expired
    const r = await wakeComputeWaiters(deps(d));
    expect(r.poisoned).toBe(1);
    const row = await d.store.get('w-a');
    expect(row?.status).toBe('failed');
    expect(row?.terminalCode).toBe('compute_wait_exhausted');
  });
});
