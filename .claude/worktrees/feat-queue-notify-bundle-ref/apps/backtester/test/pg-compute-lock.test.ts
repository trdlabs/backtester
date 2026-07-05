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

  it('acquire wins on empty/expired, loses while alive; renew/expire enforce the owner guard', async () => {
    expect(await store.acquire('ci1', 'run-A', 'w1', 1000, 100)).toBe(true);
    expect(await store.acquire('ci1', 'run-B', 'w2', 1050, 100)).toBe(false);
    expect(await store.acquire('ci1', 'run-B', 'w2', 1200, 100)).toBe(true); // 1200 > 1100 → takeover, expires = 1200 + 100 = 1300

    await store.renew('ci1', 'w1', 9999); // not owner (w2) → no-op
    {
      const lk = await store.get('ci1');
      expect(lk?.lockOwnerWorkerId).toBe('w2');
      // Discriminating: a broken `AND lock_owner_worker_id = $2` guard would have written 9999 here.
      expect(lk?.lockExpiresAtMs).toBe(1300);
    }

    await store.renew('ci1', 'w2', 5000); // owner → extends
    expect((await store.get('ci1'))?.lockExpiresAtMs).toBe(5000);

    await store.expire('ci1', 'w1', 6000); // not owner (w2) → no-op
    // Discriminating: a broken owner guard would have force-expired the lock to 6000 here.
    expect((await store.get('ci1'))?.lockExpiresAtMs).toBe(5000);

    await store.expire('ci1', 'w2', 7000); // owner → proactive expire
    expect((await store.get('ci1'))?.lockExpiresAtMs).toBe(7000);
    expect(await store.acquire('ci1', 'run-C', 'w3', 7001, 100)).toBe(true); // now takeable
  });
});
