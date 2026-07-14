-- 0011: index for the P3-6b bounded result-cache TTL sweep — the maintenance step DELETEs entries
-- older than a TTL (created_at_ms < now - ttl) ordered by created_at_ms with a LIMIT. Without this
-- index that DELETE is a full-table scan on every sweep; with it, it walks only the expired tail.
CREATE INDEX IF NOT EXISTS idx_backtest_result_cache_created_at
  ON backtest_result_cache (created_at_ms);
