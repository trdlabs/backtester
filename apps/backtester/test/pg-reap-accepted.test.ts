// #138 §4 — Postgres-gated discriminating test for the P2-5 accepted-reap SQL. The InMemory suite
// (queue-reap-accepted.test.ts) does not exercise the PgJobStore.reapDeadlines WHERE clause that was
// widened from `status = 'queued'` to `status IN ('queued','accepted')`, so a green Pg CI lane did not
// actually prove that branch. This suite drives a REAL PgJobStore so the Postgres lane catches a
// regression of the widened reap.
//
// Gating/pool-construction mirrors the sibling Pg suites (pg-coalesce-wake.test.ts): a throwaway
// per-run schema, createPool + migrate; skips cleanly (does not fail) when no DB is reachable.
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/db/pool';
import { DEFAULT_MIGRATIONS_DIR, migrate } from '../src/db/migrate';
import { PG_AVAILABLE } from './store-factories';
import { PgJobStore } from '../src/jobs/pg-job-store';
import type { NewJob } from '../src/jobs/job-store.js';

function acceptedJob(runId: string, queueDeadlineMs: number): NewJob {
  return {
    jobId: runId,
    runId,
    requestFingerprint: `fp-${runId}`,
    request: {} as never,
    effectiveSeed: 1,
    datasetRef: 'ds',
    queueDeadlineMs,
    runTimeoutMs: 3_600_000,
    acceptedAtMs: 1000,
  };
}

describe.skipIf(!PG_AVAILABLE)('reapDeadlines expires stuck accepted on PgJobStore (Postgres conformance)', () => {
  const PG_URL = (process.env.BACKTESTER_TEST_DATABASE_URL ?? process.env.DATABASE_URL) as string;
  const schema = `bt_test_ra_${process.pid}_${Date.now().toString(36)}`;
  let adminPool: Pool;
  let pool: ReturnType<typeof createPool>;
  let store: PgJobStore;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: PG_URL });
    await adminPool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    pool = createPool(PG_URL, schema);
    await migrate(pool, DEFAULT_MIGRATIONS_DIR);
    store = new PgJobStore(pool);
  });

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  });

  it('expires an accepted job past its queue deadline (never transitioned to queued)', async () => {
    // insertOrGet lands the job in `accepted`; the crash happened before the transition to `queued`.
    await store.insertOrGet(acceptedJob('pg-acc-late', /* queueDeadlineMs */ 1000));
    expect((await store.get('pg-acc-late'))?.status).toBe('accepted');

    const reaped = await store.reapDeadlines(5000); // now (5000) > deadline (1000)

    const row = await store.get('pg-acc-late');
    expect(row?.status).toBe('expired');
    expect(row?.terminalCode).toBe('queue_deadline_exceeded');
    expect(reaped.map((j) => j.runId)).toContain('pg-acc-late');
  });

  it('does not expire an accepted job before its queue deadline', async () => {
    await store.insertOrGet(acceptedJob('pg-acc-fresh', /* queueDeadlineMs */ 9_000));
    await store.reapDeadlines(5000); // now (5000) < deadline (9000)
    expect((await store.get('pg-acc-fresh'))?.status).toBe('accepted');
  });
});
