import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/db/pool';
import { DEFAULT_MIGRATIONS_DIR, migrate } from '../src/db/migrate';
import { PG_AVAILABLE } from './store-factories';
import { PgComputeLockStore } from '../src/jobs/coalesce/pg-compute-lock';

// Postgres conformance — same gating (BACKTESTER_TEST_DATABASE_URL / DATABASE_URL, probed once in
// store-factories.ts's PG_AVAILABLE) and pool-construction (createPool + migrate over a throwaway
// per-run schema) as the PgResultCache suite. Skips cleanly (does not fail) when no DB is reachable.
describe.skipIf(!PG_AVAILABLE)('PgComputeLockStore (Postgres conformance)', () => {
  const PG_URL = (process.env.BACKTESTER_TEST_DATABASE_URL ?? process.env.DATABASE_URL) as string;
  const schema = `bt_test_cl_${process.pid}_${Date.now().toString(36)}`;
  let adminPool: Pool;
  let pool: ReturnType<typeof createPool>;
  let store: PgComputeLockStore;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: PG_URL });
    await adminPool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    pool = createPool(PG_URL, schema);
    await migrate(pool, DEFAULT_MIGRATIONS_DIR);
    store = new PgComputeLockStore(pool);
  });

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  });

  it('acquire wins on empty/expired, loses while alive, renews/expires by owner', async () => {
    expect(await store.acquire('ci1', 'run-A', 'w1', 1000, 100)).toBe(true);
    expect(await store.acquire('ci1', 'run-B', 'w2', 1050, 100)).toBe(false);
    expect(await store.acquire('ci1', 'run-B', 'w2', 1200, 100)).toBe(true); // 1200 > 1100 → takeover
    await store.renew('ci1', 'w1', 9999); // not owner (w2) → no-op
    expect((await store.get('ci1'))?.lockOwnerWorkerId).toBe('w2');
    await store.expire('ci1', 'w2', 5000); // owner → proactive expire
    expect(await store.acquire('ci1', 'run-C', 'w3', 5001, 100)).toBe(true);
  });
});
