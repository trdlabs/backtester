import { describe, expect, it } from 'vitest';
import { InMemoryJobStore, type NewJob } from '../src/jobs/job-store.js';

function newJob(runId: string): NewJob {
  return {
    jobId: runId, runId, requestFingerprint: `fp-${runId}`,
    request: {} as never, effectiveSeed: 1, datasetRef: 'ds',
    runTimeoutMs: 3_600_000, acceptedAtMs: 1000,
  };
}
async function enqueue(store: InMemoryJobStore, runId: string) {
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
