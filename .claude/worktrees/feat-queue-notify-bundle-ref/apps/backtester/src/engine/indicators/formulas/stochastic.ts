// 020 — streaming Stochastic Oscillator (contracts/formula-semantics.md, research formula-risk 7).
//
// %K_raw = 100·(close − lowₖ)/(highₖ − lowₖ) по окну `k`; сглаживание %K за `smooth` (SMA);
// %D = SMA(сглаженного %K, `d`). output `{k,d}`; warmup `k + smooth + d − 2`.
// Вырожденно: highₖ=lowₖ ⇒ %K = 50 (фиксированная конвенция, конечно, не NaN).
// ВЕСЬ объект `undefined`, пока не готовы оба поля (%D готов последним).

import type { Bar } from '@trading/research-contracts/research';
import type { StochasticValue } from '@trading/research-contracts/research';
import type { BarFormula } from './atr.js';

function mean(xs: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < xs.length; i += 1) sum += xs[i];
  return sum / xs.length;
}

export function createStochastic(k: number, d: number, smooth: number): BarFormula<StochasticValue> {
  const highs: number[] = [];
  const lows: number[] = [];
  const rawWindow: number[] = []; // последние `smooth` сырых %K
  const dWindow: number[] = []; // последние `d` сглаженных %K
  let out: StochasticValue | undefined;
  return {
    update(bar: Readonly<Bar>): void {
      highs.push(bar.high);
      lows.push(bar.low);
      if (highs.length > k) {
        highs.shift();
        lows.shift();
      }
      if (highs.length < k) return;

      let highK = highs[0];
      let lowK = lows[0];
      for (let i = 1; i < k; i += 1) {
        if (highs[i] > highK) highK = highs[i];
        if (lows[i] < lowK) lowK = lows[i];
      }
      const rawK = highK === lowK ? 50 : 100 * ((bar.close - lowK) / (highK - lowK));

      rawWindow.push(rawK);
      if (rawWindow.length > smooth) rawWindow.shift();
      if (rawWindow.length < smooth) return;
      const smoothedK = mean(rawWindow);

      dWindow.push(smoothedK);
      if (dWindow.length > d) dWindow.shift();
      if (dWindow.length < d) return;

      out = { k: smoothedK, d: mean(dWindow) };
    },
    get value(): StochasticValue | undefined {
      return out;
    },
  };
}
