import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { requestFingerprint } from '../src/jobs/fingerprint';

describe('dedup config + bypassCache', () => {
  it('dedupEnabled defaults to false', () => {
    expect(loadConfig({}).dedupEnabled).toBe(false);
  });
  it('dedupEnabled true only for "true"', () => {
    expect(loadConfig({ BACKTESTER_DEDUP_ENABLED: 'true' }).dedupEnabled).toBe(true);
    expect(loadConfig({ BACKTESTER_DEDUP_ENABLED: '1' }).dedupEnabled).toBe(false);
  });
  it('bypassCache does NOT change the request fingerprint', () => {
    const base = {
      mode: 'research', moduleRef: { id: 'm', version: '1.0.0' }, datasetRef: 'd',
      symbols: ['BTCUSDT'], timeframe: '1m', period: { from: 'a', to: 'b' }, seed: 1,
    } as any;
    expect(requestFingerprint({ ...base, bypassCache: true })).toBe(requestFingerprint(base));
  });
});
