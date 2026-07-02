-- 0004: fingerprint-based result dedup cache (Phase C item 11). Metadata + a content-addressed
-- pointer (template_ref) to the runId-normalized DedupTemplate in the artifact store.
CREATE TABLE IF NOT EXISTS backtest_result_cache (
  compute_identity       TEXT PRIMARY KEY,
  request_fingerprint    TEXT NOT NULL,
  dataset_fingerprint    TEXT NOT NULL,
  compute_version        TEXT NOT NULL,
  sandbox_policy_version TEXT NOT NULL,
  template_ref           TEXT NOT NULL,
  created_at_ms          BIGINT NOT NULL
);

-- Provenance: which cache entry a run was served from (NULL for freshly-computed runs). Observability
-- only — never part of result_hash.
ALTER TABLE backtest_job ADD COLUMN IF NOT EXISTS deduped_from TEXT;
