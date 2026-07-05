// 020 — streaming EMA (contracts/formula-semantics.md).
//
// seed = SMA первых `period` значений; mult = 2/(period+1); warmup `period`.
// До накопления `period` значений → undefined.

import type { ScalarFormula } from './sma.js';

export function createEma(period: number): ScalarFormula {
  const mult = 2 / (period + 1);
  const seed: number[] = [];
  let ema: number | undefined;
  let ready = false;
  return {
    update(x: number): void {
      if (!ready) {
        seed.push(x);
        if (seed.length === period) {
          let sum = 0;
          for (let i = 0; i < period; i += 1) sum += seed[i];
          ema = sum / period;
          ready = true;
        }
        return;
      }
      const prev = ema as number;
      ema = (x - prev) * mult + prev;
    },
    get value(): number | undefined {
      return ready ? ema : undefined;
    },
  };
}
