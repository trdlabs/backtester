import { describe, expect, it } from 'vitest';
import { computePromotionFamilyKey, computeQualificationEpochKey, computeAttemptIdentity } from '../src/jobs/promotion/identity.js';
import { DatasetIdentityEpochResolver } from '../src/jobs/promotion/epoch-resolver.js';

const req = { moduleRef: { id: 'm' }, datasetRef: 'ds', symbols: ['ETH', 'BTC'], timeframe: '1m',
  period: { from: '2023-01-01T00:00:00.000Z', to: '2023-02-01T00:00:00.000Z' } };

describe('promotion identity', () => {
  it('family key excludes period (two periods, same key) and is symbol-order-insensitive', () => {
    const a = computePromotionFamilyKey(req);
    const b = computePromotionFamilyKey({ ...req, period: { from: '2024-01-01T00:00:00.000Z', to: '2024-02-01T00:00:00.000Z' } } as typeof req);
    const c = computePromotionFamilyKey({ ...req, symbols: ['BTC', 'ETH'] });
    expect(a).toBe(b);
    expect(a).toBe(c);
  });
  it('family key DOES change on datasetRef / timeframe / hint (fields are load-bearing)', () => {
    const a = computePromotionFamilyKey(req);
    expect(computePromotionFamilyKey({ ...req, datasetRef: 'other' })).not.toBe(a);
    expect(computePromotionFamilyKey({ ...req, timeframe: '1h' })).not.toBe(a);
    expect(computePromotionFamilyKey({ ...req, trialFamilyHint: 'hinted' })).not.toBe(a);
    // moduleRef.id feeds hint only when trialFamilyHint is absent
    expect(computePromotionFamilyKey({ ...req, moduleRef: { id: 'other' } })).not.toBe(a);
  });
  it('epoch key differs on epochId / policyVersion; attemptIdentity differs on datasetFingerprint', () => {
    expect(computeQualificationEpochKey('fam', 'e1', 'p1')).not.toBe(computeQualificationEpochKey('fam', 'e2', 'p1'));
    expect(computeQualificationEpochKey('fam', 'e1', 'p1')).not.toBe(computeQualificationEpochKey('fam', 'e1', 'p2'));
    expect(computeAttemptIdentity('fp', 'dsf1')).not.toBe(computeAttemptIdentity('fp', 'dsf2'));
    expect(computeAttemptIdentity('fp', 'dsf1')).toBe(computeAttemptIdentity('fp', 'dsf1'));
  });
});

describe('DatasetIdentityEpochResolver', () => {
  const port = { listDatasets: async () => [{ datasetRef: 'ds' }] } as any;
  it('resolves a known datasetRef to its canonical id', async () => {
    const r = await new DatasetIdentityEpochResolver(port).resolve({ datasetRef: 'ds' } as any);
    expect(r).toEqual({ epochId: 'ds' });
  });
  it('returns null for an unknown datasetRef', async () => {
    expect(await new DatasetIdentityEpochResolver(port).resolve({ datasetRef: 'nope' } as any)).toBeNull();
  });
});
