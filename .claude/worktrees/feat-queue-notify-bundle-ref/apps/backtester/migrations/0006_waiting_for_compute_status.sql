-- Widen backtest_job.status CHECK to allow the internal-only 'waiting_for_compute' status
-- (Task 4 — coalescing follower). This status is projected back to 'running' at every public
-- boundary (see toStatusView / publicStatus in src/jobs/lifecycle.ts, INV-7); the DB layer must
-- simply be able to persist it via PgJobStore.transition.

ALTER TABLE backtest_job DROP CONSTRAINT IF EXISTS backtest_job_status_check;
ALTER TABLE backtest_job ADD CONSTRAINT backtest_job_status_check
  CHECK (status IN ('accepted','queued','running','waiting_for_compute','completed','failed','canceled','expired','timed_out'));
