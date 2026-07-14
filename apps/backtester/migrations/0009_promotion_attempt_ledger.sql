-- 0009: E4b promotion attempt ledger. Counts held-out qualification attempts per (epoch, attempt).
-- Epoch counter row assigns a monotonic attempt_number under FOR UPDATE so concurrent attempts never
-- collide; the attempt row persists the assigned number + verdict. Dedupe axis (epoch_key,
-- attempt_identity=hash(request_fingerprint, dataset_fingerprint)) so a backfill (new snapshot) is a new
-- attempt while a true replay keeps its number.
CREATE TABLE IF NOT EXISTS backtest_promotion_epoch (
  epoch_key    TEXT    NOT NULL PRIMARY KEY,
  next_attempt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS backtest_promotion_attempt (
  epoch_key           TEXT    NOT NULL,
  attempt_identity    TEXT    NOT NULL,
  attempt_number      INTEGER NOT NULL,
  request_fingerprint TEXT    NOT NULL,
  dataset_fingerprint TEXT    NOT NULL,
  run_id              TEXT    NOT NULL,
  result_hash         TEXT    NOT NULL,
  verdict             TEXT    NOT NULL,
  created_at_ms       BIGINT  NOT NULL,
  PRIMARY KEY (epoch_key, attempt_identity)
);
