// P3-6a — the shared coalescing-maintenance step (wake + throttled, bounded orphan-lock sweep) used by
// BOTH worker topologies. Unit-level: orphan sweep + throttle. (buildApp integration is in
// coalesce-wiring.test.ts; store mechanics in compute-lock.test.ts.)
import { describe, expect, it, vi } from 'vitest';
import { InMemoryComputeLockStore } from '../src/jobs/coalesce/compute-lock.js';
import { InMemoryResultCache } from '../src/jobs/dedup/result-cache.js';
import { createCoalesceMaintenance, createResultCacheSweep, type CoalesceMaintenanceDeps } from '../src/jobs/coalesce/maintenance.js';

function makeDeps(clock: () => number): CoalesceMaintenanceDeps {
  return {
    // Minimal JobStore surface wakeComputeWaiters touches: no waiters → it is a no-op.
    store: { listComputeWaiters: async () => [] } as unknown as CoalesceMaintenanceDeps['store'],
    resultCache: new InMemoryResultCache(),
    computeLock: new InMemoryComputeLockStore(),
    clock,
    computeWaitMaxAttempts: 3,
    computeLockTtlMs: 30_000,
  };
}

describe('createCoalesceMaintenance', () => {
  it('sweeps an orphaned expired lock beyond the grace window on a pass', async () => {
    const now = 1_000_000;
    const deps = makeDeps(() => now);
    await deps.computeLock.acquire('orphan', 'run-dead', 'w', 100, 100); // expires 200 ≪ now - ttl
    const maintain = createCoalesceMaintenance(deps, { sweepBatchLimit: 100 });
    await maintain();
    expect(await deps.computeLock.get('orphan')).toBeUndefined();
  });

  it('throttles the sweep to at most once per interval; wake still runs each pass', async () => {
    let now = 1_000_000;
    const deps = makeDeps(() => now);
    const sweepSpy = vi.spyOn(deps.computeLock, 'sweepExpired');
    const listSpy = vi.spyOn(deps.store, 'listComputeWaiters');
    const maintain = createCoalesceMaintenance(deps, { sweepIntervalMs: 10_000 });

    await maintain(); // first pass → sweeps
    await maintain(); // same clock, within interval → NO sweep
    expect(sweepSpy).toHaveBeenCalledTimes(1);
    expect(listSpy).toHaveBeenCalledTimes(2); // wake is NOT throttled

    now += 10_000; // interval elapsed
    await maintain();
    expect(sweepSpy).toHaveBeenCalledTimes(2);
  });
});

describe('createResultCacheSweep (P3-6b)', () => {
  const entry = (id: string, createdAtMs: number) => ({ computeIdentity: id, requestFingerprint: 'f', datasetFingerprint: 'd', computeVersion: '1', sandboxPolicyVersion: 's', templateRef: 'sha256:x', createdAtMs });
  it('evicts expired cache rows on a pass and throttles to once per interval', async () => {
    let now = 1_000_000;
    const cache = new InMemoryResultCache();
    await cache.put(entry('old', 100));
    const spy = vi.spyOn(cache, 'sweepExpired');
    const sweep = createResultCacheSweep({ resultCache: cache, clock: () => now, ttlMs: 1000 }, { sweepIntervalMs: 10_000 });
    await sweep();
    expect(await cache.lookup('old')).toBeUndefined();
    await sweep();
    expect(spy).toHaveBeenCalledTimes(1);
    now += 10_000;
    await sweep();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("sweep cadence is INDEPENDENT of a long TTL — a second batch clears within the cadence, not after the full TTL", async () => {
    const ttl = 30 * 24 * 60 * 60 * 1000; // 30-day retention
    let now = ttl + 10_000_000; // both entries below the threshold (now - ttl)
    const cache = new InMemoryResultCache();
    await cache.put(entry("e1", 100));
    await cache.put(entry("e2", 200));
    const sweep = createResultCacheSweep({ resultCache: cache, clock: () => now, ttlMs: ttl }, { sweepBatchLimit: 1 });
    await sweep(); // first pass, batchLimit 1 → oldest (e1)
    expect(await cache.lookup("e1")).toBeUndefined();
    expect(await cache.lookup("e2")).toBeDefined();
    now += 60_000; // ONE default cadence (60s) — vastly less than the 30-day TTL
    await sweep();
    expect(await cache.lookup("e2")).toBeUndefined(); // cleared within 60s, not after 30 days
  });
});
