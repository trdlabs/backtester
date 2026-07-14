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

  // P3-6a: eager release DELETES the row (not just expires it), fenced by (owner, leaderRunId) so a
  // stale leader cannot delete a re-elected lock. Only the owning generation may delete.
  it('release deletes the row for the owning generation; wrong owner or stale run is a no-op', async () => {
    const s = new InMemoryComputeLockStore();
    await s.acquire('ci', 'run-A', 'w1', 1000, 100);
    await s.release('ci', 'w2', 'run-A'); // wrong owner -> row stays
    expect(await s.get('ci')).toBeDefined();
    await s.release('ci', 'w1', 'run-A'); // owner + run -> deleted
    expect(await s.get('ci')).toBeUndefined();
  });

  // P3-6a (review): a stale leader (same workerId, OLD run) must NOT delete a lock a NEW run re-acquired
  // under the same workerId after takeover — the release is fenced on leaderRunId too.
  it('a stale run does NOT release a re-elected lock held by a new run under the same workerId', async () => {
    const s = new InMemoryComputeLockStore();
    await s.acquire('ci', 'run-A', 'w1', 1000, 100); // A wins, expires 1100
    await s.acquire('ci', 'run-B', 'w1', 1200, 100); // A expired -> B (same worker) takes over
    await s.release('ci', 'w1', 'run-A'); // stale A -> must NOT delete B's lock
    expect((await s.get('ci'))?.leaderRunId).toBe('run-B');
    await s.release('ci', 'w1', 'run-B'); // B (current) -> deletes
    expect(await s.get('ci')).toBeUndefined();
  });

  // P3-6a: sweepExpired removes orphaned locks expired beyond a grace window, bounded by batchLimit
  // (oldest first), leaving live and within-grace rows.
  it('sweepExpired removes beyond-grace rows oldest-first, bounded by batchLimit', async () => {
    const s = new InMemoryComputeLockStore();
    await s.acquire('alive', 'run-A', 'w1', 1000, 100); // expires 1100
    await s.acquire('old1', 'run-B', 'w1', 300, 100); // expires 400
    await s.acquire('old2', 'run-C', 'w1', 500, 100); // expires 600
    // threshold 1000: old1(400) + old2(600) eligible; batchLimit 1 -> only the OLDEST (old1).
    expect(await s.sweepExpired(2000, 1000, 1)).toBe(1);
    expect(await s.get('old1')).toBeUndefined();
    expect(await s.get('old2')).toBeDefined();
    // second pass sweeps the rest (batchLimit 10); alive stays.
    expect(await s.sweepExpired(2000, 1000, 10)).toBe(1);
    expect(await s.get('old2')).toBeUndefined();
    expect(await s.get('alive')).toBeDefined();
  });
});
