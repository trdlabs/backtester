// In-flight compute coordination lock, keyed by computeIdentity. Separate from the completed-result
// cache (result_cache stays completed-templates only). Expiry-based; same lease idiom as the job-lease.

export type ComputeWakeReason = 'cache_ready' | 'lock_expired' | 'leader_failed';

export interface ComputeLock {
  computeIdentity: string;
  leaderRunId: string;
  lockOwnerWorkerId: string;
  lockExpiresAtMs: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ComputeLockStore {
  /** Win iff no row or the existing row is expired; on win (re)writes with lockExpiresAtMs = nowMs+ttlMs. */
  acquire(computeIdentity: string, leaderRunId: string, workerId: string, nowMs: number, ttlMs: number): Promise<boolean>;
  /** Extend lockExpiresAtMs only while the caller owns the lock. */
  renew(computeIdentity: string, workerId: string, untilMs: number): Promise<void>;
  /** Proactively expire (lockExpiresAtMs = nowMs) only while the caller owns the lock. */
  expire(computeIdentity: string, workerId: string, nowMs: number): Promise<void>;
  /** P3-6a: eager release — DELETE the row (only while the caller owns it) so the table does not grow
   *  one dead row per successful compute. Followers wake via the cache index, not this lock. */
  release(computeIdentity: string, workerId: string): Promise<void>;
  /** P3-6a: cleanup — DELETE every row expired beyond the grace window (lockExpiresAtMs < nowMs -
   *  olderThanMs). Removes orphaned locks (leader crashed, no follower re-elected). Returns the count. */
  sweepExpired(nowMs: number, olderThanMs: number): Promise<number>;
  get(computeIdentity: string): Promise<ComputeLock | undefined>;
}

export class InMemoryComputeLockStore implements ComputeLockStore {
  private readonly rows = new Map<string, ComputeLock>();

  async acquire(ci: string, leaderRunId: string, workerId: string, nowMs: number, ttlMs: number): Promise<boolean> {
    const existing = this.rows.get(ci);
    if (existing && nowMs <= existing.lockExpiresAtMs) return false;
    this.rows.set(ci, {
      computeIdentity: ci,
      leaderRunId,
      lockOwnerWorkerId: workerId,
      lockExpiresAtMs: nowMs + ttlMs,
      createdAtMs: existing?.createdAtMs ?? nowMs,
      updatedAtMs: nowMs,
    });
    return true;
  }

  async renew(ci: string, workerId: string, untilMs: number): Promise<void> {
    const row = this.rows.get(ci);
    if (row && row.lockOwnerWorkerId === workerId) {
      row.lockExpiresAtMs = untilMs;
      row.updatedAtMs = untilMs;
    }
  }

  async expire(ci: string, workerId: string, nowMs: number): Promise<void> {
    const row = this.rows.get(ci);
    if (row && row.lockOwnerWorkerId === workerId) {
      row.lockExpiresAtMs = nowMs;
      row.updatedAtMs = nowMs;
    }
  }

  async release(ci: string, workerId: string): Promise<void> {
    const row = this.rows.get(ci);
    if (row && row.lockOwnerWorkerId === workerId) this.rows.delete(ci);
  }

  async sweepExpired(nowMs: number, olderThanMs: number): Promise<number> {
    const threshold = nowMs - olderThanMs;
    let deleted = 0;
    for (const [ci, row] of this.rows) {
      if (row.lockExpiresAtMs < threshold) {
        this.rows.delete(ci);
        deleted += 1;
      }
    }
    return deleted;
  }

  async get(ci: string): Promise<ComputeLock | undefined> {
    const row = this.rows.get(ci);
    return row ? { ...row } : undefined;
  }
}
