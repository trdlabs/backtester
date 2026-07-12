// E2 — unit tests for the pure Deflated Sharpe Ratio module (engine/deflated-sharpe.ts).
// Deterministic math: normal CDF/inverse-CDF, deflation threshold, DSR, and the computeDsr
// orchestrator with its cold-start / vSR-basis / fail-closed guards.

import { describe, expect, it } from 'vitest';
import {
  asymptoticSharpeVariance,
  computeDsr,
  deflatedSharpe,
  deflationThreshold,
  normalCdf,
  normalInvCdf,
} from '../src/engine/deflated-sharpe.js';

describe('normalCdf', () => {
  it('Φ(0) = 0.5', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
  });
  it('Φ(1.96) ≈ 0.975', () => {
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 4);
  });
  it('Φ(-1.96) ≈ 0.025', () => {
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 4);
  });
  it('is bounded in [0,1] at extremes', () => {
    expect(normalCdf(-40)).toBeGreaterThanOrEqual(0);
    expect(normalCdf(40)).toBeLessThanOrEqual(1);
  });
});

describe('normalInvCdf', () => {
  it('Φ⁻¹(0.5) = 0', () => {
    expect(normalInvCdf(0.5)).toBeCloseTo(0, 6);
  });
  it('Φ⁻¹(0.975) ≈ 1.95996', () => {
    expect(normalInvCdf(0.975)).toBeCloseTo(1.95996, 4);
  });
  it('round-trips Φ⁻¹(Φ(x)) ≈ x', () => {
    for (const x of [-2, -0.7, 0.3, 1.5]) {
      expect(normalInvCdf(normalCdf(x))).toBeCloseTo(x, 4);
    }
  });
});

describe('asymptoticSharpeVariance', () => {
  it('= (1 + 0.5·sr²)/T', () => {
    expect(asymptoticSharpeVariance(0.1, 100)).toBeCloseTo(0.01005, 8); // (1+0.005)/100
  });
});

describe('deflationThreshold', () => {
  it('is 0 when vSR is 0 (no trial dispersion)', () => {
    expect(deflationThreshold(0, 100)).toBeCloseTo(0, 8);
  });
  it('N=2, vSR=1 ≈ 0.5196', () => {
    // √1 · [(1−γ)·Φ⁻¹(0.5) + γ·Φ⁻¹(1−1/(2e))] = γ·Φ⁻¹(0.81606) ≈ 0.5772·0.9001
    expect(deflationThreshold(1, 2)).toBeCloseTo(0.5196, 2);
  });
  it('increases with N (more trials ⇒ higher bar)', () => {
    expect(deflationThreshold(1, 1000)).toBeGreaterThan(deflationThreshold(1, 10));
  });
});

describe('deflatedSharpe', () => {
  it('= 0.5 when sr = sr0 (numerator 0)', () => {
    expect(deflatedSharpe({ sr: 0, skew: 0, kurtosis: 3, T: 101, sr0: 0 })).toBeCloseTo(0.5, 6);
  });
  it('increases with sr', () => {
    const lo = deflatedSharpe({ sr: 0.02, skew: 0, kurtosis: 3, T: 101, sr0: 0 });
    const hi = deflatedSharpe({ sr: 0.08, skew: 0, kurtosis: 3, T: 101, sr0: 0 });
    expect(hi).toBeGreaterThan(lo);
  });
});

describe('computeDsr — orchestrator', () => {
  const base = { sr: 0.05, skew: 0, kurtosis: 3, T: 101, empiricalMinN: 5 };

  it('N=1 cold start: sr0=0, asymptotic, finite (no Inf/NaN)', () => {
    const r = computeDsr({ ...base, priorSharpes: [0.05] });
    expect(r).not.toBeNull();
    expect(r!.sr0).toBe(0);
    expect(r!.vSRBasis).toBe('asymptotic');
    expect(r!.trialCount).toBe(1);
    expect(Number.isFinite(r!.deflatedSharpe)).toBe(true);
    expect(Number.isFinite(r!.vSR)).toBe(true);
  });

  it('1 < N < empiricalMinN uses asymptotic vSR', () => {
    const r = computeDsr({ ...base, priorSharpes: [0.04, 0.05, 0.06] });
    expect(r!.vSRBasis).toBe('asymptotic');
    expect(r!.vSR).toBeCloseTo(asymptoticSharpeVariance(base.sr, base.T), 6);
    expect(r!.trialCount).toBe(3);
  });

  it('N ≥ empiricalMinN uses empirical sample variance of prior sharpes', () => {
    const r = computeDsr({ ...base, priorSharpes: [0.1, 0.2, 0.3, 0.4, 0.5] });
    expect(r!.vSRBasis).toBe('empirical');
    expect(r!.vSR).toBeCloseTo(0.025, 8); // unbiased sample variance
    expect(r!.trialCount).toBe(5);
    expect(r!.sr0).toBeGreaterThan(0);
  });

  it('returns null when T < 2 (degenerate)', () => {
    expect(computeDsr({ ...base, T: 1, priorSharpes: [0.05] })).toBeNull();
  });

  it('returns null when the DSR denominator is non-positive', () => {
    // extreme negative skew forces 1 − skew·sr + (kurt−1)/4·sr² ≤ 0
    expect(
      computeDsr({ sr: 5, skew: 100, kurtosis: 3, T: 101, empiricalMinN: 5, priorSharpes: [5] }),
    ).toBeNull();
  });

  it('all outputs are finite numbers on the happy path', () => {
    const r = computeDsr({ ...base, priorSharpes: [0.03, 0.05, 0.04, 0.06, 0.05, 0.05] })!;
    for (const v of [r.deflatedSharpe, r.sr0, r.vSR, r.trialCount, r.tCount]) {
      expect(Number.isFinite(v)).toBe(true);
    }
    expect(r.deflatedSharpe).toBeGreaterThanOrEqual(0);
    expect(r.deflatedSharpe).toBeLessThanOrEqual(1);
  });

  it('falls back to asymptotic vSR when N ≥ empiricalMinN but sample variance is 0 (identical Sharpes)', () => {
    // 5 identical trial Sharpes ⇒ empirical vSR = 0 ⇒ WITHOUT a fallback sr0 collapses to 0 and the
    // multiple-testing penalty vanishes. Must fall back to the asymptotic variance instead.
    const r = computeDsr({ ...base, priorSharpes: [0.3, 0.3, 0.3, 0.3, 0.3] });
    expect(r).not.toBeNull();
    expect(r!.vSRBasis).toBe('asymptotic');
    expect(r!.vSR).toBeGreaterThan(0);
    expect(r!.sr0).toBeGreaterThan(0);
  });
});
