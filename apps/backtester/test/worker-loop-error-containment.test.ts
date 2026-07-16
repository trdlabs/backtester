// P2-7 — tick()/runWorkerLoop must contain per-iteration errors. Before this, void tick() had no catch
// (unhandled rejection => process exit) and runWorkerLoop's body had no try/catch (a transient Pg error in
// claimNextQueued/get propagated out => worker-main exit(1), killing sibling runs). See
// CODE-REVIEW-2026-07-12.md P2-7 and docs/specs/P2-5-6-7-queue-reliability.md.
//
// Pinned invariants (all Docker-free, InMemory):
//  1. abort ends the loop WITHOUT waiting out a backoff.
//  2. a transient store error does NOT kill the loop (promise never rejects); it keeps iterating.
//  3. under a persistent error the retry rate is bounded (no hot spin).
//  4. an erroring iteration does NOT stop the #137 heartbeat from renewing the lease.
//  5. a publish error is contained and never emits a duplicate terminal event on retry.
import { describe, expect, it } from 'vitest';
import { InMemoryJobStore, type NewJob } from '../src/jobs/job-store.js';
import { runWorkerLoop, type WorkerDeps } from '../src/jobs/worker.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const CLOCK = 1_700_000_000_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition');
    await sleep(5);
  }
}

function baseDeps(store: InMemoryJobStore, nowMs: number): WorkerDeps {
  return {
    store, clock: () => nowMs, uid: () => 'u', postWebhook: async () => {},
    dataPort: {} as never, artifactStore: {} as never, overlaySandbox: {} as never,
    lease: { workerId: 'w1', ttlMs: 30_000, maxAttempts: 3 },
  } as unknown as WorkerDeps;
}

describe('P2-7 — runWorkerLoop contains per-iteration errors', () => {
  it('survives a transient claimNextQueued error and keeps looping (does not reject)', async () => {
    const store = new InMemoryJobStore();
    let calls = 0;
    store.claimNextQueued = (async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient pg');
      return undefined;
    }) as typeof store.claimNextQueued;

    const ac = new AbortController();
    const loop = runWorkerLoop(baseDeps(store, CLOCK), {
      concurrency: 1, heartbeatMs: 10_000, pollMs: 5, signal: ac.signal,
      errorBackoffBaseMs: 5, errorBackoffMaxMs: 20,
    });
    await waitFor(() => calls >= 2);
    ac.abort();
    await loop; // must resolve, not reject with 'transient pg'
    // call #1 threw; any further call proves the loop survived the throw and kept iterating. (>=2 rather
    // than a larger count so the assertion is not flaky under full-suite CPU contention.)
    expect(calls).toBeGreaterThanOrEqual(2);
  }, 6_000);

  it('resolves promptly on abort even while parked in a long backoff', async () => {
    const store = new InMemoryJobStore();
    store.claimNextQueued = (async () => { throw new Error('always down'); }) as typeof store.claimNextQueued;

    const ac = new AbortController();
    const loop = runWorkerLoop(baseDeps(store, CLOCK), {
      concurrency: 1, heartbeatMs: 10_000, pollMs: 5, signal: ac.signal,
      errorBackoffBaseMs: 10_000, errorBackoffMaxMs: 10_000, // a long backoff we must NOT wait out on abort
    });
    await sleep(30); // now parked in the backoff sleep
    const t0 = Date.now();
    ac.abort();
    await loop;
    expect(Date.now() - t0).toBeLessThan(1_000); // abort interrupted the backoff
  }, 6_000);

  it('bounds the retry rate under a persistent error (no busy-spin)', async () => {
    const store = new InMemoryJobStore();
    let calls = 0;
    store.claimNextQueued = (async () => { calls += 1; throw new Error('always down'); }) as typeof store.claimNextQueued;

    const ac = new AbortController();
    const loop = runWorkerLoop(baseDeps(store, CLOCK), {
      concurrency: 1, heartbeatMs: 10_000, pollMs: 5, signal: ac.signal,
      errorBackoffBaseMs: 20, errorBackoffMaxMs: 40,
    });
    await sleep(250);
    ac.abort();
    await loop;
    // base 20ms → cap 40ms over ~250ms ⇒ a handful of retries. A hot loop would be hundreds/thousands.
    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThan(40);
  }, 6_000);

  it('keeps the heartbeat renewing the lease while the loop body keeps failing (#137 intact)', async () => {
    const store = new InMemoryJobStore();
    store.claimNextQueued = (async () => { throw new Error('always down'); }) as typeof store.claimNextQueued;
    let renews = 0;
    const origRenew = store.renewLease.bind(store);
    store.renewLease = async (w, until) => { renews += 1; return origRenew(w, until); };

    const ac = new AbortController();
    const loop = runWorkerLoop(baseDeps(store, CLOCK), {
      concurrency: 1, heartbeatMs: 10, pollMs: 5, signal: ac.signal,
      errorBackoffBaseMs: 5, errorBackoffMaxMs: 10,
    });
    await waitFor(() => renews > 1);
    ac.abort();
    await loop;
    expect(renews).toBeGreaterThan(1); // the beat fired repeatedly despite the failing loop body
  }, 6_000);

  it('contains a publish error and never emits a duplicate terminal event on retry', async () => {
    const store = new InMemoryJobStore();
    // A queued job already past its deadline: the loop's reapAndPublish will terminalize it (expired) and
    // publish the completion.
    const late: NewJob = {
      jobId: 'late', runId: 'late', requestFingerprint: 'fp-late', request: {} as never,
      effectiveSeed: 1, datasetRef: 'ds', queueDeadlineMs: CLOCK, runTimeoutMs: 3_600_000, acceptedAtMs: CLOCK,
    };
    await store.insertOrGet(late);
    await store.transition('late', 'accepted', 'queued', { atMs: CLOCK, queuedAtMs: CLOCK });
    store.claimNextQueued = (async () => undefined) as typeof store.claimNextQueued; // reap is the only actor

    let expiredAppendAttempts = 0;
    const origAppend = store.appendEvent.bind(store);
    store.appendEvent = async (ev) => {
      if (ev.eventType === 'job_expired') {
        expiredAppendAttempts += 1;
        if (expiredAppendAttempts === 1) throw new Error('append storm'); // publish error propagates from the body
      }
      return origAppend(ev);
    };

    const ac = new AbortController();
    // heartbeatMs long so ONLY the loop body reaps (the beat's reapAndPublish must not also fire here).
    const loop = runWorkerLoop(baseDeps(store, CLOCK + 100_000), {
      concurrency: 1, heartbeatMs: 10_000, pollMs: 5, signal: ac.signal,
      errorBackoffBaseMs: 5, errorBackoffMaxMs: 10,
    });
    await sleep(80);
    ac.abort();
    await loop;

    expect((await store.get('late'))!.status).toBe('expired'); // terminalized despite the publish error
    expect(expiredAppendAttempts).toBe(1); // retry did NOT re-publish — no duplicate terminal event
  }, 6_000);
});

describe('P2-7 — buildApp.tick() contains errors so void tick() cannot crash the process', () => {
  it('does not reject when a maintenance step throws, and stays callable', async () => {
    const app = await buildApp(loadConfig());
    try {
      app.store.reapDeadlines = async () => { throw new Error('transient pg'); };
      await expect(app.tick()).resolves.toBeUndefined(); // contained, not an unhandled rejection
      await expect(app.tick()).resolves.toBeUndefined(); // busy reset ⇒ still callable and still contained
    } finally {
      await app.dispose();
    }
  }, 10_000);
});
