// 020 — streaming RSI, Wilder smoothing (contracts/formula-semantics.md).
//
// Первый avg = простое среднее gain/loss за `period`; далее RMA `(prev·(p−1)+cur)/p`.
// warmup `period + 1` свеч (close-to-close: нужно `period` изменений).
// Вырожденно: нет убытков → 100; нет прибылей → 0 (конечно, не NaN).

import type { ScalarFormula } from './sma.js';

function rsiFrom(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function createRsi(period: number): ScalarFormula {
  let prevClose: number | undefined;
  let avgGain = 0;
  let avgLoss = 0;
  let seeded = 0;
  let ready = false;
  let rsi: number | undefined;
  return {
    update(x: number): void {
      if (prevClose === undefined) {
        prevClose = x;
        return;
      }
      const diff = x - prevClose;
      prevClose = x;
      const gain = diff > 0 ? diff : 0;
      const loss = diff < 0 ? -diff : 0;
      if (!ready) {
        avgGain += gain;
        avgLoss += loss;
        seeded += 1;
        if (seeded === period) {
          avgGain /= period;
          avgLoss /= period;
          ready = true;
          rsi = rsiFrom(avgGain, avgLoss);
        }
        return;
      }
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      rsi = rsiFrom(avgGain, avgLoss);
    },
    get value(): number | undefined {
      return ready ? rsi : undefined;
    },
  };
}
