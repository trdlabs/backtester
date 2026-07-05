-- Horizontal workers — per-job lease for multi-process crash recovery.
-- leased_by: worker holding the job; lease_expires_at: stale-after epoch ms; attempts: claim count.
ALTER TABLE backtest_job ADD COLUMN IF NOT EXISTS leased_by TEXT;
ALTER TABLE backtest_job ADD COLUMN IF NOT EXISTS lease_expires_at BIGINT;
ALTER TABLE backtest_job ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
