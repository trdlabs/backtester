// Wake step for the coalescing follower path — runs on the worker's poll loop next to
// reapAndPublish. Per computeIdentity group of waiting_for_compute jobs:
//   1. poison waiters at/over computeWaitMaxAttempts (independent of cache/lock);
//   2. cache present (INV-1: checks the result-cache INDEX only, never the artifact store) →
//      release ALL live waiters to 'queued' (reason cache_ready) — they HIT on re-claim;
//   3. else lock expired/absent → elect exactly ONE live waiter to 'queued' as the new leader
//      (reason leader_failed if the prior leader's job ended terminal-failed/timed_out/canceled,
//      else lock_expired); the rest keep waiting;
//   4. else (lock alive) → keep waiting.
import type { JobStore, JobRow } from '../job-store.js';
import type { ResultCache } from '../dedup/result-cache.js';
import type { ComputeLockStore } from './compute-lock.js';

export interface WakeDeps {
  store: JobStore;
  resultCache: ResultCache;
  computeLock: ComputeLockStore;
  clock: () => number;
  computeWaitMaxAttempts: number;
}

export async function wakeComputeWaiters(
  deps: WakeDeps,
): Promise<{ released: number; poisoned: number }> {
  const now = deps.clock();
  const waiters = await deps.store.listComputeWaiters(now);

  const byCi = new Map<string, JobRow[]>();
  for (const w of waiters) {
    if (!w.computeIdentity) continue;
    const list = byCi.get(w.computeIdentity);
    if (list) list.push(w);
    else byCi.set(w.computeIdentity, [w]);
  }

  let released = 0;
  let poisoned = 0;

  for (const [ci, group] of byCi) {
    // Poison exhausted waiters first (independent of cache/lock).
    for (const w of group) {
      if (w.computeWaitAttempts >= deps.computeWaitMaxAttempts) {
        await deps.store.poisonComputeWaiter(w.runId, now);
        poisoned += 1;
      }
    }
    const live = group.filter((w) => w.computeWaitAttempts < deps.computeWaitMaxAttempts);
    if (live.length === 0) continue;

    // INV-1: cache index only. If the template is indexed, release ALL (they HIT on re-claim).
    const hit = await deps.resultCache.lookup(ci);
    if (hit) {
      released += await deps.store.releaseAllComputeWaiters(ci, 'cache_ready', now);
      continue;
    }

    const lock = await deps.computeLock.get(ci);
    const lockAlive = lock !== undefined && now <= lock.lockExpiresAtMs;
    if (lockAlive) continue; // keep waiting — the leader is still working the lock.

    // No cache + lock expired/absent → elect exactly ONE to become the new leader.
    const leaderJob = lock ? await deps.store.get(lock.leaderRunId) : undefined;
    const reason =
      leaderJob && ['failed', 'timed_out', 'canceled'].includes(leaderJob.status)
        ? 'leader_failed'
        : 'lock_expired';
    const elected = await deps.store.electOneComputeWaiter(ci, reason, now);
    if (elected) released += 1;
  }

  return { released, poisoned };
}
