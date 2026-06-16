-- Slice 2 — backtester job lifecycle + outbox (own DB, independent of platform canonical schema).
-- See docs/ARCHITECTURE.md §7. Idempotent DDL so a fresh schema applies cleanly.

CREATE TABLE IF NOT EXISTS backtest_job (
  run_id                  TEXT PRIMARY KEY,
  job_id                  TEXT NOT NULL,
  resume_token            TEXT,
  request_fingerprint     TEXT NOT NULL,
  correlation_id          TEXT,
  workflow_id             TEXT,
  status                  TEXT NOT NULL DEFAULT 'accepted'
    CHECK (status IN ('accepted','queued','running','completed','failed','canceled','expired','timed_out')),
  request_json            JSONB NOT NULL,
  effective_seed          BIGINT NOT NULL,
  dataset_ref             TEXT NOT NULL,
  dataset_fingerprint     TEXT,
  callback_url            TEXT,
  queue_deadline_ms       BIGINT,
  run_timeout_ms          BIGINT NOT NULL,
  run_deadline_ms         BIGINT,
  accepted_at_ms          BIGINT NOT NULL,
  queued_at_ms            BIGINT,
  started_at_ms           BIGINT,
  terminal_at_ms          BIGINT,
  last_activity_ms        BIGINT,
  result_summary_json     JSONB,
  result_hash             TEXT,
  artifact_manifest_json  JSONB,
  terminal_code           TEXT,
  timeline_json           JSONB NOT NULL DEFAULT '[]'::jsonb
);

-- resume_token is the idempotency key; partial-unique so multiple NULLs (no token) are allowed.
CREATE UNIQUE INDEX IF NOT EXISTS ux_backtest_job_resume_token
  ON backtest_job (resume_token) WHERE resume_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_backtest_job_queue_deadline
  ON backtest_job (status, queue_deadline_ms) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS ix_backtest_job_run_deadline
  ON backtest_job (status, run_deadline_ms) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS ix_backtest_job_queued_order
  ON backtest_job (queued_at_ms, run_id) WHERE status = 'queued';

CREATE TABLE IF NOT EXISTS backtest_job_event (
  event_uid          TEXT PRIMARY KEY,
  job_id             TEXT NOT NULL,
  run_id             TEXT NOT NULL,
  event_type         TEXT NOT NULL,
  payload_json       JSONB NOT NULL,
  delivery_state     TEXT CHECK (delivery_state IN ('pending','delivered','failed')),
  delivery_attempts  INT NOT NULL DEFAULT 0,
  created_at_ms      BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_backtest_job_event_run
  ON backtest_job_event (run_id, created_at_ms);
CREATE INDEX IF NOT EXISTS ix_backtest_job_event_outbox
  ON backtest_job_event (created_at_ms) WHERE delivery_state IN ('pending','failed');
