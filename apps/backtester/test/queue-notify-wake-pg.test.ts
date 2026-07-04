// Postgres-gated integration test: a worker running with a HIGH pollMs (10s) must still claim a
// freshly-enqueued job in well under that interval — proving the LISTEN/NOTIFY wake path fired,
// not the poll fallback. Enqueue goes through the STORE directly (insertOrGet + transition→queued),
// never through HTTP submit, so the in-process `kick()` cannot be the thing that woke the loop —
// only the PgQueueWaker's NOTIFY subscription can.
import { describe, expect, it } from 'vitest';
import { PG_AVAILABLE, STORE_FACTORIES } from './store-factories.js';
import { makeApp } from './helpers.js';
import { runWorkerLoop } from '../src/jobs/worker.js';
import { createPgQueueWaker } from '../src/jobs/queue-notify.js';
import type { NewJob } from '../src/jobs/job-store.js';

const PG_URL = (process.env.BACKTESTER_TEST_DATABASE_URL ?? process.env.DATABASE_URL) as string;
const pgFactory = STORE_FACTORIES.find((f) => f.name === 'postgres')!;
const newJob = (runId: string): NewJob => ({
  jobId: runId, runId, requestFingerprint: `fp-${runId}`, request: {} as never,
  effectiveSeed: 1, datasetRef: 'ds', runTimeoutMs: 3_600_000, acceptedAtMs: 1000,
});

describe.skipIf(!PG_AVAILABLE)('NOTIFY wake integration', () => {
  it('claims a fresh enqueue far faster than the 10s poll', async () => {
    const { app, store, cleanup } = await makeApp(pgFactory, {}, { queueNotify: true });
    const waker = createPgQueueWaker(PG_URL);
    const ac = new AbortController();
    await waker.whenReady();
    const loop = runWorkerLoop(app.workerDeps, { concurrency: 1, heartbeatMs: 1_000, pollMs: 10_000, signal: ac.signal, waker });
    await new Promise((r) => setTimeout(r, 300)); // let the loop reach its first idle wait

    const t0 = Date.now();
    await store.insertOrGet(newJob('wake-a'));
    await store.transition('wake-a', 'accepted', 'queued', { atMs: 1, queuedAtMs: 1 }); // emits NOTIFY
    for (let i = 0; i < 40 && (await store.get('wake-a'))?.status === 'queued'; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect((await store.get('wake-a'))?.status).not.toBe('queued'); // claimed
    expect(Date.now() - t0).toBeLessThan(3_000);                    // via NOTIFY, not the 10s poll

    ac.abort(); await loop; await waker.dispose(); await cleanup();
  }, 20_000);
});
