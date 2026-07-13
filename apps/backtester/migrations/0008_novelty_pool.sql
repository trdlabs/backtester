-- 0008: E5a novelty pool — append-only, per-comparability-group record of each run's daily-PnL-delta
-- trajectory. Substrate for the advisory behavioral-novelty score (family-identity layer L3). Dedupe
-- key is (comparability_key, request_fingerprint): a replay / cache hit must NOT add a duplicate
-- trajectory. comparability_key excludes period + hint so L3 crosses families and shifted windows.
CREATE TABLE IF NOT EXISTS backtest_novelty_pool (
  comparability_key   TEXT   NOT NULL,
  request_fingerprint TEXT   NOT NULL,
  run_id              TEXT   NOT NULL,
  result_hash         TEXT   NOT NULL,
  family_key          TEXT,
  daily_deltas        JSONB  NOT NULL,
  created_at_ms       BIGINT NOT NULL,
  PRIMARY KEY (comparability_key, request_fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_novelty_pool_key ON backtest_novelty_pool (comparability_key);
