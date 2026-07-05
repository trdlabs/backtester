// 020 — streaming ATR, Wilder smoothing (contracts/formula-semantics.md).
//
// TR = max(h−l, |h−prevClose|, |l−prevClose|); ATR = Wilder RMA по TR за `period`.
// warmup `period + 1` (TR требует prevClose — первый бар даёт только prevClose).
// Флэт → TR=0 → ATR конечно (→0).

import type { Bar } from '@trading/research-contracts/research';

export interface BarFormula<T> {
  update(bar: Readonly<Bar>): void;
  readonly value: T | undefined;
}

export function createAtr(period: number): BarFormula<number> {
  let prevClose: number | undefined;
  let trSum = 0;
  let count = 0;
  let atr: number | undefined;
  let ready = false;
  return {
    update(bar: Readonly<Bar>): void {
      if (prevClose === undefined) {
        prevClose = bar.close;
        return;
      }
      const tr = Math.max(
        bar.high - bar.low,
        Math.abs(bar.high - prevClose),
        Math.abs(bar.low - prevClose),
      );
      prevClose = bar.close;
      if (!ready) {
        trSum += tr;
        count += 1;
        if (count === period) {
          atr = trSum / period;
          ready = true;
        }
        return;
      }
      atr = ((atr as number) * (period - 1) + tr) / period;
    },
    get value(): number | undefined {
      return ready ? atr : undefined;
    },
  };
}
