// 020 — streaming SMA (contracts/formula-semantics.md).
//
// Среднее source по окну [t−period+1, t]; warmup `period`; до ready → undefined.
// Сумма считается по окну в порядке возрастания индекса — байт-в-байт как legacy
// `smaAsOf` (back-compat `value('sma',N) === indicatorAsOf('sma_<N>')`).

import { RingWindow } from './ring.js';

export interface ScalarFormula {
  update(x: number): void;
  readonly value: number | undefined;
}

export function createSma(period: number): ScalarFormula {
  // Кольцо вместо push/shift: `shift` сдвигал всё окно на каждом баре. Порядок суммирования —
  // от старого к свежему — сохранён специально: он часть back-compat с legacy `smaAsOf`, и
  // перестановка слагаемых сдвинула бы значение в последнем разряде (бегущая сумма — это уже
  // волна C с переморозкой golden'ов, не здесь).
  const window = new RingWindow(period);
  return {
    update(x: number): void {
      window.push(x);
    },
    get value(): number | undefined {
      if (window.length < period) return undefined;
      return window.sum() / period;
    },
  };
}
