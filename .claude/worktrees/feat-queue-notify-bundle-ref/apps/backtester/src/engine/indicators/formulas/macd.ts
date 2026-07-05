// 020 — streaming MACD (contracts/formula-semantics.md).
//
// macd = EMA(fast) − EMA(slow); signal = EMA(signal) от macd-линии; hist = macd − signal.
// warmup `slow + signal − 1`; ВЕСЬ объект `undefined`, пока не готовы все поля.

import type { MacdValue } from '@trading/research-contracts/research';

import { createEma } from './ema.js';

export interface MacdFormula {
  update(x: number): void;
  readonly value: MacdValue | undefined;
}

export function createMacd(fast: number, slow: number, signal: number): MacdFormula {
  const emaFast = createEma(fast);
  const emaSlow = createEma(slow);
  const emaSignal = createEma(signal);
  let out: MacdValue | undefined;
  return {
    update(x: number): void {
      emaFast.update(x);
      emaSlow.update(x);
      const f = emaFast.value;
      const s = emaSlow.value;
      if (f === undefined || s === undefined) return; // macd-линия ещё не готова
      const macdLine = f - s;
      emaSignal.update(macdLine);
      const sig = emaSignal.value;
      if (sig === undefined) return; // signal-EMA не seeded — объект остаётся undefined
      out = { macd: macdLine, signal: sig, histogram: macdLine - sig };
    },
    get value(): MacdValue | undefined {
      return out;
    },
  };
}
