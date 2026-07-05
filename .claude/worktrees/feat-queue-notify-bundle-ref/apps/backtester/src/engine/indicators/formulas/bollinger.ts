// 020 — streaming Bollinger Bands (contracts/formula-semantics.md).
//
// middle = SMA(period); полосы = middle ± stddev·σ; σ — population (÷N). warmup `period`.
// σ=0 → полосы схлопываются в middle (конечно, не NaN).

import type { BollingerValue } from '@trading/research-contracts/research';

export interface BollingerFormula {
  update(x: number): void;
  readonly value: BollingerValue | undefined;
}

export function createBollinger(period: number, stddev: number): BollingerFormula {
  const window: number[] = [];
  return {
    update(x: number): void {
      window.push(x);
      if (window.length > period) window.shift();
    },
    get value(): BollingerValue | undefined {
      if (window.length < period) return undefined;
      let sum = 0;
      for (let i = 0; i < period; i += 1) sum += window[i];
      const mean = sum / period;
      let varSum = 0;
      for (let i = 0; i < period; i += 1) {
        const d = window[i] - mean;
        varSum += d * d;
      }
      const sigma = Math.sqrt(varSum / period); // population (÷N)
      return { lower: mean - stddev * sigma, middle: mean, upper: mean + stddev * sigma };
    },
  };
}
