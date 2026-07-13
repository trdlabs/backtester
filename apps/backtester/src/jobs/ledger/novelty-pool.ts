// E5a — novelty pool: append-only, per-comparability-group record of each run's daily-PnL-delta
// trajectory. Substrate for the advisory behavioral-novelty score. Worker-time store (InMemory + Pg),
// mirroring the E2 TrialLedger. Never part of any hashed payload.

import type { DailyDelta } from '../../engine/novelty.js';
import { canonicalJson } from '../../determinism/canonical-json.js';
import { sha256Hex } from '../../determinism/hash.js';

/** Fields the comparability key is derived from. NO period, NO hint — L3 crosses families/windows. */
export interface ComparabilityKeyInput {
  readonly datasetRef: string;
  readonly symbols: readonly string[];
  readonly timeframe: string;
}

export function computeComparabilityKey(input: ComparabilityKeyInput): string {
  return sha256Hex(
    canonicalJson({
      datasetRef: input.datasetRef,
      symbols: [...input.symbols].sort(),
      timeframe: input.timeframe,
    }),
  );
}

export interface PoolRecord {
  readonly comparabilityKey: string;
  readonly requestFingerprint: string;
  readonly runId: string;
  readonly resultHash: string;
  readonly familyKey?: string; // optional — E5 is NOT coupled to E2; stored for a future L3 retro-merge
  readonly dailyDeltas: readonly DailyDelta[];
  readonly createdAtMs: number;
}

export interface NoveltyPool {
  /** Idempotent on (comparabilityKey, requestFingerprint); true iff a new row was inserted. */
  recordIfNew(r: PoolRecord): Promise<boolean>;
  /** Members of a comparability group (created_at_ms ASC, run_id ASC); optionally excluding one fingerprint. */
  query(
    comparabilityKey: string,
    opts?: { excludeRequestFingerprint?: string },
  ): Promise<readonly PoolRecord[]>;
}

export class InMemoryNoveltyPool implements NoveltyPool {
  private readonly byKey = new Map<string, Map<string, PoolRecord>>();

  async recordIfNew(r: PoolRecord): Promise<boolean> {
    let group = this.byKey.get(r.comparabilityKey);
    if (!group) {
      group = new Map();
      this.byKey.set(r.comparabilityKey, group);
    }
    if (group.has(r.requestFingerprint)) return false;
    group.set(r.requestFingerprint, r);
    return true;
  }

  async query(
    comparabilityKey: string,
    opts?: { excludeRequestFingerprint?: string },
  ): Promise<readonly PoolRecord[]> {
    const group = this.byKey.get(comparabilityKey);
    if (!group) return [];
    const rows = [...group.values()].filter(
      (r) => r.requestFingerprint !== opts?.excludeRequestFingerprint,
    );
    rows.sort((a, b) => a.createdAtMs - b.createdAtMs || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
    return rows;
  }
}
