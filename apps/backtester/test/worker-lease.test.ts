import { describe, expect, it } from 'vitest';
import { InMemoryJobStore, type JobStore, type NewJob } from '../src/jobs/job-store.js';
import { reapAndPublish } from '../src/jobs/completion.js';
import { PG_AVAILABLE, STORE_FACTORIES } from './store-factories.js';

function newJob(runId: string): NewJob {
  return {
    jobId: runId, runId, requestFingerprint: `fp-${runId}`,
    request: {} as never, effectiveSeed: 1, datasetRef: 'ds',
    runTimeoutMs: 3_600_000, acceptedAtMs: 1000,
  };
}
async function enqueue(store: JobStore, runId: string) {
  await store.insertOrGet(newJob(runId));
  await store.transition(runId, 'accepted', 'queued', { atMs: 1000, queuedAtMs: 1000 });
}

describe('store lease', () => {
  it('claim with a lease sets leasedBy/leaseExpiresAt/attempts', async () => {
    const store = new InMemoryJobStore();
    await enqueue(store, 'r1');
    const claimed = await store.claimNextQueued(5000, { workerId: 'w1', ttlMs: 30_000 });
    expect(claimed?.runId).toBe('r1');
    const row = await store.get('r1');
    expect(row?.leasedBy).toBe('w1');
    expect(row?.leaseExpiresAt).toBe(35_000);
    expect(row?.attempts).toBe(1);
  });

  it('renewLease extends only this worker\'s running jobs', async () => {
    const store = new InMemoryJobStore();
    await enqueue(store, 'r1');
    await store.claimNextQueued(5000, { workerId: 'w1', ttlMs: 30_000 });
    await store.renewLease('w1', 99_000);
    expect((await store.get('r1'))?.leaseExpiresAt).toBe(99_000);
    await store.renewLease('w2', 123_000); // different worker — no-op
    expect((await store.get('r1'))?.leaseExpiresAt).toBe(99_000);
  });

  it('owner-guarded transition rejects a non-owner', async () => {
    const store = new InMemoryJobStore();
    await enqueue(store, 'r1');
    await store.claimNextQueued(5000, { workerId: 'w1', ttlMs: 30_000 });
    const wrong = await store.transition('r1', 'running', 'completed', { atMs: 6000 }, 'w2');
    expect(wrong).toBe(false);
    const right = await store.transition('r1', 'running', 'completed', { atMs: 6000 }, 'w1');
    expect(right).toBe(true);
  });
});

describe('store lease — reap/requeue', () => {
  it('requeues an expired-lease running job under the attempts cap', async () => {
    const store = new InMemoryJobStore();
    await store.insertOrGet(newJob('r1'));
    await store.transition('r1', 'accepted', 'queued', { atMs: 1000, queuedAtMs: 1000 });
    await store.claimNextQueued(5000, { workerId: 'w1', ttlMs: 1000 }); // lease expires at 6000
    const reaped = await store.reapDeadlines(10_000, { leaseMaxAttempts: 3 });
    expect(reaped).toEqual([]); // requeue is non-terminal → not returned
    const row = await store.get('r1');
    expect(row?.status).toBe('queued');
    expect(row?.leasedBy).toBeUndefined();
    expect(row?.attempts).toBe(1); // attempts is NOT reset; next claim makes it 2
  });

  it('fails (poison) an expired-lease job at the attempts cap', async () => {
    const store = new InMemoryJobStore();
    await store.insertOrGet(newJob('r1'));
    await store.transition('r1', 'accepted', 'queued', { atMs: 1000, queuedAtMs: 1000 });
    // claim 3 times (cap=3): each claim increments attempts; re-queue between claims
    for (let i = 0; i < 3; i += 1) {
      await store.claimNextQueued(5000 + i, { workerId: 'w1', ttlMs: 500 });
      if (i < 2) await store.reapDeadlines(10_000 + i, { leaseMaxAttempts: 3 });
    }
    const reaped = await store.reapDeadlines(20_000, { leaseMaxAttempts: 3 });
    expect(reaped.map((r) => r.runId)).toContain('r1');
    const row = await store.get('r1');
    expect(row?.status).toBe('failed');
    expect(row?.terminalCode).toBe('lease_expired');
  });

  it('leaves a healthy (unexpired-lease) running job untouched', async () => {
    const store = new InMemoryJobStore();
    await store.insertOrGet(newJob('r1'));
    await store.transition('r1', 'accepted', 'queued', { atMs: 1000, queuedAtMs: 1000 });
    await store.claimNextQueued(5000, { workerId: 'w1', ttlMs: 30_000 }); // expires 35000
    await store.reapDeadlines(10_000, { leaseMaxAttempts: 3 });
    expect((await store.get('r1'))?.status).toBe('running');
  });
});

describe('reapAndPublish — leaseMaxAttempts wiring', () => {
  it('poisons a first-attempt expired-lease job when cap=1', async () => {
    const store = new InMemoryJobStore();
    await enqueue(store, 'r1');
    const t = 5000;
    await store.claimNextQueued(t, { workerId: 'w1', ttlMs: 500 }); // attempts→1, expires at 5500
    await reapAndPublish(
      { store, clock: () => t + 10_000, uid: () => 'u1', postWebhook: async () => {} },
      { leaseMaxAttempts: 1 },
    );
    const row = await store.get('r1');
    expect(row?.status).toBe('failed');
    expect(row?.terminalCode).toBe('lease_expired');
  });

  it('requeues the same first-attempt job when cap defaults to 3', async () => {
    const store = new InMemoryJobStore();
    await enqueue(store, 'r2');
    const t = 5000;
    await store.claimNextQueued(t, { workerId: 'w1', ttlMs: 500 }); // attempts→1, expires at 5500
    // Call without opts — store defaults leaseMaxAttempts to 3, so attempts(1) < cap → requeue
    await reapAndPublish({ store, clock: () => t + 10_000, uid: () => 'u2', postWebhook: async () => {} });
    const row = await store.get('r2');
    expect(row?.status).toBe('queued');
  });
});

const pgFactory = STORE_FACTORIES.find((f) => f.name === 'postgres')!;

describe.skipIf(!PG_AVAILABLE)('renewLease [postgres]', () => {
  it('renewLease extends leaseExpiresAt and is scoped to the worker', async () => {
    const { store, teardown } = await pgFactory.create();
    try {
      await enqueue(store, 'r1');
      await store.claimNextQueued(5000, { workerId: 'w1', ttlMs: 30_000 });

      await store.renewLease('w1', 99_000);
      expect((await store.get('r1'))?.leaseExpiresAt).toBe(99_000);

      // Different worker — must not change the lease.
      await store.renewLease('w2', 123_000);
      expect((await store.get('r1'))?.leaseExpiresAt).toBe(99_000);
    } finally {
      await teardown();
    }
  });

  it('transition applies an explicit attempts patch and leaves attempts unchanged when omitted', async () => {
    const { store, teardown } = await pgFactory.create();
    try {
      await enqueue(store, 'r1');
      await store.claimNextQueued(5000, { workerId: 'w1', ttlMs: 30_000 }); // attempts -> 1
      expect((await store.get('r1'))?.attempts).toBe(1);

      // No `attempts` field in the patch — must be a no-op (COALESCE($n, attempts)).
      await store.transition('r1', 'running', 'queued', { atMs: 6000 }, 'w1');
      expect((await store.get('r1'))?.attempts).toBe(1);

      // Explicit `attempts` patch — must write through (deferred engine-commit charge).
      await store.transition('r1', 'queued', 'running', { atMs: 7000, attempts: 5 });
      expect((await store.get('r1'))?.attempts).toBe(5);
    } finally {
      await teardown();
    }
  });
});
