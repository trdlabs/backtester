import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { PgNoveltyPool } from '../src/jobs/ledger/pg-novelty-pool.js';
import type { PoolRecord } from '../src/jobs/ledger/novelty-pool.js';

function fakePool(calls: { sql: string; params: unknown[] }[], result: { rowCount?: number; rows?: unknown[] }): Pool {
  return {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return result;
    },
  } as unknown as Pool;
}

const rec: PoolRecord = {
  comparabilityKey: 'k',
  requestFingerprint: 'fp1',
  runId: 'r1',
  resultHash: 'h1',
  dailyDeltas: [{ day: 'd1', delta: 1 }],
  createdAtMs: 5,
};

describe('PgNoveltyPool', () => {
  it('recordIfNew INSERTs with ON CONFLICT DO NOTHING and reports insertion', async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const inserted = await new PgNoveltyPool(fakePool(calls, { rowCount: 1 })).recordIfNew(rec);
    expect(inserted).toBe(true);
    expect(calls[0].sql).toMatch(/ON CONFLICT \(comparability_key, request_fingerprint\) DO NOTHING/);
    expect(calls[0].params[0]).toBe('k');
    expect(calls[0].params[4]).toBeNull(); // family_key omitted → null
    expect(calls[0].params[5]).toBe(JSON.stringify(rec.dailyDeltas));
  });
  it('recordIfNew reports false when nothing inserted (conflict)', async () => {
    const inserted = await new PgNoveltyPool(fakePool([], { rowCount: 0 })).recordIfNew(rec);
    expect(inserted).toBe(false);
  });
  it('query without exclude has no fingerprint predicate', async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    await new PgNoveltyPool(fakePool(calls, { rows: [] })).query('k');
    expect(calls[0].sql).toContain('WHERE comparability_key = $1');
    expect(calls[0].sql).not.toContain('request_fingerprint <>');
    expect(calls[0].params).toEqual(['k']);
  });
  it('query with exclude adds the fingerprint predicate + param', async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    await new PgNoveltyPool(fakePool(calls, { rows: [] })).query('k', { excludeRequestFingerprint: 'fp1' });
    expect(calls[0].sql).toContain('request_fingerprint <> $2');
    expect(calls[0].params).toEqual(['k', 'fp1']);
  });
  it('maps rows back (bigint createdAtMs as string, null family_key omitted)', async () => {
    const row = {
      comparability_key: 'k',
      request_fingerprint: 'fp1',
      run_id: 'r1',
      result_hash: 'h1',
      family_key: null,
      daily_deltas: [{ day: 'd1', delta: 1 }],
      created_at_ms: '5',
    };
    const out = await new PgNoveltyPool(fakePool([], { rows: [row] })).query('k');
    expect(out[0]).toEqual(rec);
  });
});
