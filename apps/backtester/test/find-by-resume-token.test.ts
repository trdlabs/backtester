// findByResumeToken conformance over both stores (Pg leg auto-skips without a DB — REQUIRED gate
// pattern, see pg-compute-lock.test.ts). Uses the same STORE_FACTORIES loop + NewJob-literal
// construction as queue-stats.test.ts.
import { describe, expect, it } from 'vitest';
import type { NewJob } from '../src/jobs/job-store.js';
import { runBody } from './helpers.js';
import { STORE_FACTORIES } from './store-factories.js';

function seedJob(i: number, opts?: { resumeToken?: string }): NewJob {
  return {
    jobId: `j-${i}`,
    runId: `j-${i}`,
    ...(opts?.resumeToken !== undefined ? { resumeToken: opts.resumeToken } : {}),
    requestFingerprint: `fp-${i}`,
    request: { ...runBody(), runId: `j-${i}` },
    effectiveSeed: 42,
    datasetRef: 'smoke-btc-1m',
    runTimeoutMs: 3_600_000,
    acceptedAtMs: 1_700_000_000_000 + i,
  };
}

for (const factory of STORE_FACTORIES) {
  describe.skipIf(!factory.available)(`findByResumeToken (${factory.name})`, () => {
    it('returns undefined when no job carries the token', async () => {
      const { store, teardown } = await factory.create();
      try {
        expect(await store.findByResumeToken('tok-none')).toBeUndefined();
      } finally {
        await teardown();
      }
    });

    it('returns the job inserted with the token, and does not match runId or other tokens', async () => {
      const { store, teardown } = await factory.create();
      try {
        await store.insertOrGet(seedJob(1, { resumeToken: 'tok-a' }));
        await store.insertOrGet(seedJob(2));

        const hit = await store.findByResumeToken('tok-a');
        expect(hit?.resumeToken).toBe('tok-a');
        expect(hit?.runId).toBe('j-1');

        expect(await store.findByResumeToken('j-2')).toBeUndefined();
      } finally {
        await teardown();
      }
    });
  });
}
