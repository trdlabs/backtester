// countQueueStats conformance over both stores (Pg leg auto-skips without a DB — REQUIRED gate
// pattern, see pg-compute-lock.test.ts). Uses the same STORE_FACTORIES loop + NewJob-literal
// construction as concurrent-claim.test.ts.
import { describe, expect, it } from 'vitest';
import type { NewJob } from '../src/jobs/job-store.js';
import { runBody } from './helpers.js';
import { STORE_FACTORIES } from './store-factories.js';

function seedJob(i: number): NewJob {
  return {
    jobId: `j-${i}`,
    runId: `j-${i}`,
    requestFingerprint: `fp-${i}`,
    request: { ...runBody(), runId: `j-${i}` },
    effectiveSeed: 42,
    datasetRef: 'smoke-btc-1m',
    runTimeoutMs: 3_600_000,
    acceptedAtMs: 1_700_000_000_000 + i,
  };
}

for (const factory of STORE_FACTORIES) {
  describe.skipIf(!factory.available)(`countQueueStats (${factory.name})`, () => {
    it('returns depth 0 and null age on an empty queue', async () => {
      const { store, teardown } = await factory.create();
      try {
        expect(await store.countQueueStats(1_000_000)).toEqual({ depth: 0, oldestQueuedAgeMs: null });
      } finally {
        await teardown();
      }
    });

    it('counts queued jobs and ages from the oldest queued_at_ms', async () => {
      const { store, teardown } = await factory.create();
      try {
        // Two jobs queued at t=1000 and t=4000; one job left in 'accepted' (must not count).
        await store.insertOrGet(seedJob(0));
        await store.transition('j-0', 'accepted', 'queued', { atMs: 1000, queuedAtMs: 1000 });

        await store.insertOrGet(seedJob(1));
        await store.transition('j-1', 'accepted', 'queued', { atMs: 4000, queuedAtMs: 4000 });

        await store.insertOrGet(seedJob(2)); // stays 'accepted'

        const stats = await store.countQueueStats(10_000);
        expect(stats.depth).toBe(2);
        expect(stats.oldestQueuedAgeMs).toBe(9_000); // 10_000 - 1000
      } finally {
        await teardown();
      }
    });
  });
}
