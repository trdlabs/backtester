// Postgres ComputeLockStore — expiry-based leader election via upsert. Behaviorally equivalent to
// InMemoryComputeLockStore: acquire wins iff no row exists or the existing row is expired.

import type { Pool } from 'pg';
import type { ComputeLock, ComputeLockStore } from './compute-lock.js';

interface LockRow {
  compute_identity: string;
  leader_run_id: string;
  lock_owner_worker_id: string;
  lock_expires_at_ms: string; // pg BIGINT → string
  created_at_ms: string;
  updated_at_ms: string;
}

const toLock = (r: LockRow): ComputeLock => ({
  computeIdentity: r.compute_identity,
  leaderRunId: r.leader_run_id,
  lockOwnerWorkerId: r.lock_owner_worker_id,
  lockExpiresAtMs: Number(r.lock_expires_at_ms),
  createdAtMs: Number(r.created_at_ms),
  updatedAtMs: Number(r.updated_at_ms),
});

export class PgComputeLockStore implements ComputeLockStore {
  constructor(private readonly pool: Pool) {}

  async acquire(
    computeIdentity: string,
    leaderRunId: string,
    workerId: string,
    nowMs: number,
    ttlMs: number,
  ): Promise<boolean> {
    // Win iff inserted (no row) OR updated (existing row expired). ON CONFLICT DO UPDATE guarded by expiry.
    const r = await this.pool.query(
      `INSERT INTO backtest_compute_lock
         (compute_identity, leader_run_id, lock_owner_worker_id, lock_expires_at_ms, created_at_ms, updated_at_ms)
       VALUES ($1,$2,$3,$4::bigint + $5::bigint,$4,$4)
       ON CONFLICT (compute_identity) DO UPDATE SET
         leader_run_id = EXCLUDED.leader_run_id,
         lock_owner_worker_id = EXCLUDED.lock_owner_worker_id,
         lock_expires_at_ms = EXCLUDED.lock_expires_at_ms,
         updated_at_ms = EXCLUDED.updated_at_ms
       WHERE backtest_compute_lock.lock_expires_at_ms < $4::bigint
       RETURNING compute_identity`,
      [computeIdentity, leaderRunId, workerId, nowMs, ttlMs],
    );
    return r.rowCount === 1;
  }

  async renew(computeIdentity: string, workerId: string, untilMs: number): Promise<void> {
    await this.pool.query(
      `UPDATE backtest_compute_lock SET lock_expires_at_ms = $3::bigint, updated_at_ms = $3::bigint
       WHERE compute_identity = $1 AND lock_owner_worker_id = $2`,
      [computeIdentity, workerId, untilMs],
    );
  }

  async expire(computeIdentity: string, workerId: string, nowMs: number): Promise<void> {
    await this.pool.query(
      `UPDATE backtest_compute_lock SET lock_expires_at_ms = $3::bigint, updated_at_ms = $3::bigint
       WHERE compute_identity = $1 AND lock_owner_worker_id = $2`,
      [computeIdentity, workerId, nowMs],
    );
  }

  async release(computeIdentity: string, workerId: string, leaderRunId: string): Promise<void> {
    // Eager release: delete ONLY this exact generation (owner AND leader_run_id) so a stale leader
    // cannot delete a re-elected lock a new run acquired under the same workerId. Idempotent.
    await this.pool.query(
      `DELETE FROM backtest_compute_lock
         WHERE compute_identity = $1 AND lock_owner_worker_id = $2 AND leader_run_id = $3`,
      [computeIdentity, workerId, leaderRunId],
    );
  }

  async sweepExpired(nowMs: number, olderThanMs: number, batchLimit: number): Promise<number> {
    // Bounded DELETE (oldest expired first, LIMIT batchLimit) over the lock_expires_at_ms index — avoids
    // a hot full-table scan/WAL spike. The grace lets wakeComputeWaiters read an expired failure-lock
    // (for its wake reason) before it is swept.
    const r = await this.pool.query(
      `DELETE FROM backtest_compute_lock
         WHERE ctid IN (
           SELECT ctid FROM backtest_compute_lock
           WHERE lock_expires_at_ms < $1::bigint
           ORDER BY lock_expires_at_ms
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         )`,
      [nowMs - olderThanMs, batchLimit],
    );
    return r.rowCount ?? 0;
  }

  async get(computeIdentity: string): Promise<ComputeLock | undefined> {
    const r = await this.pool.query<LockRow>(
      'SELECT * FROM backtest_compute_lock WHERE compute_identity = $1',
      [computeIdentity],
    );
    return r.rows[0] ? toLock(r.rows[0]) : undefined;
  }
}
