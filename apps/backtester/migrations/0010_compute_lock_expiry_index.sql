-- 0010: index for the P3-6a bounded orphan-lock sweep — the maintenance step DELETEs rows expired
-- beyond a grace window (lock_expires_at_ms < now - ttl) ordered by lock_expires_at_ms with a LIMIT.
-- Without this index that DELETE is a full-table scan on every sweep; with it, it walks only the
-- expired tail. Concurrent-safe create is not needed (fresh table, small).
CREATE INDEX IF NOT EXISTS idx_backtest_compute_lock_expires_at
  ON backtest_compute_lock (lock_expires_at_ms);
