// curatedBaselineRef was omitted from the request fingerprint (found independently 3× in the review).
// It is run-affecting for strategy-evidence runs (drives the curated twin + signed evidenceRef), so a
// resumeToken replay that adds/removes/changes it passed the replay guard and silently re-attached to
// the wrong job. Fold it into the fingerprint — conditionally, so requests WITHOUT it keep byte-identical
// fingerprints (no dedup-cache churn; curated runs bypass the cache anyway). See CODE-REVIEW-2026-07-12.md.

import { describe, expect, it } from 'vitest';
import type { RunSubmitRequest } from '@trdlabs/backtester-sdk/contracts';
import { requestFingerprint } from '../src/jobs/fingerprint.js';

const base = {
  mode: 'research',
  moduleRef: { id: 'm', version: '1.0.0' },
  datasetRef: 'd',
  symbols: ['BTCUSDT'],
  timeframe: '1m',
  period: { from: '2023-11-14T00:00:00.000Z', to: '2023-11-15T00:00:00.000Z' },
  seed: 1,
  metrics: [],
} as unknown as RunSubmitRequest;

describe('requestFingerprint × curatedBaselineRef', () => {
  it('is stable for the same request', () => {
    expect(requestFingerprint(base)).toBe(requestFingerprint(base));
  });

  it('changes when curatedBaselineRef is added', () => {
    const withRef = { ...base, curatedBaselineRef: { id: 'default-overlay', version: '1.0.0' } } as RunSubmitRequest;
    expect(requestFingerprint(withRef)).not.toBe(requestFingerprint(base));
  });

  it('differs between two distinct curatedBaselineRef values', () => {
    const a = { ...base, curatedBaselineRef: { id: 'overlay-a', version: '1.0.0' } } as RunSubmitRequest;
    const b = { ...base, curatedBaselineRef: { id: 'overlay-b', version: '1.0.0' } } as RunSubmitRequest;
    expect(requestFingerprint(a)).not.toBe(requestFingerprint(b));
  });
});
