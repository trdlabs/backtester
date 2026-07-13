import { describe, expect, it } from 'vitest';
import {
  InMemoryNoveltyPool,
  computeComparabilityKey,
  type PoolRecord,
} from '../src/jobs/ledger/novelty-pool.js';

function rec(over: Partial<PoolRecord> = {}): PoolRecord {
  return {
    comparabilityKey: 'k',
    requestFingerprint: 'fp1',
    runId: 'r1',
    resultHash: 'h1',
    dailyDeltas: [{ day: 'd1', delta: 1 }],
    createdAtMs: 1,
    ...over,
  };
}

describe('computeComparabilityKey', () => {
  it('is order-insensitive in symbols and excludes period/hint', () => {
    const a = computeComparabilityKey({ datasetRef: 'ds', symbols: ['BTC', 'ETH'], timeframe: '1m' });
    const b = computeComparabilityKey({ datasetRef: 'ds', symbols: ['ETH', 'BTC'], timeframe: '1m' });
    expect(a).toBe(b);
  });
  it('differs on datasetRef / timeframe', () => {
    const a = computeComparabilityKey({ datasetRef: 'ds', symbols: ['BTC'], timeframe: '1m' });
    const c = computeComparabilityKey({ datasetRef: 'ds', symbols: ['BTC'], timeframe: '1h' });
    expect(a).not.toBe(c);
  });
  it('differs on datasetRef alone (symbols/timeframe held fixed)', () => {
    const a = computeComparabilityKey({ datasetRef: 'ds1', symbols: ['BTC'], timeframe: '1m' });
    const b = computeComparabilityKey({ datasetRef: 'ds2', symbols: ['BTC'], timeframe: '1m' });
    expect(a).not.toBe(b);
  });
});

describe('InMemoryNoveltyPool', () => {
  it('recordIfNew dedupes on (comparabilityKey, requestFingerprint)', async () => {
    const pool = new InMemoryNoveltyPool();
    expect(await pool.recordIfNew(rec())).toBe(true);
    expect(await pool.recordIfNew(rec())).toBe(false); // same fp → no second row
    expect((await pool.query('k')).length).toBe(1);
  });
  it('different fingerprint, same key → two rows', async () => {
    const pool = new InMemoryNoveltyPool();
    await pool.recordIfNew(rec({ requestFingerprint: 'fp1', createdAtMs: 1 }));
    await pool.recordIfNew(rec({ requestFingerprint: 'fp2', runId: 'r2', createdAtMs: 2 }));
    expect((await pool.query('k')).length).toBe(2);
  });
  it('query excludes the caller’s own fingerprint', async () => {
    const pool = new InMemoryNoveltyPool();
    await pool.recordIfNew(rec({ requestFingerprint: 'fp1' }));
    await pool.recordIfNew(rec({ requestFingerprint: 'fp2', runId: 'r2', createdAtMs: 2 }));
    const others = await pool.query('k', { excludeRequestFingerprint: 'fp1' });
    expect(others.map((r) => r.requestFingerprint)).toEqual(['fp2']);
  });
  it('query returns [] for an unknown key', async () => {
    expect(await new InMemoryNoveltyPool().query('nope')).toEqual([]);
  });
  it('query sorts by createdAtMs ASC even when inserted out of order', async () => {
    const pool = new InMemoryNoveltyPool();
    // Inserted with the LARGER createdAtMs first — insertion order alone would fail the assertion below.
    await pool.recordIfNew(rec({ requestFingerprint: 'fp2', runId: 'r2', createdAtMs: 20 }));
    await pool.recordIfNew(rec({ requestFingerprint: 'fp1', runId: 'r1', createdAtMs: 10 }));
    const rows = await pool.query('k');
    expect(rows.map((r) => r.runId)).toEqual(['r1', 'r2']);
  });
  it('query breaks createdAtMs ties by runId ASC', async () => {
    const pool = new InMemoryNoveltyPool();
    // Same createdAtMs, inserted with the LATER runId first — insertion order alone would fail the tie-break.
    await pool.recordIfNew(rec({ requestFingerprint: 'fp2', runId: 'r2', createdAtMs: 5 }));
    await pool.recordIfNew(rec({ requestFingerprint: 'fp1', runId: 'r1', createdAtMs: 5 }));
    const rows = await pool.query('k');
    expect(rows.map((r) => r.runId)).toEqual(['r1', 'r2']);
  });
});
