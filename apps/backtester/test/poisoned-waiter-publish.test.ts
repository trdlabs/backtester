// P2-6 — a coalescing follower poisoned on the WAKE path (wakeComputeWaiters -> poisonComputeWaiter ->
// failed(compute_wait_exhausted)) never had its completion published, unlike the reaper path. The owner
// only learned by polling. wakeComputeWaiters must now surface the poisoned rows and the maintenance
// callers must publish them. See CODE-REVIEW-2026-07-12.md P2-6 and docs/specs/P2-5-6-7-queue-reliability.md.
import { describe, expect, it } from 'vitest';
import { InMemoryJobStore, type NewJob } from '../src/jobs/job-store.js';
import { runWorkerLoop, type WorkerDeps } from '../src/jobs/worker.js';
import { wakeComputeWaiters } from '../src/jobs/coalesce/wake.js';
import { InMemoryComputeLockStore } from '../src/jobs/coalesce/compute-lock.js';
import { InMemoryResultCache } from '../src/jobs/dedup/result-cache.js';

const CLOCK = 1_700_000_000_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function followerJob(runId: string, callbackUrl?: string): NewJob {
  return {
    jobId: runId, runId, requestFingerprint: `fp-${runId}`,
    request: {} as never, effectiveSeed: 1, datasetRef: 'ds', runTimeoutMs: 3_600_000, acceptedAtMs: CLOCK,
    ...(callbackUrl ? { callbackUrl } : {}),
  };
}

// Park a follower in waiting_for_compute with its compute-wait counter already exhausted, so wake poisons it.
async function parkExhaustedFollower(store: InMemoryJobStore, runId: string, ci: string, callbackUrl?: string) {
  await store.insertOrGet(followerJob(runId, callbackUrl));
  await store.transition(runId, 'accepted', 'queued', { atMs: CLOCK, queuedAtMs: CLOCK });
  await store.claimNextQueued(CLOCK, { workerId: 'w-lead', ttlMs: 30_000 });
  await store.transition(runId, 'running', 'waiting_for_compute', {
    atMs: CLOCK, computeIdentity: ci, computeWaitAttempts: 3, engineAttemptCharged: false,
  }, 'w-lead');
}

describe('P2-6 — wake-path poison surfaces its rows and gets published', () => {
  it('returns the poisoned rows only for the CAS winner (exactly-once at the source)', async () => {
    const store = new InMemoryJobStore();
    await parkExhaustedFollower(store, 'f1', 'ci-1');

    const wakeDeps = {
      store, resultCache: new InMemoryResultCache(), computeLock: new InMemoryComputeLockStore(),
      clock: () => CLOCK + 1_000, computeWaitMaxAttempts: 3,
    };
    const first = await wakeComputeWaiters(wakeDeps);
    const second = await wakeComputeWaiters(wakeDeps);

    expect(first.poisonedJobs.map((j) => j.runId)).toEqual(['f1']); // winner sees the row
    expect(first.poisonedJobs[0]!.status).toBe('failed');
    expect(second.poisonedJobs).toHaveLength(0); // already terminal — never surfaced twice
  });

  it('publishes a completion (webhook) for a follower poisoned on the heartbeat timer', async () => {
    const store = new InMemoryJobStore();
    await parkExhaustedFollower(store, 'follower', 'ci-1', 'https://cb.example/hook');
    expect((await store.get('follower'))!.status).toBe('waiting_for_compute');

    const ac = new AbortController();
    // Wedge the drain so the loop BODY's maintenance is unreachable — only the beat's coalesceMaintain
    // can poison-and-publish. Resolves undefined on abort so the loop unwinds cleanly at teardown.
    store.claimNextQueued = ((): Promise<undefined> =>
      new Promise((resolve) => {
        ac.signal.addEventListener('abort', () => resolve(undefined), { once: true });
      })) as typeof store.claimNextQueued;

    const posted: Array<{ url: string; event: { runId: string; status: string } }> = [];
    const deps = {
      store, clock: () => CLOCK + 1_000, uid: () => 'evt',
      postWebhook: async (url: string, event: unknown) => { posted.push({ url, event: event as never }); },
      dataPort: {} as never, artifactStore: {} as never, overlaySandbox: {} as never,
      lease: { workerId: 'w-live', ttlMs: 30_000, maxAttempts: 3 },
      coalesceEnabled: true, computeLock: new InMemoryComputeLockStore(), resultCache: new InMemoryResultCache(),
      computeWaitMaxAttempts: 3,
    } as unknown as WorkerDeps;

    const loop = runWorkerLoop(deps, { concurrency: 1, heartbeatMs: 10, pollMs: 5, signal: ac.signal });
    const deadline = Date.now() + 3_000;
    while ((await store.get('follower'))!.status === 'waiting_for_compute' && Date.now() < deadline) await sleep(10);
    ac.abort();
    await loop;

    // Poisoned AND published: the owner's webhook fired with a terminal failed event.
    expect((await store.get('follower'))!.status).toBe('failed');
    expect(posted.map((p) => [p.url, p.event.status])).toContainEqual(['https://cb.example/hook', 'failed']);
    expect(posted.filter((p) => p.event.runId === 'follower')).toHaveLength(1); // exactly one terminal event
  }, 6_000);
});
