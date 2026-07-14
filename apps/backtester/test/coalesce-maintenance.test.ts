// P3-6a — the shared coalescing-maintenance step (wake + throttled, bounded orphan-lock sweep) used by
// BOTH worker topologies. Unit-level: orphan sweep + throttle. (buildApp integration is in
// coalesce-wiring.test.ts; store mechanics in compute-lock.test.ts.)
import { describe, expect, it, vi } from 'vitest';
import { InMemoryComputeLockStore } from '../src/jobs/coalesce/compute-lock.js';
import { InMemoryResultCache } from '../src/jobs/dedup/result-cache.js';
import { createCoalesceMaintenance, type CoalesceMaintenanceDeps } from '../src/jobs/coalesce/maintenance.js';

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
