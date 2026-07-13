// E5a — Postgres-backed novelty pool (migration 0008). Mirrors PgTrialLedger. `recordIfNew` =
// INSERT … ON CONFLICT (comparability_key, request_fingerprint) DO NOTHING so replays never duplicate
// a trajectory. `query` optionally excludes the caller's own fingerprint (replay self-exclusion).

import type { Pool } from 'pg';
import type { DailyDelta } from '../../engine/novelty.js';
import type { NoveltyPool, PoolRecord } from './novelty-pool.js';

interface Row {
  comparability_key: string;
  request_fingerprint: string;
  run_id: string;
  result_hash: string;
  family_key: string | null;
  daily_deltas: DailyDelta[];
  created_at_ms: string;
}

function toRecord(r: Row): PoolRecord {
  return {
    comparabilityKey: r.comparability_key,
    requestFingerprint: r.request_fingerprint,
    runId: r.run_id,
    resultHash: r.result_hash,
    ...(r.family_key !== null ? { familyKey: r.family_key } : {}),
    dailyDeltas: r.daily_deltas,
    createdAtMs: Number(r.created_at_ms),
  };
}

export class PgNoveltyPool implements NoveltyPool {
  constructor(private readonly pool: Pool) {}

  async recordIfNew(r: PoolRecord): Promise<boolean> {
    const res = await this.pool.query(
      `INSERT INTO backtest_novelty_pool
         (comparability_key, request_fingerprint, run_id, result_hash, family_key, daily_deltas, created_at_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (comparability_key, request_fingerprint) DO NOTHING`,
      [
        r.comparabilityKey,
        r.requestFingerprint,
        r.runId,
        r.resultHash,
        r.familyKey ?? null,
        JSON.stringify(r.dailyDeltas),
        r.createdAtMs,
      ],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async query(
    comparabilityKey: string,
    opts?: { excludeRequestFingerprint?: string },
  ): Promise<readonly PoolRecord[]> {
    const exclude = opts?.excludeRequestFingerprint;
    const sql = exclude
      ? 'SELECT * FROM backtest_novelty_pool WHERE comparability_key = $1 AND request_fingerprint <> $2 ORDER BY created_at_ms ASC, run_id ASC'
      : 'SELECT * FROM backtest_novelty_pool WHERE comparability_key = $1 ORDER BY created_at_ms ASC, run_id ASC';
    const res = await this.pool.query<Row>(sql, exclude ? [comparabilityKey, exclude] : [comparabilityKey]);
    return res.rows.map(toRecord);
  }
}
