// 020 — streaming Stochastic Oscillator (contracts/formula-semantics.md, research formula-risk 7).
//
// %K_raw = 100·(close − lowₖ)/(highₖ − lowₖ) по окну `k`; сглаживание %K за `smooth` (SMA);
// %D = SMA(сглаженного %K, `d`). output `{k,d}`; warmup `k + smooth + d − 2`.
// Вырожденно: highₖ=lowₖ ⇒ %K = 50 (фиксированная конвенция, конечно, не NaN).
// ВЕСЬ объект `undefined`, пока не готовы оба поля (%D готов последним).

import type { Bar } from '@trading/research-contracts/research';
import type { StochasticValue } from '@trading/research-contracts/research';
import type { BarFormula } from './atr.js';
import { RingWindow } from './ring.js';

function mean(xs: RingWindow): number {
  return xs.sum() / xs.length;
}

export function createStochastic(k: number, d: number, smooth: number): BarFormula<StochasticValue> {
  // Кольца вместо push/shift: четыре окна сдвигались целиком на каждом баре. Порядок обхода
  // (от старого к свежему) сохранён — усреднение %K и %D суммирует те же слагаемые в том же
  // порядке, значит числа не двигаются.
  const highs = new RingWindow(k);
  const lows = new RingWindow(k);
  const rawWindow = new RingWindow(smooth); // последние `smooth` сырых %K
  const dWindow = new RingWindow(d); // последние `d` сглаженных %K
  let out: StochasticValue | undefined;
  return {
    update(bar: Readonly<Bar>): void {
      highs.push(bar.high);
      lows.push(bar.low);
      if (highs.length < k) return;

      let highK = highs.at(0);
      let lowK = lows.at(0);
      for (let i = 1; i < k; i += 1) {
        const h = highs.at(i);
        const l = lows.at(i);
        if (h > highK) highK = h;
        if (l < lowK) lowK = l;
      }
      const rawK = highK === lowK ? 50 : 100 * ((bar.close - lowK) / (highK - lowK));

      rawWindow.push(rawK);
      if (rawWindow.length < smooth) return;
      const smoothedK = mean(rawWindow);

      dWindow.push(smoothedK);
      if (dWindow.length < d) return;

      out = { k: smoothedK, d: mean(dWindow) };
    },
    get value(): StochasticValue | undefined {
      return out;
    },
  };
}
