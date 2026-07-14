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
  /** P3-6a: eager release — DELETE the row ONLY while the caller owns this exact generation
   *  (workerId AND leaderRunId), so a stale leader cannot delete a freshly re-elected lock that a new
   *  run happened to acquire under the same workerId. Followers wake via the cache index, not this lock. */
  release(computeIdentity: string, workerId: string, leaderRunId: string): Promise<void>;
  /** P3-6a: cleanup — DELETE up to `batchLimit` rows expired beyond the grace window (lockExpiresAtMs <
   *  nowMs - olderThanMs), oldest first. Bounded to avoid a hot full-table DELETE. Returns the count. */
  sweepExpired(nowMs: number, olderThanMs: number, batchLimit: number): Promise<number>;
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

  async release(ci: string, workerId: string, leaderRunId: string): Promise<void> {
    const row = this.rows.get(ci);
    if (row && row.lockOwnerWorkerId === workerId && row.leaderRunId === leaderRunId) this.rows.delete(ci);
  }

  async sweepExpired(nowMs: number, olderThanMs: number, batchLimit: number): Promise<number> {
    const threshold = nowMs - olderThanMs;
    // Oldest-expired first, capped at batchLimit — mirrors the Pg ORDER BY … LIMIT.
    const expired = [...this.rows.values()]
      .filter((r) => r.lockExpiresAtMs < threshold)
      .sort((a, b) => a.lockExpiresAtMs - b.lockExpiresAtMs)
      .slice(0, Math.max(0, batchLimit));
    for (const r of expired) this.rows.delete(r.computeIdentity);
    return expired.length;
  }

  async get(ci: string): Promise<ComputeLock | undefined> {
    const row = this.rows.get(ci);
    return row ? { ...row } : undefined;
  }
}
