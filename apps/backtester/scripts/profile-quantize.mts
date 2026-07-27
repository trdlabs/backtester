// PERF — проверка гипотезы «quantize можно сделать без Decimal и без строки».
//
// `quantize` (@trdlabs/engine, determinism/canonical-json.ts) сейчас делает полный круг
// `new Decimal(n).toDecimalPlaces(8, HALF_EVEN).toFixed()` → строка → `Number`. Он вызывается
// 6–12 раз на бар (equityAt, protectionLevels, execution, funding), и CPU-профиль раннера показал
// decimal.js как самую дорогую статью — 37 % времени бара.
//
// Станок отвечает на ДВА вопроса сразу, потому что по отдельности они бесполезны:
//   1) насколько быстрее целочисленный вариант;
//   2) совпадает ли он с текущим ПОБИТОВО на реалистичных величинах — иначе поедут все golden'ы.
//
// ВАЖНО про методику. Ответ (2) ДЕТЕРМИНИРОВАН: расхождения не зависят ни от машины, ни от
// нагрузки, и его можно снимать где угодно. Ответ (1) — обычный тайминг, и на загруженной машине
// он врёт: снимать только когда `uptime` показывает load average заметно меньше числа ядер,
// иначе цифра нс/вызов уедет в разы (проверено — на load 13 при 4 ядрах абсолют завышался
// примерно на порядок, хотя отношение держалось).
//
//   pnpm exec tsx apps/backtester/scripts/profile-quantize.mts

import { Decimal } from 'decimal.js';

import { assertQuietBench } from './lib/bench-gate.js';

// Часть (2) станка — сверка значений — детерминирована и от нагрузки не зависит, но часть (1) это
// тайминг, и печатаются они вместе. Поэтому гейт стоит на входе целиком.
assertQuietBench('profile-quantize');

Decimal.set({ rounding: Decimal.ROUND_HALF_EVEN });

const SCALE = 8;
const POW = 1e8;

/** Текущая реализация (скопирована дословно из engine/src/determinism/canonical-json.ts). */
function quantizeCurrent(n: number): number {
  let d = new Decimal(n).toDecimalPlaces(SCALE, Decimal.ROUND_HALF_EVEN);
  if (d.isZero()) d = new Decimal(0);
  return Number(d.toFixed());
}

/**
 * Кандидат: масштабирование на 1e8 и half-even округление без аллокаций.
 *
 * `Math.round` округляет .5 ВВЕРХ (не half-even), поэтому серединный случай ловится отдельно.
 * Сам множитель 1e8 вносит ошибку представления, поэтому побитового совпадения ждать нельзя —
 * ровно это и проверяет вторая часть станка.
 */
function quantizeFast(n: number): number {
  const scaled = n * POW;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  let r: number;
  if (diff > 0.5) r = floor + 1;
  else if (diff < 0.5) r = floor;
  else r = floor % 2 === 0 ? floor : floor + 1; // ровно .5 → к чётному
  const out = r / POW;
  return out === 0 ? 0 : out;
}

// ---- 1. Скорость -------------------------------------------------------------------------------

const N = 200_000;
const sample: number[] = new Array(N);
let s = 12345 >>> 0;
for (let i = 0; i < N; i += 1) {
  s = (s * 1_664_525 + 1_013_904_223) >>> 0;
  const u = s / 4_294_967_296;
  // Реалистичный микс: цены (1e1–1e5), размеры (1e-4–1e2), notional/pnl (1e2–1e6).
  sample[i] = i % 3 === 0 ? u * 100_000 : i % 3 === 1 ? u * 100 : (u - 0.5) * 1_000_000;
}

function bench(fn: (n: number) => number, repeats = 5): number {
  let best = Number.POSITIVE_INFINITY;
  for (let r = 0; r < repeats; r += 1) {
    const t0 = process.hrtime.bigint();
    let sink = 0;
    for (let i = 0; i < N; i += 1) sink += fn(sample[i]!);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (sink === Number.POSITIVE_INFINITY) console.log('');
    best = Math.min(best, ms);
  }
  return best;
}

bench(quantizeCurrent, 2);
bench(quantizeFast, 2);
const msCurrent = bench(quantizeCurrent);
const msFast = bench(quantizeFast);

console.log('## Скорость\n');
console.log(`| Вариант | ${N.toLocaleString('ru')} вызовов | нс/вызов |`);
console.log('| --- | ---: | ---: |');
console.log(`| текущий (Decimal + строка) | ${msCurrent.toFixed(1)} мс | ${((msCurrent * 1e6) / N).toFixed(0)} |`);
console.log(`| кандидат (целочисленный) | ${msFast.toFixed(1)} мс | ${((msFast * 1e6) / N).toFixed(0)} |`);
console.log(`\nУскорение: **${(msCurrent / msFast).toFixed(1)}×**`);

// ---- 2. Побитовая эквивалентность --------------------------------------------------------------

let mismatches = 0;
const examples: string[] = [];
for (let i = 0; i < N; i += 1) {
  const a = quantizeCurrent(sample[i]!);
  const b = quantizeFast(sample[i]!);
  if (!Object.is(a, b)) {
    mismatches += 1;
    if (examples.length < 5) examples.push(`${sample[i]} → текущий ${a}, кандидат ${b}`);
  }
}

console.log('\n## Побитовая эквивалентность\n');
console.log(`Расхождений: **${mismatches}** из ${N.toLocaleString('ru')} (${((mismatches / N) * 100).toFixed(4)} %)`);
if (examples.length > 0) {
  console.log('\nПримеры:');
  for (const e of examples) console.log(`- ${e}`);
}
console.log(
  mismatches === 0
    ? '\nВЕРДИКТ: на этой выборке кандидат побитово совпадает — замена не двигает golden\'ы.'
    : "\nВЕРДИКТ: кандидат НЕ побитово эквивалентен — прямая замена сдвинет golden'ы. Нужен либо гибрид (быстрый путь + проверка), либо осознанная переморозка golden'ов.",
);
