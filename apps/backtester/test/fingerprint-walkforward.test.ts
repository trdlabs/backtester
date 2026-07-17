import { describe, expect, it } from 'vitest';
import type { RunSubmitRequest } from '@trdlabs/backtester-sdk/contracts';
import { requestFingerprint } from '../src/jobs/fingerprint.js';

const base = {
  mode: 'research', moduleRef: { id: 'm', version: '1' }, datasetRef: 'ds', symbols: ['BTCUSDT'],
  timeframe: '1m', period: { from: '2023-01-01T00:00:00.000Z', to: '2023-01-02T00:00:00.000Z' },
  seed: 1, metrics: ['sharpe'],
} as unknown as RunSubmitRequest;

describe('requestFingerprint — walkForward is run-affecting but absent-safe', () => {
  it('an absent scheme keeps a byte-identical fingerprint (golden pin)', () => {
    // BASELINE: run `requestFingerprint(base)` on the CURRENT code BEFORE adding walkForward to
    // normalize(), copy the printed hash here. After the change this MUST stay equal (conditional
    // spread ⇒ absent key ⇒ unchanged canonical JSON). Fill GOLDEN from the pre-change run.
    const GOLDEN = 'b879ba38eb64b1ff3aa7ac429aecfdaca1f5b771f89c19a10b3cff98adfcb2c5';
    expect(requestFingerprint({ ...base } as RunSubmitRequest)).toBe(GOLDEN);
  });
  it('differs when only the walkForward scheme differs', () => {
    const a = requestFingerprint({ ...base, walkForward: { folds: 3, mode: 'rolling' } } as RunSubmitRequest);
    const b = requestFingerprint({ ...base, walkForward: { folds: 5, mode: 'rolling' } } as RunSubmitRequest);
    expect(a).not.toBe(b);
  });
  it('an absent scheme equals an explicit-undefined scheme', () => {
    expect(requestFingerprint({ ...base } as RunSubmitRequest))
      .toBe(requestFingerprint({ ...base, walkForward: undefined } as RunSubmitRequest));
  });
});
