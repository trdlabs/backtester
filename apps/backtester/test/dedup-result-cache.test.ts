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

  // P3-6b: TTL sweep removes entries older than ttl (from createdAtMs), oldest-first, bounded by
  // batchLimit; fresh entries stay. Artifacts (templateRef) are NOT touched — the sweep only takes the
  // cache store, never an artifact store.
  it('sweepExpired removes entries older than the TTL, oldest-first, bounded by batchLimit', async () => {
    const c = new InMemoryResultCache();
    await c.put({ ...entry('old1'), createdAtMs: 100 });
    await c.put({ ...entry('old2'), createdAtMs: 200 });
    await c.put({ ...entry('fresh'), createdAtMs: 10_000 });
    // now 10_500, ttl 1000 → threshold 9_500: old1/old2 eligible; batchLimit 1 → oldest only.
    expect(await c.sweepExpired(10_500, 1000, 1)).toBe(1);
    expect(await c.lookup('old1')).toBeUndefined();
    expect(await c.lookup('old2')).toBeDefined();
    expect(await c.sweepExpired(10_500, 1000, 10)).toBe(1); // old2
    expect(await c.lookup('fresh')).toBeDefined();
  });

  // P3-6b: TTL is from the ORIGINAL createdAtMs — lookup must NOT refresh it (no refresh-on-hit).
  it('lookup does not refresh createdAtMs (TTL from original createdAtMs)', async () => {
    const c = new InMemoryResultCache();
    await c.put({ ...entry('k'), createdAtMs: 100 });
    await c.lookup('k'); // a hit must not bump createdAtMs
    expect((await c.lookup('k'))?.createdAtMs).toBe(100);
    expect(await c.sweepExpired(2000, 1000, 10)).toBe(1); // still evicted by its original time
    expect(await c.lookup('k')).toBeUndefined();
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

  it('sweepExpired removes entries older than the TTL, bounded; keeps fresh', async () => {
    await cache.put({ ...entry('sw-old'), createdAtMs: 100 });
    await cache.put({ ...entry('sw-fresh'), createdAtMs: 10_000 });
    const n = await cache.sweepExpired(10_500, 1000, 100); // threshold 9_500 → old removed
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await cache.lookup('sw-old')).toBeUndefined();
    expect(await cache.lookup('sw-fresh')).toBeDefined();
  });
});
