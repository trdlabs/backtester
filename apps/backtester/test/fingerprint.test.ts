import { describe, expect, it } from 'vitest';
import { requestFingerprint } from '../src/jobs/fingerprint';

const base = {
  mode: 'research',
  moduleRef: { id: 'short_after_pump', version: '0.1.0' },
  datasetRef: 'BTCUSDT:1d',
  symbols: ['BTCUSDT'],
  timeframe: '1d',
  period: { from: '2024-06-07T00:00:00.000Z', to: '2024-06-13T00:00:00.000Z' },
  seed: 42,
  metrics: ['pnl'],
} as const;

describe('requestFingerprint', () => {
  it('same request → same fingerprint', () => {
    expect(requestFingerprint(base as any)).toBe(requestFingerprint(base as any));
  });

  it('different seed → different fingerprint', () => {
    expect(requestFingerprint(base as any)).not.toBe(
      requestFingerprint({ ...base, seed: 99 } as any),
    );
  });

  it('distinguishes engine', () => {
    expect(requestFingerprint({ ...base } as any)).not.toBe(
      requestFingerprint({ ...base, engine: 'overlay' } as any),
    );
  });

  it('distinguishes overlayRefs', () => {
    expect(requestFingerprint({ ...base, engine: 'overlay' } as any)).not.toBe(
      requestFingerprint({
        ...base,
        engine: 'overlay',
        overlayRefs: [{ id: 'o', version: '1.0.0' }],
      } as any),
    );
  });

  it('distinguishes risk/exec/robustness', () => {
    const a = requestFingerprint({ ...base, engine: 'overlay' } as any);
    expect(a).not.toBe(
      requestFingerprint({
        ...base,
        engine: 'overlay',
        riskProfileRef: { id: 'default_risk', version: '1.0.0' },
      } as any),
    );
    expect(a).not.toBe(
      requestFingerprint({
        ...base,
        engine: 'overlay',
        executionProfileRef: { id: 'default_exec', version: '1.0.0' },
      } as any),
    );
    expect(a).not.toBe(
      requestFingerprint({
        ...base,
        engine: 'overlay',
        robustnessChecks: ['walk_forward'],
      } as any),
    );
  });

  // research-validation-hardening R1(b): trialFamilyHint is the E2 family-identity hint (lab layer L1)
  // — advisory, and deliberately NOT run-affecting, so it must NOT change the dedup fingerprint. A
  // relabeled hypothesis (or a run submitted without a hint at all) is still the SAME idempotent run.
  it('trialFamilyHint is excluded from the fingerprint (advisory, not a dedup axis)', () => {
    const noHint = requestFingerprint({ ...base } as any);
    const hintA = requestFingerprint({ ...base, trialFamilyHint: 'oi-divergence-v3' } as any);
    const hintB = requestFingerprint({ ...base, trialFamilyHint: 'renamed-hypothesis' } as any);
    expect(hintA).toBe(noHint);
    expect(hintB).toBe(noHint);
  });
});
