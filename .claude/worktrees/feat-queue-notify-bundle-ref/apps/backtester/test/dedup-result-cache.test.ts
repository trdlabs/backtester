import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryResultCache, type CacheEntry, type ResultCache } from '../src/jobs/dedup/result-cache';
import { PgResultCache } from '../src/jobs/dedup/pg-result-cache';
import { createPool } from '../src/db/pool';
import { DEFAULT_MIGRATIONS_DIR, migrate } from '../src/db/migrate';
import { PG_AVAILABLE } from './store-factories';

const entry = (id: string): CacheEntry => ({
  computeIdentity: id,
  requestFingerprint: 'fp',
  datasetFingerprint: 'ds',
  computeVersion: '1',
  sandboxPolicyVersion: 'sp',
  templateRef: 'sha256:abc',
  createdAtMs: 1,
});

describe('InMemoryResultCache', () => {
  it('miss then hit round-trips', async () => {
    const c = new InMemoryResultCache();
    expect(await c.lookup('k')).toBeUndefined();
    await c.put(entry('k'));
    expect(await c.lookup('k')).toEqual(entry('k'));
  });
  it('put is idempotent (first writer wins)', async () => {
    const c = new InMemoryResultCache();
    await c.put(entry('k'));
    await c.put({ ...entry('k'), templateRef: 'sha256:other' });
    expect((await c.lookup('k'))?.templateRef).toBe('sha256:abc');
  });
});

// Postgres conformance — same gating (BACKTESTER_TEST_DATABASE_URL / DATABASE_URL, probed once in
// store-factories.ts's PG_AVAILABLE) and pool-construction (createPool + migrate over a throwaway
// per-run schema) as the PgJobStore suites. Skips cleanly (does not fail) when no DB is reachable.
describe.skipIf(!PG_AVAILABLE)('PgResultCache (Postgres conformance)', () => {
  const PG_URL = (process.env.BACKTESTER_TEST_DATABASE_URL ?? process.env.DATABASE_URL) as string;
  const schema = `bt_test_rc_${process.pid}_${Date.now().toString(36)}`;
  let adminPool: Pool;
  let pool: ReturnType<typeof createPool>;
  let cache: ResultCache;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: PG_URL });
    await adminPool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    pool = createPool(PG_URL, schema);
    await migrate(pool, DEFAULT_MIGRATIONS_DIR);
    cache = new PgResultCache(pool);
  });

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  });

  it('miss then hit round-trips', async () => {
    expect(await cache.lookup('k')).toBeUndefined();
    await cache.put(entry('k'));
    expect(await cache.lookup('k')).toEqual(entry('k'));
  });
  it('put is idempotent (first writer wins)', async () => {
    await cache.put(entry('k2'));
    await cache.put({ ...entry('k2'), templateRef: 'sha256:other' });
    expect((await cache.lookup('k2'))?.templateRef).toBe('sha256:abc');
  });
});
