// 020 — streaming SMA (contracts/formula-semantics.md).
//
// Среднее source по окну [t−period+1, t]; warmup `period`; до ready → undefined.
// Сумма считается по окну в порядке возрастания индекса — байт-в-байт как legacy
// `smaAsOf` (back-compat `value('sma',N) === indicatorAsOf('sma_<N>')`).

export interface ScalarFormula {
  update(x: number): void;
  readonly value: number | undefined;
}

export function createSma(period: number): ScalarFormula {
  const window: number[] = [];
  return {
    update(x: number): void {
      window.push(x);
      if (window.length > period) window.shift();
    },
    get value(): number | undefined {
      if (window.length < period) return undefined;
      let sum = 0;
      for (let i = 0; i < window.length; i += 1) sum += window[i];
      return sum / period;
    },
  };
}
