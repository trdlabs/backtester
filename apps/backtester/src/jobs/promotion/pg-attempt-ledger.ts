// E4b — Postgres promotion attempt ledger (migration 0009). Atomic: a transaction locks the epoch
// counter row (FOR UPDATE), so concurrent distinct attempts get distinct monotonic numbers; a replay
// (same epoch+attemptIdentity) returns its stored number without incrementing. NOTE: the repo has no
// transaction helper — use pool.connect() + BEGIN/COMMIT explicitly with a finally release.
import type { Pool } from 'pg';
import type { PromotionAttemptLedger, PromotionAttemptRecord } from './attempt-ledger.js';

export class PgPromotionAttemptLedger implements PromotionAttemptLedger {
  constructor(private readonly pool: Pool) {}
  async recordIfNewAndGetAttempt(r: PromotionAttemptRecord): Promise<{ attemptNumber: number; inserted: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // 1) ensure the epoch counter row exists, then LOCK it FIRST — so concurrent same-identity calls
      //    serialize on this lock BEFORE the replay-check (else both see "no attempt" and the 2nd hits a
      //    duplicate-PK instead of returning inserted:false).
      await client.query(
        'INSERT INTO backtest_promotion_epoch (epoch_key, next_attempt) VALUES ($1, 1) ON CONFLICT (epoch_key) DO NOTHING',
        [r.qualificationEpochKey],
      );
      const locked = await client.query<{ next_attempt: number }>(
        'SELECT next_attempt FROM backtest_promotion_epoch WHERE epoch_key = $1 FOR UPDATE',
        [r.qualificationEpochKey],
      );
      // 2) replay-check UNDER the lock: a concurrent first-inserter has already committed its row by now.
      const replay = await client.query<{ attempt_number: number }>(
        'SELECT attempt_number FROM backtest_promotion_attempt WHERE epoch_key = $1 AND attempt_identity = $2',
        [r.qualificationEpochKey, r.attemptIdentity],
      );
      if ((replay.rowCount ?? 0) > 0) {
        await client.query('COMMIT');
        return { attemptNumber: Number(replay.rows[0].attempt_number), inserted: false };
      }
      // 3) assign + insert + advance the counter, all under the lock.
      const n = Number(locked.rows[0].next_attempt);
      await client.query(
        `INSERT INTO backtest_promotion_attempt
           (epoch_key, attempt_identity, attempt_number, request_fingerprint, dataset_fingerprint, run_id, result_hash, verdict, created_at_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [r.qualificationEpochKey, r.attemptIdentity, n, r.requestFingerprint, r.datasetFingerprint, r.runId, r.resultHash, r.verdict, r.createdAtMs],
      );
      await client.query('UPDATE backtest_promotion_epoch SET next_attempt = $2 WHERE epoch_key = $1', [r.qualificationEpochKey, n + 1]);
      await client.query('COMMIT');
      return { attemptNumber: n, inserted: true };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}
