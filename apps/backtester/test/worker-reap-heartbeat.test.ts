// P3-4 + P3-5 — reap/wake on the heartbeat timer, and lease-renew off the synchronous engine path.
// See CODE-REVIEW-2026-07-12.md P3-4/P3-5 and docs/specs/P3-4-5-worker-reap-heartbeat.md.
//
// Both are Docker-free:
//  - P3-4 drives runWorkerLoop with a `claimNextQueued` that never resolves, so the drain loop hangs
//    forever and its body never reaches reapAndPublish — only the heartbeat timer can recover the orphan.
//  - P3-5 drives the in-process momentum path (processNextQueued, smoke-btc-1m) directly and asserts the
//    lease is renewed at the engine boundary, with no heartbeat involved at all.
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { InMemoryJobStore, type NewJob } from '../src/jobs/job-store.js';
import { processNextQueued, runWorkerLoop, type WorkerDeps } from '../src/jobs/worker.js';
import { InMemoryArtifactStore } from '../src/artifacts/store.js';
import { FixtureDataPort } from '../src/data/reader.js';
import { FIXTURES_DIR } from './helpers.js';
import { loadConfig } from '../src/config.js';

const CLOCK = 1_700_000_000_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── P3-4 ─────────────────────────────────────────────────────────────────────

function bareJob(runId: string): NewJob {
  return {
    jobId: runId, runId, requestFingerprint: `fp-${runId}`,
    request: {} as never, effectiveSeed: 1, datasetRef: 'ds',
    runTimeoutMs: 3_600_000, acceptedAtMs: CLOCK,
  };
}

describe('P3-4 — reap runs on the heartbeat timer, independent of drain completion', () => {
  it('recovers a crashed-worker orphan even while the drain loop is stuck', async () => {
    const store = new InMemoryJobStore();
    // A running job claimed by a now-dead worker with a short lease.
    await store.insertOrGet(bareJob('orphan'));
    await store.transition('orphan', 'accepted', 'queued', { atMs: CLOCK, queuedAtMs: CLOCK });
    await store.claimNextQueued(CLOCK, { workerId: 'dead-worker', ttlMs: 5_000 }); // running, lease → CLOCK+5000

    const ac = new AbortController();
    // Wedge the drain: claimNextQueued hangs for the whole run ⇒ processNextQueued (and thus drainQueue)
    // never returns ⇒ the loop body's post-drain reapAndPublish is unreachable; only the timer can reap.
    // It resolves to undefined on abort ONLY so the loop can unwind cleanly at teardown (the reap under
    // test already happened via the timer, before we abort).
    store.claimNextQueued = ((): Promise<undefined> =>
      new Promise((resolve) => {
        ac.signal.addEventListener('abort', () => resolve(undefined), { once: true });
      })) as typeof store.claimNextQueued;

    const nowMs = CLOCK + 100_000; // well past the orphan's lease
    const deps = {
      store, clock: () => nowMs, uid: () => 'u', postWebhook: async () => {},
      dataPort: {} as never, artifactStore: {} as never, overlaySandbox: {} as never,
      lease: { workerId: 'live-worker', ttlMs: 30_000, maxAttempts: 3 },
    } as unknown as WorkerDeps;

    const loop = runWorkerLoop(deps, { concurrency: 1, heartbeatMs: 10, pollMs: 5, signal: ac.signal });
    const deadline = Date.now() + 3_000;
    while ((await store.get('orphan'))!.status === 'running' && Date.now() < deadline) await sleep(10);
    ac.abort();
    await loop;

    // Reaped by the TIMER (requeued: running → queued, lease cleared) despite the wedged drain.
    const reaped = (await store.get('orphan'))!;
    expect(reaped.status).toBe('queued');
    expect(reaped.leaseExpiresAt).toBeUndefined();
  }, 6_000);
});

// ── P3-5 ─────────────────────────────────────────────────────────────────────

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

function momentumJob(runId: string): NewJob {
  return {
    jobId: runId, runId, requestFingerprint: `fp-${runId}`,
    request: REQ as never, effectiveSeed: 42, datasetRef: 'smoke-btc-1m',
    runTimeoutMs: 3_600_000, acceptedAtMs: CLOCK,
  };
}

describe('P3-5 — lease is renewed at the engine boundary, off the synchronous path', () => {
  it('renews the lease immediately before the synchronous momentum engine run', async () => {
    const store = new InMemoryJobStore();
    const renews: Array<[string, number]> = [];
    const origRenew = store.renewLease.bind(store);
    store.renewLease = async (w, until) => { renews.push([w, until]); return origRenew(w, until); };

    const config = loadConfig();
    const deps = {
      store, clock: () => CLOCK, uid: () => randomUUID(), postWebhook: async () => {},
      dataPort: new FixtureDataPort(FIXTURES_DIR),
      artifactStore: new InMemoryArtifactStore(),
      overlaySandbox: config.overlaySandbox,
      lease: { workerId: 'w1', ttlMs: 30_000, maxAttempts: 3 },
    } as unknown as WorkerDeps;

    await store.insertOrGet(momentumJob('r1'));
    await store.transition('r1', 'accepted', 'queued', { atMs: CLOCK, queuedAtMs: CLOCK });

    const done = await processNextQueued(deps);
    expect(done?.status).toBe('completed');

    // No heartbeat ran (this drives processNextQueued directly) ⇒ the only path that can renew is the
    // eager renew at the engine boundary. Horizon = clock + ttl.
    expect(renews).toContainEqual(['w1', CLOCK + 30_000]);
  }, 20_000);
});
