-- 0005: in-flight compute coordination lock (Phase C item 12 — request coalescing), keyed by
-- computeIdentity. Separate from backtest_result_cache (completed-templates only). Expiry-based
-- leader election via upsert; same lease idiom as the worker lease (0003).
CREATE TABLE IF NOT EXISTS backtest_compute_lock (
  compute_identity     TEXT   PRIMARY KEY,
  leader_run_id        TEXT   NOT NULL,
  lock_owner_worker_id TEXT   NOT NULL,
  lock_expires_at_ms   BIGINT NOT NULL,
  created_at_ms        BIGINT NOT NULL,
  updated_at_ms        BIGINT NOT NULL
);

ALTER TABLE backtest_job ADD COLUMN IF NOT EXISTS compute_wait_attempts  INT     NOT NULL DEFAULT 0;
ALTER TABLE backtest_job ADD COLUMN IF NOT EXISTS compute_identity       TEXT;
ALTER TABLE backtest_job ADD COLUMN IF NOT EXISTS wait_deadline_ms       BIGINT;
ALTER TABLE backtest_job ADD COLUMN IF NOT EXISTS compute_wake_reason    TEXT;
ALTER TABLE backtest_job ADD COLUMN IF NOT EXISTS engine_attempt_charged BOOLEAN NOT NULL DEFAULT false;
