import { describe, expect, it } from 'vitest';
import type { NewJob } from '../src/jobs/job-store';
import { runBody } from './helpers';
import { STORE_FACTORIES } from './store-factories';

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
  describe.skipIf(!factory.available)(`concurrent claim [${factory.name}]`, () => {
    it('never hands the same queued job to two claimers', async () => {
      const { store, teardown } = await factory.create();
      try {
        const n = 6;
        for (let i = 0; i < n; i++) {
          await store.insertOrGet(seedJob(i));
          await store.transition(`j-${i}`, 'accepted', 'queued', { atMs: 1, queuedAtMs: 1 });
        }

        // More claimers than jobs, all firing concurrently.
        const now = 1_700_000_100_000;
        const claims = await Promise.all(
          Array.from({ length: n + 4 }, (_, i) =>
            store.claimNextQueued(now, { workerId: `w${i}`, ttlMs: 30_000 }),
          ),
        );
        const claimed = claims.filter((j) => j !== undefined) as NonNullable<(typeof claims)[number]>[];
        const claimedIds = claimed.map((j) => j.runId);

        expect(new Set(claimedIds).size).toBe(claimedIds.length); // no job claimed twice
        expect(claimedIds.length).toBe(n); // each job claimed exactly once
        expect((await store.list({ status: 'queued' })).length).toBe(0);
        expect((await store.list({ status: 'running' })).length).toBe(n);

        // Lease assertions: every claimed job has a non-null leasedBy and attempts === 1.
        // Assert on the RETURNED row directly (Pg returns lease fields via RETURNING j.*).
        for (const job of claimed) {
          expect(job.leasedBy).toBeTruthy();
          expect(job.attempts).toBe(1);
          // Cross-check against the persisted row.
          const row = await store.get(job.runId);
          expect(row?.leasedBy).toBeTruthy();
          expect(row?.attempts).toBe(1);
        }
      } finally {
        await teardown();
      }
    });
  });
}
