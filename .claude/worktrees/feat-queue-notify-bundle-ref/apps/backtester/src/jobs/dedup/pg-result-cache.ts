// Postgres ResultCache — behaviorally equivalent to InMemoryResultCache, durable across restarts.
//
// put is idempotent (first-writer-wins) via ON CONFLICT (compute_identity) DO NOTHING, matching
// InMemoryResultCache's Map.has guard.

import type { Pool } from 'pg';
import type { CacheEntry, ResultCache } from './result-cache';

interface Row {
  compute_identity: string;
  request_fingerprint: string;
  dataset_fingerprint: string;
  compute_version: string;
  sandbox_policy_version: string;
  template_ref: string;
  created_at_ms: string; // pg BIGINT → string
}

const toEntry = (r: Row): CacheEntry => ({
  computeIdentity: r.compute_identity,
  requestFingerprint: r.request_fingerprint,
  datasetFingerprint: r.dataset_fingerprint,
  computeVersion: r.compute_version,
  sandboxPolicyVersion: r.sandbox_policy_version,
  templateRef: r.template_ref,
  createdAtMs: Number(r.created_at_ms),
});

export class PgResultCache implements ResultCache {
  constructor(private readonly pool: Pool) {}

  async lookup(computeIdentity: string): Promise<CacheEntry | undefined> {
    const r = await this.pool.query<Row>(
      'SELECT * FROM backtest_result_cache WHERE compute_identity = $1',
      [computeIdentity],
    );
    return r.rows[0] ? toEntry(r.rows[0]) : undefined;
  }

  async put(entry: CacheEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO backtest_result_cache
         (compute_identity, request_fingerprint, dataset_fingerprint, compute_version, sandbox_policy_version, template_ref, created_at_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (compute_identity) DO NOTHING`,
      [
        entry.computeIdentity,
        entry.requestFingerprint,
        entry.datasetFingerprint,
        entry.computeVersion,
        entry.sandboxPolicyVersion,
        entry.templateRef,
        entry.createdAtMs,
      ],
    );
  }
}
