// 020 — streaming ADX, Wilder smoothing (contracts/formula-semantics.md, research formula-risk 6).
//
// +DM/−DM из движения экстремумов, TR как в ATR; Wilder-сглаживание +DM/−DM/TR за `period`;
// +DI = 100·smPDM/smTR, −DI = 100·smMDM/smTR; DX = 100·|+DI−−DI|/(+DI+−DI); ADX = Wilder RMA(DX).
// Вырожденно: +DI+−DI=0 ⇒ DX=0; smTR=0 ⇒ DI=0 (конечно, не NaN).
//
// Warmup-конвенция (чтобы ready ровно на barIndex `2·period−2` = warmup−1 при warmup=`2·period−1`):
// бар 0 даёт TR=high−low и +DM=−DM=0 (нет prev) — он входит в первое Wilder-сглаживание из `period`
// значений; первый DX доступен на barIndex `period−1`; ADX seed — простое среднее первых `period` DX
// (barIndex `period−1 .. 2·period−2`), далее Wilder RMA. Точные выходы пиннятся golden (US5).

import type { Bar } from '@trading/research-contracts/research';
import type { BarFormula } from './atr.js';

export function createAdx(period: number): BarFormula<number> {
  let prev: Readonly<Bar> | undefined;

  // Wilder-сглаженные суммы +DM/−DM/TR (seed = сумма первых `period`, далее RMA-вычитание).
  let smPDM = 0;
  let smMDM = 0;
  let smTR = 0;
  let seedCount = 0; // сколько (TR,+DM,−DM) накоплено для seed смуза
  let smoothed = false;

  // ADX-сглаживание DX.
  let dxSum = 0;
  let dxCount = 0;
  let adx: number | undefined;
  let ready = false;

  function dxFrom(pdm: number, mdm: number, tr: number): number {
    if (tr === 0) return 0; // флэт: нет направленного движения
    const pdi = 100 * (pdm / tr);
    const mdi = 100 * (mdm / tr);
    const sum = pdi + mdi;
    if (sum === 0) return 0;
    return 100 * (Math.abs(pdi - mdi) / sum);
  }

  function ingestDx(dx: number): void {
    if (!ready) {
      dxSum += dx;
      dxCount += 1;
      if (dxCount === period) {
        adx = dxSum / period;
        ready = true;
      }
      return;
    }
    adx = ((adx as number) * (period - 1) + dx) / period;
  }

  return {
    update(bar: Readonly<Bar>): void {
      let tr: number;
      let pdm: number;
      let mdm: number;
      if (prev === undefined) {
        // Бар 0: prev нет → TR=high−low, направленного движения нет.
        tr = bar.high - bar.low;
        pdm = 0;
        mdm = 0;
      } else {
        const upMove = bar.high - prev.high;
        const downMove = prev.low - bar.low;
        pdm = upMove > downMove && upMove > 0 ? upMove : 0;
        mdm = downMove > upMove && downMove > 0 ? downMove : 0;
        tr = Math.max(bar.high - bar.low, Math.abs(bar.high - prev.close), Math.abs(bar.low - prev.close));
      }
      prev = bar;

      if (!smoothed) {
        smPDM += pdm;
        smMDM += mdm;
        smTR += tr;
        seedCount += 1;
        if (seedCount === period) {
          smoothed = true;
          ingestDx(dxFrom(smPDM, smMDM, smTR)); // первый DX на barIndex period−1
        }
        return;
      }
      // Wilder RMA сглаженных сумм.
      smPDM = smPDM - smPDM / period + pdm;
      smMDM = smMDM - smMDM / period + mdm;
      smTR = smTR - smTR / period + tr;
      ingestDx(dxFrom(smPDM, smMDM, smTR));
    },
    get value(): number | undefined {
      return ready ? adx : undefined;
    },
  };
}
