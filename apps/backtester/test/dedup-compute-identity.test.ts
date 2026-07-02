import { describe, expect, it } from 'vitest';
import { computeIdentity } from '../src/jobs/dedup/compute-identity';

const base = { requestFingerprint: 'fp1', datasetFingerprint: 'ds1', sandboxPolicyVersion: 'sp1' };

describe('computeIdentity', () => {
  it('is stable for identical inputs and sha256-shaped', () => {
    expect(computeIdentity(base)).toBe(computeIdentity({ ...base }));
    expect(computeIdentity(base)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('changes when datasetFingerprint changes', () => {
    expect(computeIdentity({ ...base, datasetFingerprint: 'ds2' })).not.toBe(computeIdentity(base));
  });
  it('changes when sandboxPolicyVersion changes', () => {
    expect(computeIdentity({ ...base, sandboxPolicyVersion: 'sp2' })).not.toBe(computeIdentity(base));
  });
  it('changes when requestFingerprint changes', () => {
    expect(computeIdentity({ ...base, requestFingerprint: 'fp2' })).not.toBe(computeIdentity(base));
  });
});
