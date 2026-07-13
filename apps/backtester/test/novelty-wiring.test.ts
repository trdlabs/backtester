// E5a — worker finalize wiring for the novelty gate. Pins: flag OFF ⇒ no field; flag ON ⇒ score
// computed vs the prior pool; query → score → record with self-exclusion under replay; empty candidate
// not recorded. resultHash invariance is structural (novelty merged onto the projection AFTER
// contentRef) + the flag-OFF goldens elsewhere.

import { describe, expect, it } from 'vitest';
import { resolveNovelty, type WorkerDeps } from '../src/jobs/worker.js';
import { InMemoryNoveltyPool, computeComparabilityKey, type NoveltyPool } from '../src/jobs/ledger/novelty-pool.js';

const DAY = 86_400_000;
function equityCurve(vals: number[]) {
  return vals.map((equity, i) => ({ barIndex: i, barTs: i * DAY, equity }));
}
function outcome(vals: number[]) {
  return {
    status: 'completed',
    baseline: { trades: [], evidence: { equityCurve: equityCurve(vals) }, summary: { barsProcessed: vals.length, ordersCount: 0 } },
  } as unknown as Parameters<typeof resolveNovelty>[2];
}
function claimed(over: { requestFingerprint?: string; runId?: string } = {}) {
  return {
    runId: over.runId ?? 'r1',
    requestFingerprint: over.requestFingerprint ?? 'fp1',
    datasetRef: 'ds',
    request: { symbols: ['BTC'], timeframe: '1m' },
  } as unknown as Parameters<typeof resolveNovelty>[1];
}
function deps(over: Partial<WorkerDeps>): WorkerDeps {
  return { ...over } as unknown as WorkerDeps;
}
const KEY = computeComparabilityKey({ datasetRef: 'ds', symbols: ['BTC'], timeframe: '1m' });
// 4 equity points → 3 daily deltas, enough for minOverlapDays: 2
const SERIES = [100, 110, 105, 130];

describe('resolveNovelty — E1b-style worker wiring', () => {
  it('flag OFF ⇒ undefined', async () => {
    expect(await resolveNovelty(deps({}), claimed(), outcome(SERIES), 'h1')).toBeUndefined();
  });

  it('empty pool ⇒ no_comparators:empty_pool AND the run is recorded', async () => {
    const pool = new InMemoryNoveltyPool();
    const d = deps({ novelty: { enabled: true, threshold: 0.8, minOverlapDays: 2, pool }, clock: (() => 1) as WorkerDeps['clock'] });
    const r = await resolveNovelty(d, claimed(), outcome(SERIES), 'h1');
    expect(r).toMatchObject({ status: 'no_comparators', reason: 'empty_pool', comparabilityKey: KEY });
    expect((await pool.query(KEY)).length).toBe(1); // recorded
  });

  it('empty candidate (single close-day) ⇒ empty_candidate AND NOT recorded', async () => {
    const pool = new InMemoryNoveltyPool();
    const d = deps({ novelty: { enabled: true, threshold: 0.8, minOverlapDays: 2, pool }, clock: (() => 1) as WorkerDeps['clock'] });
    // both points on the same UTC day → 0 deltas
    const oneDay = { status: 'completed', baseline: { trades: [], evidence: { equityCurve: [{ barIndex: 0, barTs: 0, equity: 100 }, { barIndex: 1, barTs: 3_600_000, equity: 110 }] }, summary: { barsProcessed: 2, ordersCount: 0 } } } as unknown as Parameters<typeof resolveNovelty>[2];
    const r = await resolveNovelty(d, claimed(), oneDay, 'h1');
    expect(r).toMatchObject({ status: 'no_comparators', reason: 'empty_candidate' });
    expect((await pool.query(KEY)).length).toBe(0); // NOT recorded
  });

  it('seeded correlated member ⇒ resolved behavioralDuplicate; replay self-excludes', async () => {
    const pool = new InMemoryNoveltyPool();
    const d = deps({ novelty: { enabled: true, threshold: 0.8, minOverlapDays: 2, pool }, clock: (() => 1) as WorkerDeps['clock'] });
    // first run fp1 records itself
    await resolveNovelty(d, claimed({ requestFingerprint: 'fp1', runId: 'r1' }), outcome(SERIES), 'h1');
    // second run fp2, identical trajectory → duplicate of fp1
    const r2 = await resolveNovelty(d, claimed({ requestFingerprint: 'fp2', runId: 'r2' }), outcome(SERIES), 'h2');
    expect(r2).toMatchObject({ status: 'resolved', behavioralDuplicate: true });
    // replay of fp1 must NOT see itself → not a duplicate against itself
    const replay = await resolveNovelty(d, claimed({ requestFingerprint: 'fp1', runId: 'r1' }), outcome(SERIES), 'h1');
    expect(replay?.status).toBe('resolved');
    if (replay?.status === 'resolved') expect(replay.nearest.ref).not.toBe('h1');
  });

  it('pool.query rejects ⇒ resolveNovelty resolves to undefined (never throws)', async () => {
    const throwingPool = {
      query: async () => {
        throw new Error('boom');
      },
      recordIfNew: async () => {
        throw new Error('boom');
      },
    } as unknown as NoveltyPool;
    const d = deps({
      novelty: { enabled: true, threshold: 0.8, minOverlapDays: 2, pool: throwingPool },
      clock: (() => 1) as WorkerDeps['clock'],
    });
    await expect(resolveNovelty(d, claimed(), outcome(SERIES), 'h1')).resolves.toBeUndefined();
  });

  it('pool.query resolves but recordIfNew rejects ⇒ score preserved, no throw', async () => {
    const flakyWritePool = {
      query: async () => [],
      recordIfNew: async () => {
        throw new Error('boom');
      },
    } as unknown as NoveltyPool;
    const d = deps({
      novelty: { enabled: true, threshold: 0.8, minOverlapDays: 2, pool: flakyWritePool },
      clock: (() => 1) as WorkerDeps['clock'],
    });
    const r = await resolveNovelty(d, claimed(), outcome(SERIES), 'h1');
    expect(r).toMatchObject({ status: 'no_comparators', reason: 'empty_pool', comparabilityKey: KEY });
  });
});
