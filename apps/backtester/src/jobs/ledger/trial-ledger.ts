// E2 — trial ledger: append-only, per-hypothesis-family record of each trial's Sharpe + moments,
// the substrate for the Deflated Sharpe Ratio's trial count N and empirical V[SR]. Worker-time store
// mirroring ResultCache (InMemory + Pg). Advisory: never part of any hashed payload.

import { canonicalJson } from '../../determinism/canonical-json';
import { sha256Hex } from '../../determinism/hash';

/** Fields the family key is derived from (subset of the run request). */
export interface FamilyKeyInput {
  readonly trialFamilyHint?: string;
  readonly moduleRef: { readonly id: string };
  readonly datasetRef: string;
  readonly symbols: readonly string[];
  readonly timeframe: string;
  readonly period: { readonly from: string; readonly to: string };
}

/**
 * Family key = sha256 over the hypothesis identity + market context + window. `trialFamilyHint`
 * (lab layer L1) overrides `moduleRef.id`. Symbols are sorted (order-insensitive). `period` is
 * included so the same idea on a different window is a DIFFERENT family — else V[SR] mixes
 * incomparable Sharpes. `trialFamilyHint` is deliberately NOT in `requestFingerprint` (advisory,
 * not run-affecting).
 */
export function computeFamilyKey(req: FamilyKeyInput): string {
  return sha256Hex(
    canonicalJson({
      hint: req.trialFamilyHint ?? req.moduleRef.id,
      datasetRef: req.datasetRef,
      symbols: [...req.symbols].sort(),
      timeframe: req.timeframe,
      period: { from: req.period.from, to: req.period.to },
    }),
  );
}

export interface TrialMarketContext {
  readonly datasetRef: string;
  readonly symbols: readonly string[];
  readonly timeframe: string;
  readonly period: { readonly from: string; readonly to: string };
}

export interface TrialRecord {
  readonly familyKey: string;
  /** Dedupe axis with familyKey — replay / result-cache hit of the same trial must NOT inflate N. */
  readonly requestFingerprint: string;
  readonly runId: string;
  readonly resultHash: string;
  readonly trialFamilyHint?: string;
  readonly marketContext: TrialMarketContext;
  readonly sharpe: number;
  readonly skew: number;
  readonly kurtosis: number;
  readonly tCount: number;
  readonly createdAtMs: number;
}

export interface TrialLedger {
  /** Idempotent on (familyKey, requestFingerprint); resolves true iff a new row was inserted. */
  recordIfNew(r: TrialRecord): Promise<boolean>;
  query(familyKey: string): Promise<readonly TrialRecord[]>;
}

/** In-memory ledger (tests / dev / single-process). Pg-backed `PgTrialLedger` mirrors it durably. */
export class InMemoryTrialLedger implements TrialLedger {
  private readonly byFamily = new Map<string, Map<string, TrialRecord>>();

  async recordIfNew(r: TrialRecord): Promise<boolean> {
    let fam = this.byFamily.get(r.familyKey);
    if (!fam) {
      fam = new Map();
      this.byFamily.set(r.familyKey, fam);
    }
    if (fam.has(r.requestFingerprint)) return false;
    fam.set(r.requestFingerprint, r);
    return true;
  }

  async query(familyKey: string): Promise<readonly TrialRecord[]> {
    const fam = this.byFamily.get(familyKey);
    return fam ? [...fam.values()] : [];
  }
}
