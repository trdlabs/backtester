// E2 — trial ledger, family-key derivation, and the narrow DSR-inputs helper.

import { describe, expect, it } from 'vitest';
import type { EquityPoint } from '../src/engine/artifacts.js';
import { dsrInputsFromEquity } from '../src/engine/metrics.js';
import {
  computeFamilyKey,
  InMemoryTrialLedger,
  type TrialRecord,
} from '../src/jobs/ledger/trial-ledger.js';

function famInput(over: Partial<Parameters<typeof computeFamilyKey>[0]> = {}) {
  return {
    trialFamilyHint: undefined,
    moduleRef: { id: 'short_after_pump', version: '0.1.0' },
    datasetRef: 'smoke-btc-1m',
    symbols: ['BTCUSDT', 'ETHUSDT'],
    timeframe: '1m',
    period: { from: '2023-11-14T00:00:00.000Z', to: '2023-11-15T00:00:00.000Z' },
    ...over,
  };
}

describe('computeFamilyKey', () => {
  it('is stable for the same hint + market context', () => {
    expect(computeFamilyKey(famInput())).toBe(computeFamilyKey(famInput()));
  });
  it('is insensitive to symbol order', () => {
    expect(computeFamilyKey(famInput({ symbols: ['BTCUSDT', 'ETHUSDT'] }))).toBe(
      computeFamilyKey(famInput({ symbols: ['ETHUSDT', 'BTCUSDT'] })),
    );
  });
  it('differs when the period differs (same idea, different window ⇒ different family)', () => {
    const jan = computeFamilyKey(famInput({ period: { from: '2023-01-01T00:00:00.000Z', to: '2023-01-08T00:00:00.000Z' } }));
    const feb = computeFamilyKey(famInput({ period: { from: '2023-02-01T00:00:00.000Z', to: '2023-02-08T00:00:00.000Z' } }));
    expect(jan).not.toBe(feb);
  });
  it('differs when the timeframe differs', () => {
    expect(computeFamilyKey(famInput({ timeframe: '1m' }))).not.toBe(
      computeFamilyKey(famInput({ timeframe: '1h' })),
    );
  });
  it('uses trialFamilyHint over moduleRef.id when present', () => {
    const hinted = computeFamilyKey(famInput({ trialFamilyHint: 'oi-divergence-v3' }));
    const byModule = computeFamilyKey(famInput({ trialFamilyHint: undefined }));
    expect(hinted).not.toBe(byModule);
  });
  // research-validation-hardening R1(b): absent trialFamilyHint falls back to moduleRef.id. Proven by
  // equivalence rather than re-deriving the sha256 formula: a hint that EQUALS moduleRef.id must key
  // identically to hint absent, since both feed the SAME `hint` value into the canonical-json input.
  it('falls back to moduleRef.id when trialFamilyHint is absent', () => {
    const noHint = computeFamilyKey(famInput({ trialFamilyHint: undefined, moduleRef: { id: 'short_after_pump' } }));
    const hintEqualsModuleId = computeFamilyKey(famInput({ trialFamilyHint: 'short_after_pump', moduleRef: { id: 'short_after_pump' } }));
    expect(noHint).toBe(hintEqualsModuleId);
  });
});

function rec(over: Partial<TrialRecord> = {}): TrialRecord {
  return {
    familyKey: 'fam-1',
    requestFingerprint: 'fp-a',
    runId: 'run-a',
    resultHash: 'sha256:aaa',
    trialFamilyHint: undefined,
    marketContext: {
      datasetRef: 'smoke-btc-1m',
      symbols: ['BTCUSDT'],
      timeframe: '1m',
      period: { from: '2023-11-14T00:00:00.000Z', to: '2023-11-15T00:00:00.000Z' },
    },
    sharpe: 0.3,
    skew: 0,
    kurtosis: 3,
    tCount: 100,
    createdAtMs: 1_000_000,
    ...over,
  };
}

describe('InMemoryTrialLedger', () => {
  it('records a new trial and queries it back by family', async () => {
    const ledger = new InMemoryTrialLedger();
    const inserted = await ledger.recordIfNew(rec());
    expect(inserted).toBe(true);
    const trials = await ledger.query('fam-1');
    expect(trials.length).toBe(1);
    expect(trials[0].sharpe).toBe(0.3);
  });

  it('deduplicates on (familyKey, requestFingerprint) — replay does not inflate N', async () => {
    const ledger = new InMemoryTrialLedger();
    expect(await ledger.recordIfNew(rec({ requestFingerprint: 'fp-a', runId: 'run-1' }))).toBe(true);
    expect(await ledger.recordIfNew(rec({ requestFingerprint: 'fp-a', runId: 'run-2' }))).toBe(false);
    expect((await ledger.query('fam-1')).length).toBe(1);
  });

  it('counts distinct trials (distinct fingerprints) in one family', async () => {
    const ledger = new InMemoryTrialLedger();
    await ledger.recordIfNew(rec({ requestFingerprint: 'fp-a' }));
    await ledger.recordIfNew(rec({ requestFingerprint: 'fp-b' }));
    await ledger.recordIfNew(rec({ requestFingerprint: 'fp-c' }));
    expect((await ledger.query('fam-1')).length).toBe(3);
  });

  it('isolates families', async () => {
    const ledger = new InMemoryTrialLedger();
    await ledger.recordIfNew(rec({ familyKey: 'fam-1', requestFingerprint: 'fp-a' }));
    await ledger.recordIfNew(rec({ familyKey: 'fam-2', requestFingerprint: 'fp-a' }));
    expect((await ledger.query('fam-1')).length).toBe(1);
    expect((await ledger.query('fam-2')).length).toBe(1);
    expect(await ledger.query('fam-absent')).toEqual([]);
  });
});

function eq(values: readonly number[]): EquityPoint[] {
  return values.map((equity, i) => ({ barIndex: i, barTs: i * 60_000, equity }));
}

describe('dsrInputsFromEquity', () => {
  it('returns quantized sharpe/skew/kurtosis/tCount from the equity curve', () => {
    // returns [0.2,-0.1,0.2,-0.1] ⇒ sharpe 1/3, skew 0, Pearson kurtosis 1, T 4
    const r = dsrInputsFromEquity(eq([100, 120, 108, 129.6, 116.64]));
    expect(r).not.toBeNull();
    expect(r!.sharpe).toBeCloseTo(0.33333333, 8);
    expect(r!.skew).toBeCloseTo(0, 8);
    expect(r!.kurtosis).toBeCloseTo(1, 8);
    expect(r!.tCount).toBe(4);
  });
  it('returns null for fewer than 2 returns', () => {
    expect(dsrInputsFromEquity(eq([100, 110]))).toBeNull();
  });
  it('returns null when the series is invalid (a prior equity is 0)', () => {
    expect(dsrInputsFromEquity(eq([100, 0, 50]))).toBeNull();
  });
});
