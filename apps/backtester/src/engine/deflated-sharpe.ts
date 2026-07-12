// E2 — Deflated Sharpe Ratio (Bailey & López de Prado 2014), pure & deterministic.
// Given a Sharpe estimate + higher moments + sample length T and the trial history of a hypothesis
// family, DSR is the probability the true SR > 0 after deflating for selection bias under N trials.
// Stateless: the caller supplies `priorSharpes` (from the trial ledger). NOT part of any hashed
// payload — DSR is advisory (depends on family history). Normal CDF / inverse-CDF use own
// deterministic approximations (no reliance on a runtime `Math.erf`).

import { quantize } from '../determinism/canonical-json.js';

/** Euler–Mascheroni constant γ (deflation-threshold Gumbel term). */
const EULER_MASCHERONI = 0.5772156649015329;

/**
 * Standard normal CDF Φ(x) via the Numerical-Recipes `erfc` rational approximation
 * (|abs error| < 1.2e-7), so no dependency on a runtime `Math.erf`.
 */
export function normalCdf(x: number): number {
  return 0.5 * erfc(-x / Math.SQRT2);
}

function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const ans =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? ans : 2 - ans;
}

/**
 * Inverse standard normal CDF Φ⁻¹(p) via Acklam's algorithm (relative error < 1.15e-9 in the
 * central region). Returns ±Infinity at the open bounds — callers must guard `p ∈ (0,1)`.
 */
export function normalInvCdf(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239e0,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0, -2.549732539343734e0,
    4.374664141464968e0, 2.938163982698783e0,
  ];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0, 3.754408661907416e0];
  const plow = 0.02425;
  const phigh = 1 - plow;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p <= phigh) {
    const q = p - 0.5;
    const r = q * q;
    return (
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    );
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(
    (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  );
}

/** Asymptotic variance of the Sharpe estimator: (1 + 0.5·sr²)/T. */
export function asymptoticSharpeVariance(sr: number, T: number): number {
  return (1 + 0.5 * sr * sr) / T;
}

/**
 * Deflation threshold SR₀ = √vSR · [ (1−γ)·Φ⁻¹(1−1/N) + γ·Φ⁻¹(1−1/(N·e)) ] (Gumbel expected max of
 * N trial Sharpes). 0 when vSR is 0. Assumes N ≥ 2 (caller guards N ≤ 1 to avoid Φ⁻¹(0) = −∞).
 */
export function deflationThreshold(vSR: number, N: number): number {
  if (vSR <= 0) return 0;
  const term =
    (1 - EULER_MASCHERONI) * normalInvCdf(1 - 1 / N) + EULER_MASCHERONI * normalInvCdf(1 - 1 / (N * Math.E));
  return Math.sqrt(vSR) * term;
}

/**
 * DSR = Φ[ (sr − sr0)·√(T−1) / √(1 − skew·sr + (kurtosis−1)/4·sr²) ] — Pearson kurtosis (normal = 3).
 * Building block: the caller (`computeDsr`) guards `T ≥ 2` and a positive denominator.
 */
export function deflatedSharpe(p: {
  sr: number;
  skew: number;
  kurtosis: number;
  T: number;
  sr0: number;
}): number {
  const denom = 1 - p.skew * p.sr + ((p.kurtosis - 1) / 4) * p.sr * p.sr;
  const z = ((p.sr - p.sr0) * Math.sqrt(p.T - 1)) / Math.sqrt(denom);
  return normalCdf(z);
}

export interface DsrInput {
  readonly sr: number;
  readonly skew: number;
  readonly kurtosis: number;
  readonly T: number;
  /** Sharpes of all recorded trials in the family (this run already included). N = length. */
  readonly priorSharpes: readonly number[];
  /** N at/above which V[SR] switches from asymptotic to empirical sample variance. */
  readonly empiricalMinN: number;
}

export interface DsrResult {
  readonly deflatedSharpe: number;
  readonly trialCount: number;
  readonly sr0: number;
  readonly vSR: number;
  readonly vSRBasis: 'asymptotic' | 'empirical';
  readonly tCount: number;
}

/** Unbiased sample variance; 0 for fewer than 2 observations. */
function sampleVariance(xs: readonly number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const ss = xs.reduce((a, x) => a + (x - mean) ** 2, 0);
  return ss / (n - 1);
}

/**
 * Assemble the DSR for one run given its moments and the family's trial history. Returns `null`
 * (⇒ no trialContext) when inputs are degenerate: non-finite moments, `T < 2`, or a non-positive
 * DSR denominator. Cold start `N ≤ 1` ⇒ sr0 = 0 (DSR reduces to the Probabilistic Sharpe Ratio vs 0).
 */
export function computeDsr(input: DsrInput): DsrResult | null {
  const { sr, skew, kurtosis, T, priorSharpes, empiricalMinN } = input;
  if (!Number.isFinite(sr) || !Number.isFinite(skew) || !Number.isFinite(kurtosis)) return null;
  if (T < 2) return null;
  const denom = 1 - skew * sr + ((kurtosis - 1) / 4) * sr * sr;
  if (!(denom > 0)) return null;

  const N = priorSharpes.length;
  let vSR: number;
  let vSRBasis: 'asymptotic' | 'empirical';
  let sr0: number;
  if (N <= 1) {
    vSR = asymptoticSharpeVariance(sr, T);
    vSRBasis = 'asymptotic';
    sr0 = 0; // cold start — Φ⁻¹(1−1/1) = Φ⁻¹(0) = −∞ otherwise
  } else if (N < empiricalMinN) {
    vSR = asymptoticSharpeVariance(sr, T);
    vSRBasis = 'asymptotic';
    sr0 = deflationThreshold(vSR, N);
  } else {
    const empirical = sampleVariance(priorSharpes);
    // Fall back to asymptotic when the empirical variance is undefined/non-positive (e.g. N identical
    // Sharpes ⇒ 0): otherwise sr0 collapses to 0 and the multiple-testing penalty vanishes.
    if (Number.isFinite(empirical) && empirical > 0) {
      vSR = empirical;
      vSRBasis = 'empirical';
    } else {
      vSR = asymptoticSharpeVariance(sr, T);
      vSRBasis = 'asymptotic';
    }
    sr0 = deflationThreshold(vSR, N);
  }

  const dsr = deflatedSharpe({ sr, skew, kurtosis, T, sr0 });
  if (!Number.isFinite(dsr)) return null;

  return {
    deflatedSharpe: quantize(dsr),
    trialCount: N,
    sr0: quantize(sr0),
    vSR: quantize(vSR),
    vSRBasis,
    tCount: T,
  };
}
