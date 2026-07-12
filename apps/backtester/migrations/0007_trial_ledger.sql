-- 0007: E2 trial ledger — append-only, per-hypothesis-family record of each trial's Sharpe + moments.
-- Substrate for the advisory Deflated Sharpe Ratio (trial count N + empirical V[SR]). Dedupe key is
-- (family_key, request_fingerprint): a replay / result-cache hit of the same trial must NOT inflate N.
CREATE TABLE IF NOT EXISTS backtest_trial_ledger (
  family_key          TEXT             NOT NULL,
  request_fingerprint TEXT             NOT NULL,
  run_id              TEXT             NOT NULL,
  result_hash         TEXT             NOT NULL,
  trial_family_hint   TEXT,
  market_context      JSONB            NOT NULL,
  sharpe              DOUBLE PRECISION NOT NULL,
  skew                DOUBLE PRECISION NOT NULL,
  kurtosis            DOUBLE PRECISION NOT NULL,
  t_count             INTEGER          NOT NULL,
  created_at_ms       BIGINT           NOT NULL,
  PRIMARY KEY (family_key, request_fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_trial_ledger_family ON backtest_trial_ledger (family_key);
