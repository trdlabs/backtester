-- Slice 3 — record the content hash of the submitted bundle a sandboxed run executed.
-- The bundle bytes live in the content-addressed bundle registry, not here (only the pointer).

ALTER TABLE backtest_job ADD COLUMN IF NOT EXISTS bundle_hash TEXT;
