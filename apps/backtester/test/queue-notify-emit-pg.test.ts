// Postgres-gated test: PgJobStore must emit pg_notify(QUEUE_NOTIFY_CHANNEL, '') whenever a job
// becomes claimable (status -> 'queued'), so LISTEN-side waiters (queue-notify.ts) wake promptly
// instead of relying purely on poll interval. Anchored on the queued write (not the accepted
// insert) — notifying at accepted would race claimNextQueued's visibility of the row.
//
// Real harness: createPgSchema() (store-factories) for a migrated Pg store; inline newJob (mirrors
// pg-coalesce-wake.test.ts); a raw pg Client on PG_URL to LISTEN.

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PG_AVAILABLE, createPgSchema } from './store-factories.js';
import { QUEUE_NOTIFY_CHANNEL } from '../src/jobs/queue-notify-channel.js';
import type { JobStore, NewJob } from '../src/jobs/job-store.js';

const PG_URL = (process.env.BACKTESTER_TEST_DATABASE_URL ?? process.env.DATABASE_URL) as string;
const newJob = (runId: string): NewJob => ({
  jobId: runId, runId, requestFingerprint: `fp-${runId}`, request: {} as never,
  effectiveSeed: 1, datasetRef: 'ds', runTimeoutMs: 3_600_000, acceptedAtMs: 1000,
});

describe.skipIf(!PG_AVAILABLE)('PgJobStore enqueue NOTIFY', () => {
  let schema: Awaited<ReturnType<typeof createPgSchema>>;
  let store: JobStore;
  beforeAll(async () => { schema = await createPgSchema(); store = schema.makeStore(); });
  afterAll(async () => { await schema.teardown(); });

  it('fires on the accepted→queued transition', async () => {
    const listener = new Client({ connectionString: PG_URL });
    await listener.connect();
    await listener.query(`LISTEN ${QUEUE_NOTIFY_CHANNEL}`);
    const got = new Promise<void>((res) => listener.on('notification', () => res()));

    await store.insertOrGet(newJob('emit-a'));            // status 'accepted'
    await store.transition('emit-a', 'accepted', 'queued', { atMs: 1, queuedAtMs: 1 }); // → NOTIFY

    await Promise.race([got, new Promise((_r, rej) => setTimeout(() => rej(new Error('no NOTIFY')), 2_000))]);
    await listener.end();
  });
});
