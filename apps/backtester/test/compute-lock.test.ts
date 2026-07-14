import { describe, expect, it } from 'vitest';
import { InMemoryComputeLockStore } from '../src/jobs/coalesce/compute-lock.js';

describe('InMemoryComputeLockStore', () => {
  it('first acquire wins; a second while alive loses', async () => {
    const s = new InMemoryComputeLockStore();
    expect(await s.acquire('ci', 'run-A', 'w1', 1000, 100)).toBe(true);
    expect(await s.acquire('ci', 'run-B', 'w2', 1050, 100)).toBe(false); // still alive (expires 1100)
    const lk = await s.get('ci');
    expect(lk?.leaderRunId).toBe('run-A');
    expect(lk?.lockExpiresAtMs).toBe(1100);
  });

  it('acquire succeeds again once the lock has expired (takeover)', async () => {
    const s = new InMemoryComputeLockStore();
    await s.acquire('ci', 'run-A', 'w1', 1000, 100);           // expires 1100
    expect(await s.acquire('ci', 'run-B', 'w2', 1200, 100)).toBe(true); // 1200 > 1100
    expect((await s.get('ci'))?.leaderRunId).toBe('run-B');
  });

  it('renew extends only for the owner; expire only for the owner', async () => {
    const s = new InMemoryComputeLockStore();
    await s.acquire('ci', 'run-A', 'w1', 1000, 100);
    await s.renew('ci', 'w2', 5000);                            // wrong owner → no-op
    expect((await s.get('ci'))?.lockExpiresAtMs).toBe(1100);
    await s.renew('ci', 'w1', 5000);                            // owner → extends
    expect((await s.get('ci'))?.lockExpiresAtMs).toBe(5000);
    await s.expire('ci', 'w2', 6000);                           // wrong owner → no-op
    expect((await s.get('ci'))?.lockExpiresAtMs).toBe(5000);
    await s.expire('ci', 'w1', 6000);                           // owner → proactive-expire
    expect((await s.get('ci'))?.lockExpiresAtMs).toBe(6000);
    expect(await s.acquire('ci', 'run-C', 'w3', 6001, 100)).toBe(true); // now takeable
  });

  // P3-6a: eager release DELETES the row (not just expires it) so the table does not grow one dead row
  // per compute. Only the owner may delete.
  it('release deletes the row for the owner; a non-owner is a no-op', async () => {
    const s = new InMemoryComputeLockStore();
    await s.acquire('ci', 'run-A', 'w1', 1000, 100);
    await s.release('ci', 'w2'); // wrong owner -> row stays
    expect(await s.get('ci')).toBeDefined();
    await s.release('ci', 'w1'); // owner -> deleted
    expect(await s.get('ci')).toBeUndefined();
  });

  // P3-6a: sweepExpired removes orphaned locks expired beyond a grace window (nowMs - olderThanMs),
  // leaving live locks (and ones expired only recently, still within grace) in place.
  it('sweepExpired removes rows expired beyond grace, keeps live and within-grace rows', async () => {
    const s = new InMemoryComputeLockStore();
    await s.acquire('alive', 'run-A', 'w1', 1000, 100); // expires 1100
    await s.acquire('old', 'run-B', 'w1', 500, 100); // expires 600
    await s.sweepExpired(2000, 1000); // threshold 1000: delete expiresAt < 1000
    expect(await s.get('old')).toBeUndefined(); // 600 < 1000 -> swept
    expect(await s.get('alive')).toBeDefined(); // 1100 >= 1000 -> kept
    await s.sweepExpired(2000, 1500); // threshold 500: nothing below -> alive kept
    expect(await s.get('alive')).toBeDefined();
  });
});
