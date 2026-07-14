import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryPromotionAttemptLedger, type PromotionAttemptRecord } from '../src/jobs/promotion/attempt-ledger.js';
import { createPool } from '../src/db/pool';
import { DEFAULT_MIGRATIONS_DIR, migrate } from '../src/db/migrate';
import { PG_AVAILABLE } from './store-factories';
import { PgPromotionAttemptLedger } from '../src/jobs/promotion/pg-attempt-ledger.js';

function rec(over: Partial<PromotionAttemptRecord> = {}): PromotionAttemptRecord {
  return { qualificationEpochKey: 'e', attemptIdentity: 'a1', requestFingerprint: 'fp', datasetFingerprint: 'dsf',
    runId: 'r', resultHash: 'h', verdict: 'failed', createdAtMs: 1, ...over };
}

describe('InMemoryPromotionAttemptLedger', () => {
  it('assigns monotonic attempt numbers to distinct attempts', async () => {
    const l = new InMemoryPromotionAttemptLedger();
    expect(await l.recordIfNewAndGetAttempt(rec({ attemptIdentity: 'a1' }))).toEqual({ attemptNumber: 1, inserted: true });
    expect(await l.recordIfNewAndGetAttempt(rec({ attemptIdentity: 'a2' }))).toEqual({ attemptNumber: 2, inserted: true });
  });
  it('a true replay (same identity) returns the historical number, no increment', async () => {
    const l = new InMemoryPromotionAttemptLedger();
    await l.recordIfNewAndGetAttempt(rec({ attemptIdentity: 'a1' }));
    expect(await l.recordIfNewAndGetAttempt(rec({ attemptIdentity: 'a1' }))).toEqual({ attemptNumber: 1, inserted: false });
    // next distinct attempt still gets 2 (replay did not consume the counter)
    expect(await l.recordIfNewAndGetAttempt(rec({ attemptIdentity: 'a2' }))).toEqual({ attemptNumber: 2, inserted: true });
  });
  it('a failed attempt still advances the counter (record-regardless)', async () => {
    const l = new InMemoryPromotionAttemptLedger();
    await l.recordIfNewAndGetAttempt(rec({ attemptIdentity: 'a1', verdict: 'failed' }));
    expect((await l.recordIfNewAndGetAttempt(rec({ attemptIdentity: 'a2', verdict: 'passed' }))).attemptNumber).toBe(2);
  });
  it('separate epochs count independently', async () => {
    const l = new InMemoryPromotionAttemptLedger();
    await l.recordIfNewAndGetAttempt(rec({ qualificationEpochKey: 'e1', attemptIdentity: 'a1' }));
    expect((await l.recordIfNewAndGetAttempt(rec({ qualificationEpochKey: 'e2', attemptIdentity: 'a1' }))).attemptNumber).toBe(1);
  });
});

// Postgres conformance — same gating (BACKTESTER_TEST_DATABASE_URL / DATABASE_URL, probed once in
// store-factories.ts's PG_AVAILABLE) and pool-construction (createPool + migrate over a throwaway
// per-run schema) as the other Pg-conformance suites. Skips cleanly (does not fail) when no DB is reachable.
describe.skipIf(!PG_AVAILABLE)('PgPromotionAttemptLedger — Pg concurrency (mandatory)', () => {
  const PG_URL = (process.env.BACKTESTER_TEST_DATABASE_URL ?? process.env.DATABASE_URL) as string;
  const schema = `bt_test_pal_${process.pid}_${Date.now().toString(36)}`;
  let adminPool: Pool;
  let pool: ReturnType<typeof createPool>;
  beforeAll(async () => {
    adminPool = new Pool({ connectionString: PG_URL });
    await adminPool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    pool = createPool(PG_URL, schema);
    await migrate(pool, DEFAULT_MIGRATIONS_DIR);          // applies 0009 too
  });
  afterAll(async () => {
    await pool?.end().catch(() => {});
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  });

  it('Promise.all of N DISTINCT attempts yields exactly {1..N} — no dup, no gap', async () => {
    const l = new PgPromotionAttemptLedger(pool);
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => l.recordIfNewAndGetAttempt(rec({ attemptIdentity: `a${i}` }))));
    expect(rs.every((x) => x.inserted)).toBe(true);
    expect(new Set(rs.map((x) => x.attemptNumber))).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8]));
  });

  it('concurrent replay of the SAME identity: exactly one insert, all callers see the same number', async () => {
    const l = new PgPromotionAttemptLedger(pool);
    const rs = await Promise.all(Array.from({ length: 5 }, () => l.recordIfNewAndGetAttempt(rec({ attemptIdentity: 'same' }))));
    expect(rs.filter((x) => x.inserted).length).toBe(1);           // exactly one winner inserts
    expect(new Set(rs.map((x) => x.attemptNumber))).toEqual(new Set([1])); // everyone gets number 1
    // the counter advanced exactly once → the next distinct attempt is 2
    expect((await l.recordIfNewAndGetAttempt(rec({ attemptIdentity: 'next' }))).attemptNumber).toBe(2);
  });
});

// This third case runs WITHOUT a real DB (fake pool) so it is ALWAYS exercised — keep it OUTSIDE the skipIf block.
describe('PgPromotionAttemptLedger — rollback/release (no DB)', () => {
  it('a thrown query rolls back and releases the client (no leaked connection)', async () => {
    const released = { v: false };
    const fakeClient = { query: async (sql: string) => { if (sql.startsWith('INSERT INTO backtest_promotion_attempt')) throw new Error('boom'); return { rows: [{ next_attempt: 1 }], rowCount: 0 }; }, release: () => { released.v = true; } };
    const fakePool = { connect: async () => fakeClient } as unknown as import('pg').Pool;
    await expect(new PgPromotionAttemptLedger(fakePool).recordIfNewAndGetAttempt(rec())).rejects.toThrow('boom');
    expect(released.v).toBe(true); // finally released the client even on throw
  });
});
