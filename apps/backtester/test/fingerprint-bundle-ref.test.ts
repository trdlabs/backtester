import { describe, expect, it } from 'vitest';
import { requestFingerprint } from '../src/jobs/fingerprint.js';
import { bundleHash } from '../src/sandbox/bundle.js';
import { makeBundle } from './helpers.js';

describe('fingerprint is bundle-source-invariant', () => {
  it('inline moduleBundle and bundleRef(hash) produce the same fingerprint', () => {
    const bundle = makeBundle();
    const base = {
      datasetRef: 'X:1m',
      moduleRef: { id: 'm', version: '1' },
      symbols: ['X'],
      timeframe: '1m',
      period: { from: '2026-01-01', to: '2026-01-02' },
      seed: 1,
      mode: 'research',
      metrics: ['pnl'],
    } as const;
    const inline = requestFingerprint({ ...base, moduleBundle: bundle } as never);
    const byRef = requestFingerprint({ ...base, bundleRef: bundleHash(bundle) } as never);
    expect(byRef).toBe(inline);
  });
});
