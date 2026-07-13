// P1-3: a coalescing follower parks in the internal `waiting_for_compute` status. It is woken ONLY by
// wakeComputeWaiters, which is flag-gated. If the coalescing flag is rolled back (the whole point of a
// dark-launch kill-switch), nothing wakes the follower AND the deadline reaper (which only touched
// queued/running) never times it out — so the row is stranded forever and `publicStatus` reports it as
// `running` for eternity. The reaper must time out a `waiting_for_compute` row past its run deadline
// UNCONDITIONALLY (independent of the coalescing flag). See CODE-REVIEW-2026-07-12.md P1-3.

import { describe, expect, it } from 'vitest';
import { InMemoryJobStore, type NewJob } from '../src/jobs/job-store.js';
import { canTransition } from '../src/jobs/lifecycle.js';
import { PG_AVAILABLE, createPgSchema } from './store-factories.js';

const T0 = 1_700_000_000_000;
const RUN_TTL = 10_000;

function newJob(runId: string): NewJob {
  return {
    jobId: runId,
    runId,
    requestFingerprint: `fp-${runId}`,
    request: {} as never,
    effectiveSeed: 1,
    datasetRef: 'ds',
    runTimeoutMs: RUN_TTL,
    acceptedAtMs: T0,
  };
}

/** Drive a job to the internal `waiting_for_compute` status the way the coalescing follower path does:
 *  queued → claim (running, sets runDeadlineMs = claimAt + runTimeoutMs) → running→waiting_for_compute. */
async function parkAsFollower(store: InMemoryJobStore, runId: string, claimAtMs: number): Promise<void> {
  await store.insertOrGet(newJob(runId));
  await store.transition(runId, 'accepted', 'queued', { atMs: claimAtMs, queuedAtMs: claimAtMs });
  const claimed = await store.claimNextQueued(claimAtMs, { workerId: 'w1', ttlMs: 30_000 });
  if (!claimed) throw new Error('claim failed');
  await store.transition(runId, 'running', 'waiting_for_compute', {
    atMs: claimAtMs,
    computeIdentity: 'ci-1',
    computeWaitAttempts: 1,
    engineAttemptCharged: false,
  }, 'w1');
}

describe('lifecycle allows waiting_for_compute → timed_out', () => {
  it('permits the reaper transition', () => {
    expect(canTransition('waiting_for_compute', 'timed_out')).toBe(true);
  });
});

describe('reapDeadlines times out a stranded waiting_for_compute follower', () => {
  it('flag OFF (rollback): a follower past its run deadline is timed_out, not left stranded', async () => {
    const store = new InMemoryJobStore();
    await parkAsFollower(store, 'follower-1', T0);
    expect((await store.get('follower-1'))!.status).toBe('waiting_for_compute');

    // Coalescing rolled back → coalesceEnabled:false. Reap past the run deadline (T0 + RUN_TTL).
    const reaped = await store.reapDeadlines(T0 + RUN_TTL + 1, { coalesceEnabled: false });

    const row = await store.get('follower-1');
    expect(row!.status).toBe('timed_out');
    expect(row!.terminalCode).toBe('run_deadline_exceeded');
    expect(reaped.map((r) => r.runId)).toContain('follower-1'); // published by reapAndPublish
  });

  it('does NOT time out a follower still within its run deadline', async () => {
    const store = new InMemoryJobStore();
    await parkAsFollower(store, 'follower-2', T0);

    const reaped = await store.reapDeadlines(T0 + 1, { coalesceEnabled: false });

    expect((await store.get('follower-2'))!.status).toBe('waiting_for_compute');
    expect(reaped.map((r) => r.runId)).not.toContain('follower-2');
  });
});

describe.skipIf(!PG_AVAILABLE)('reapDeadlines waiting_for_compute [postgres]', () => {
  it('flag OFF: Pg reaper times out a stranded follower past its run deadline', async () => {
    const { makeStore, teardown } = await createPgSchema();
    try {
      const store = makeStore();
      await store.insertOrGet(newJob('pg-follower'));
      await store.transition('pg-follower', 'accepted', 'queued', { atMs: T0, queuedAtMs: T0 });
      const claimed = await store.claimNextQueued(T0, { workerId: 'w1', ttlMs: 30_000 });
      expect(claimed).toBeTruthy();
      await store.transition('pg-follower', 'running', 'waiting_for_compute', {
        atMs: T0,
        computeIdentity: 'ci-1',
        computeWaitAttempts: 1,
        engineAttemptCharged: false,
      }, 'w1');
      expect((await store.get('pg-follower'))!.status).toBe('waiting_for_compute');

      const reaped = await store.reapDeadlines(T0 + RUN_TTL + 1, { coalesceEnabled: false });

      const row = await store.get('pg-follower');
      expect(row!.status).toBe('timed_out');
      expect(row!.terminalCode).toBe('run_deadline_exceeded');
      expect(reaped.map((r) => r.runId)).toContain('pg-follower');
    } finally {
      await teardown();
    }
  });
});
