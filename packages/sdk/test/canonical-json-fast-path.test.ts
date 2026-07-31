// ГЕЙТ: быстрый путь квантизации целых даёт РОВНО ту же строку, что путь через decimal.js.
//
// `quantizeToString` — сердце детерминизма: его вывод идёт в `contentRef`, то есть в `result_hash`
// каждого прогона. Ускорение здесь допустимо только как тождество, поэтому оно и проверяется как
// тождество: эталон вычисляется ЗДЕСЬ старым кодом, а не берётся из зафиксированных ожиданий —
// иначе тест доказывал бы совпадение с самим собой.
//
// Проверяются не «типичные» числа, а границы, на которых тождество могло бы сломаться:
// нули со знаком, пределы безопасного целого, значения вокруг 1e21 (там `String` уходит в
// экспоненту), и дробные — они обязаны идти прежним путём.

import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import { canonicalJson } from '../src/internal/canonical-json.js';

Decimal.set({ rounding: Decimal.ROUND_HALF_EVEN });

/** Прежняя реализация дословно — эталон сравнения. */
function referenceQuantize(n: number): string {
  let d = new Decimal(n).toDecimalPlaces(8, Decimal.ROUND_HALF_EVEN);
  if (d.isZero()) d = new Decimal(0);
  return d.toFixed();
}

/** Достать канонизированное число обратно из `canonicalJson` (значение сериализуется как есть). */
const canonicalOf = (n: number): string => canonicalJson(n).slice(0, -1);

const EDGE_CASES: readonly number[] = [
  0, -0, 1, -1, 42, -42,
  Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER + 2, // +2: первое НЕбезопасное чётное
  2 ** 53, -(2 ** 53),
  1e20, 1e21, 1e22, -1e21, // вокруг порога экспоненциальной записи у String()
  1_700_000_000_000, // метка времени в миллисекундах — типичный barTs
  0.1, -0.1, 0.5, 1.5, 2.5, // half-even наблюдаем именно здесь
  0.000000005, 0.000000015, 0.123456789, -0.123456789,
  1234.56789012345, 1e-9, -1e-9,
  9007199254740993, // не представимо точно в double
];

describe('канонизация: быстрый путь целых тождественен пути через decimal.js', () => {
  it('совпадает на граничных значениях', () => {
    for (const n of EDGE_CASES) {
      expect(canonicalOf(n), `расхождение на ${String(n)}`).toBe(referenceQuantize(n));
    }
  });

  it('совпадает на псевдослучайной выборке целых и дробных', () => {
    // Детерминированный генератор: провалившийся прогон обязан воспроизводиться.
    let state = 123456789;
    const next = (): number => {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0;
      return state / 4_294_967_296;
    };
    for (let i = 0; i < 5000; i += 1) {
      const magnitude = 10 ** Math.floor(next() * 18);
      const sign = next() < 0.5 ? -1 : 1;
      const asInt = Math.round(next() * magnitude) * sign;
      const asFloat = next() * magnitude * sign;
      expect(canonicalOf(asInt), `целое ${String(asInt)}`).toBe(referenceQuantize(asInt));
      if (Number.isFinite(asFloat)) {
        expect(canonicalOf(asFloat), `дробное ${String(asFloat)}`).toBe(referenceQuantize(asFloat));
      }
    }
  });

  it('целое НЕ теряет знак минус и нормализует минус-ноль', () => {
    expect(canonicalOf(-0)).toBe('0');
    expect(canonicalOf(-7)).toBe('-7');
  });

  it('вложенная структура канонизируется так же, как поэлементно', () => {
    // Проверка того, что быстрый путь не сместил обход: ключи сортируются, порядок массива цел.
    const value = { b: 2, a: [1, -0, 0.5], c: { z: 1e21, y: -3 } };
    expect(canonicalJson(value)).toBe(
      `{"a":[${referenceQuantize(1)},${referenceQuantize(-0)},${referenceQuantize(0.5)}],` +
        `"b":${referenceQuantize(2)},` +
        `"c":{"y":${referenceQuantize(-3)},"z":${referenceQuantize(1e21)}}}\n`,
    );
  });
});
