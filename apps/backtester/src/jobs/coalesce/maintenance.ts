// P3-6a — shared coalescing maintenance: wake waiting followers + throttled, bounded orphan-lock sweep.
// Runs in BOTH worker topologies (multi-process runWorkerLoop AND single-process buildApp.tick()) so
// orphaned compute-locks are cleaned in either mode — the sweep must not live only in one loop.
//
// The sweep is THROTTLED (at most once per `sweepIntervalMs`, not every poll) and BOUNDED (at most
// `sweepBatchLimit` rows per pass) so it never becomes a hot full-table DELETE / WAL spike on an
// accumulated table (it walks the lock_expires_at_ms index tail — see migration 0010).
import { wakeComputeWaiters } from './wake.js';
import type { JobStore } from '../job-store.js';
import type { ResultCache } from '../dedup/result-cache.js';
import type { ComputeLockStore } from './compute-lock.js';

export interface CoalesceMaintenanceDeps {
  store: JobStore;
  resultCache: ResultCache;
  computeLock: ComputeLockStore;
  clock: () => number;
  computeWaitMaxAttempts: number;
  /** Sweep grace AND default throttle interval: a lock is sweepable once expired beyond this window, so
   *  a just-expired failure-lock survives ≥1 wake pass (read for its reason) before it is swept. */
  computeLockTtlMs: number;
}

export interface CoalesceMaintenanceOptions {
  /** Max rows deleted per sweep (bounded DELETE). Default 1000. */
  sweepBatchLimit?: number;
  /** Minimum ms between sweeps (throttle). Default = `computeLockTtlMs`. */
  sweepIntervalMs?: number;
}

/**
 * Build a maintenance step with its OWN throttle state (create once per loop lifetime, call each pass).
 * Each call: (1) wakeComputeWaiters; (2) if the throttle interval elapsed, one bounded orphan sweep.
 */
export function createCoalesceMaintenance(
  deps: CoalesceMaintenanceDeps,
  opts: CoalesceMaintenanceOptions = {},
): () => Promise<void> {
  const batchLimit = opts.sweepBatchLimit ?? 1000;
  const intervalMs = opts.sweepIntervalMs ?? deps.computeLockTtlMs;
  let lastSweepAtMs: number | undefined;
  return async () => {
    await wakeComputeWaiters({
      store: deps.store,
      resultCache: deps.resultCache,
      computeLock: deps.computeLock,
      clock: deps.clock,
      computeWaitMaxAttempts: deps.computeWaitMaxAttempts,
    });
    const now = deps.clock();
    if (lastSweepAtMs === undefined || now - lastSweepAtMs >= intervalMs) {
      lastSweepAtMs = now;
      await deps.computeLock.sweepExpired(now, deps.computeLockTtlMs, batchLimit).catch(() => {});
    }
  };
}
