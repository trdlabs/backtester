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
});
