// Гейт волны B: «мутация контекста не наблюдаема».
//
// Флаг `BACKTESTER_CONTEXT_FREEZE=false` снимает пербарную заморозку, и вопрос ровно один: может
// ли стратегия, подержавшая ссылку на `ctx`, увидеть чужой бар или испортить чужой. Ответ должен
// держаться НЕ на дисциплине авторов стратегий, а на устройстве построителя, поэтому здесь
// проверяется каждый путь, по которому утечка была бы возможна.

import { describe, expect, it } from 'vitest';

import { makeRequest, makeTrustedDeps, DEFAULT_PROBE } from '../scripts/lib/profile-runner-fixture.js';
import { runBacktest } from '../src/engine/runner.js';
import { contentRef } from '../src/determinism/hash.js';
import { PointInTimeContextBuilder } from '../src/engine/context.js';
import { createSeededRng } from '../src/determinism/rng.js';
import type { Bar } from '@trading/research-contracts/research';
import type { StrategyContext } from '@trading/research-contracts/research';

const T0 = 1_700_000_000_000;

function candlesOf(n: number): readonly Readonly<Bar>[] {
  return Object.freeze(
    Array.from({ length: n }, (_, i) =>
      Object.freeze({ ts: T0 + i * 60_000, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 10 }),
    ),
  );
}

function builderWith(freeze: boolean, params: Record<string, unknown> = { alpha: 1 }) {
  return new PointInTimeContextBuilder(
    {
      run: { runId: 'freeze-test', mode: 'research', seed: 7 } as never,
      params,
      symbol: 'BTCUSDT',
      candles: candlesOf(5),
      rng: createSeededRng(7),
    },
    { freeze },
  );
}

function stateAt(i: number) {
  return { position: null, pendingIntent: null, portfolio: { equity: 1000 + i, openPositions: 0 } } as never;
}

describe('BACKTESTER_CONTEXT_FREEZE — ненаблюдаемость мутации', () => {
  it('дефолт морозит: мутация контекста бросает', () => {
    const ctx = builderWith(true).build(1, stateAt(1));
    expect(() => {
      (ctx as unknown as Record<string, unknown>).symbol = 'ETHUSDT';
    }).toThrow(TypeError);
  });

  for (const freeze of [true, false]) {
    describe(`freeze=${freeze}`, () => {
      it('удержанный контекст остаётся СНИМКОМ своего бара, а не окном в текущий', () => {
        const b = builderWith(freeze);
        const held: StrategyContext = b.build(1, stateAt(1));
        const heldBarTs = held.bar.ts;
        const heldEquity = held.portfolio.equity;

        b.build(2, stateAt(2));
        b.build(3, stateAt(3));

        // Это и есть гейт: значения бара 1 не поехали за курсором.
        expect(held.bar.ts).toBe(heldBarTs);
        expect(held.portfolio.equity).toBe(heldEquity);
        expect(held.clock.now()).toBe(heldBarTs);
        // Ленивые API удержанного контекста тоже смотрят на свой бар: closedCandles строго ДО t.
        expect(held.data.closedCandles(10)).toHaveLength(1);
      });

      it('свечи заморожены у источника, поэтому испортить ленту нельзя ни при каком флаге', () => {
        const b = builderWith(freeze);
        const ctx = b.build(2, stateAt(2));
        expect(() => {
          (ctx.bar as unknown as Record<string, number>).close = -1;
        }).toThrow(TypeError);
        expect(b.build(2, stateAt(2)).bar.close).toBe(102);
      });

      it('run и params заморожены один раз на символ — общее между барами защищено всегда', () => {
        const params = { alpha: 1 };
        const b = builderWith(freeze, params);
        const ctx = b.build(0, stateAt(0));
        expect(() => {
          (ctx.params as unknown as Record<string, unknown>).alpha = 999;
        }).toThrow(TypeError);
        expect(() => {
          (ctx.run as unknown as Record<string, unknown>).seed = 999;
        }).toThrow(TypeError);
        // Следующий бар видит нетронутые params — общий объект не удалось сдвинуть.
        expect(b.build(1, stateAt(1)).params).toEqual({ alpha: 1 });
      });

      it('порча пербарного снимка не переносится на следующий бар', () => {
        const b = builderWith(freeze);
        const ctx = b.build(1, stateAt(1));
        // При freeze=true это бросит, при freeze=false — пройдёт, и именно поэтому проверяем
        // не сам факт записи, а её последствия для СЛЕДУЮЩЕГО бара.
        try {
          (ctx.portfolio as unknown as Record<string, number>).equity = -777;
        } catch {
          /* frozen — тем лучше */
        }
        expect(b.build(2, stateAt(2)).portfolio.equity).toBe(1002);
      });
    });
  }

  it('оба режима строят одинаковые значения — флаг не влияет на числа', () => {
    const frozen = builderWith(true);
    const plain = builderWith(false);
    for (let i = 0; i < 5; i += 1) {
      const a = frozen.build(i, stateAt(i));
      const b = plain.build(i, stateAt(i));
      expect(JSON.parse(JSON.stringify({ bar: b.bar, portfolio: b.portfolio, symbol: b.symbol }))).toEqual(
        JSON.parse(JSON.stringify({ bar: a.bar, portfolio: a.portfolio, symbol: a.symbol })),
      );
      expect(b.data.closedCandles(3)).toEqual(a.data.closedCandles(3));
      expect(b.clock.now()).toBe(a.clock.now());
    }
  });

  // Сквозное доказательство: то, что значения совпадают на построителе, ещё не значит, что
  // совпадёт результат прогона. Здесь один и тот же бэктест гоняется в обоих режимах, и
  // сверяется КОНТЕНТ-ХЕШ артефакта — та же величина, которой мерится байт-идентичность
  // golden'ов. Расхождение здесь означало бы, что флаг влияет на числа, а не только на скорость.
  it('прогон с флагом и без даёт байт-идентичный результат', async () => {
    const spec = { symbols: ['BTCUSDT'], bars: 600, seed: 12345, barMajor: false, probe: DEFAULT_PROBE };
    const request = makeRequest(spec);

    const hashes: string[] = [];
    for (const contextFreeze of [true, false]) {
      const deps = makeTrustedDeps(spec);
      const out = await runBacktest(request, { ...deps, contextFreeze });
      if (out.status !== 'completed') throw new Error('прогон отклонён: ' + JSON.stringify(out.validation));
      hashes.push(contentRef(out.baseline));
      deps.router?.closeAll();
    }

    expect(hashes[1]).toBe(hashes[0]);
  }, 60_000);
});
