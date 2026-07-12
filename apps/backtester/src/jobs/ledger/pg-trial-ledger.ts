// E2 — Postgres-backed trial ledger (migration 0007). Mirrors PgResultCache. `recordIfNew` =
// INSERT … ON CONFLICT (family_key, request_fingerprint) DO NOTHING so replays never inflate N.

import type { Pool } from 'pg';
import type { TrialLedger, TrialMarketContext, TrialRecord } from './trial-ledger.js';

interface Row {
  family_key: string;
  request_fingerprint: string;
  run_id: string;
  result_hash: string;
  trial_family_hint: string | null;
  market_context: TrialMarketContext;
  sharpe: number;
  skew: number;
  kurtosis: number;
  t_count: number;
  created_at_ms: string;
}

function toRecord(r: Row): TrialRecord {
  return {
    familyKey: r.family_key,
    requestFingerprint: r.request_fingerprint,
    runId: r.run_id,
    resultHash: r.result_hash,
    ...(r.trial_family_hint !== null ? { trialFamilyHint: r.trial_family_hint } : {}),
    marketContext: r.market_context,
    sharpe: Number(r.sharpe),
    skew: Number(r.skew),
    kurtosis: Number(r.kurtosis),
    tCount: Number(r.t_count),
    createdAtMs: Number(r.created_at_ms),
  };
}

export class PgTrialLedger implements TrialLedger {
  constructor(private readonly pool: Pool) {}

  async recordIfNew(r: TrialRecord): Promise<boolean> {
    const res = await this.pool.query(
      `INSERT INTO backtest_trial_ledger
         (family_key, request_fingerprint, run_id, result_hash, trial_family_hint, market_context,
          sharpe, skew, kurtosis, t_count, created_at_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (family_key, request_fingerprint) DO NOTHING`,
      [
        r.familyKey,
        r.requestFingerprint,
        r.runId,
        r.resultHash,
        r.trialFamilyHint ?? null,
        JSON.stringify(r.marketContext),
        r.sharpe,
        r.skew,
        r.kurtosis,
        r.tCount,
        r.createdAtMs,
      ],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async query(familyKey: string): Promise<readonly TrialRecord[]> {
    const res = await this.pool.query<Row>(
      'SELECT * FROM backtest_trial_ledger WHERE family_key = $1 ORDER BY created_at_ms ASC',
      [familyKey],
    );
    return res.rows.map(toRecord);
  }
}
