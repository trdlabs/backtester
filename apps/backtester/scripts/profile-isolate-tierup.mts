// ДИАГНОСТИКА — поднимает ли V8 на оптимизирующий уровень код, вызываемый короткими заходами
// в изолят, и можно ли на это повлиять.
//
// Что уже известно (bt#194). Одно и то же ядро: раздробленное на короткие заходы стоит ×11 от
// хостовой цены, одним длинным куском — ×1.0. Из четырёх согласованных чисел был ВЫВЕДЕН механизм:
// код в коротких заходах остаётся неоптимизированным. Вывод — не факт, и здесь он проверяется в лоб:
// `%GetOptimizationStatus` спрашивает у V8 состояние конкретной функции.
//
// Второй вопрос станка — практический. Если механизм подтверждается, есть ли способ заставить V8
// довести tier-up без перестройки раннера: флаги V8 в этом процессе общие для всех изолятов
// (`v8.setFlagsFromString`), и `--always-turbofan` компилирует горячий код сразу. Если он снимает
// ×11 — вопрос закрывается настройкой; если нет — остаётся укрупнение порции работы.
//
// ВНИМАНИЕ: `--always-turbofan` здесь — ДИАГНОСТИЧЕСКИЙ инструмент, не предложение для прода.
// Он меняет режим компиляции всему процессу, включая хостовый код, и его влияние на общую
// пропускную способность надо мерить отдельно.
//
//   taskset -c 2,3 pnpm exec tsx apps/backtester/scripts/profile-isolate-tierup.mts

import { setFlagsFromString } from 'node:v8';
import { assertQuietBench, minOf } from './lib/bench-gate.js';

assertQuietBench('profile-isolate-tierup');

const ITERS = Math.max(1, Number(process.env.IT_ITERS ?? 2_000));
const CALLS = Math.max(1, Number(process.env.IT_CALLS ?? 3_000));
const REPEATS = Math.max(3, Number(process.env.IT_REPEATS ?? 7));

// Должно стоять ДО компиляции скриптов, использующих `%`-синтаксис.
setFlagsFromString('--allow-natives-syntax');

const IVM_SPECIFIER = 'isolated-vm';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ivmMod: any = await import(IVM_SPECIFIER);
const ivm = ivmMod.default ?? ivmMod;

const KERNEL_SRC = `
  function kernel(n) {
    let acc = 0;
    for (let i = 1; i <= n; i += 1) {
      acc += (acc + i) % 1000003;
      acc = (acc * 31 + i) % 1000003;
    }
    return acc;
  }
`;

/**
 * Разбор битов `%GetOptimizationStatus`.
 *
 * Позиции битов — деталь конкретной сборки V8 и между версиями двигались, поэтому печатается и
 * сырое число: если раскладка разъедется, сырое значение всё равно покажет, МЕНЯЕТСЯ ли состояние
 * между сценариями, а это и есть главный вопрос.
 */
const BITS: readonly (readonly [number, string])[] = [
  [1 << 0, 'function'],
  [1 << 1, 'never-optimize'],
  [1 << 2, 'always-optimize'],
  [1 << 3, 'maybe-deopted'],
  [1 << 4, 'ОПТИМИЗИРОВАНА'],
  [1 << 5, 'maglev'],
  [1 << 6, 'turbofan'],
  [1 << 7, 'ИНТЕРПРЕТИРУЕТСЯ'],
  [1 << 8, 'помечена к оптимизации'],
];

function decode(status: number): string {
  const on = BITS.filter(([b]) => (status & b) !== 0).map(([, n]) => n);
  return on.length > 0 ? on.join(', ') : '(ни один известный бит)';
}

interface Probe {
  readonly perCallUs: number;
  readonly loopUs: number;
  readonly statusAfterShort: number;
  readonly statusAfterLoop: number;
}

async function probe(): Promise<Probe> {
  const isolate = new ivm.Isolate({ memoryLimit: 128 });
  const context = await isolate.createContext();
  await (
    await isolate.compileScript(
      `${KERNEL_SRC};
       globalThis.__k = kernel;
       globalThis.__kLoop = function (calls, n) { let s = 0; for (let c = 0; c < calls; c += 1) s += kernel(n); return s; };
       globalThis.__status = function () { return %GetOptimizationStatus(kernel); };`,
    )
  ).run(context);

  const refKernel = await context.global.get('__k', { reference: true });
  const refLoop = await context.global.get('__kLoop', { reference: true });
  const refStatus = await context.global.get('__status', { reference: true });
  const OPTS = { result: { copy: true }, timeout: 60_000 } as const;

  const shortPass = (): number => {
    const t0 = process.hrtime.bigint();
    for (let c = 0; c < CALLS; c += 1) refKernel.applySync(undefined, [ITERS], OPTS);
    return Number(process.hrtime.bigint() - t0) / 1000 / CALLS;
  };
  const loopPass = (): number => {
    const t0 = process.hrtime.bigint();
    refLoop.applySync(undefined, [CALLS, ITERS], OPTS);
    return Number(process.hrtime.bigint() - t0) / 1000 / CALLS;
  };

  // Короткие заходы первыми: состояние снимается ИМЕННО после них, до того как длинный вызов
  // получит шанс поднять функцию через OSR.
  for (let w = 0; w < 3; w += 1) shortPass();
  const shortSamples: number[] = [];
  for (let r = 0; r < REPEATS; r += 1) shortSamples.push(shortPass());
  const statusAfterShort = refStatus.applySync(undefined, [], OPTS) as number;

  for (let w = 0; w < 2; w += 1) loopPass();
  const loopSamples: number[] = [];
  for (let r = 0; r < REPEATS; r += 1) loopSamples.push(loopPass());
  const statusAfterLoop = refStatus.applySync(undefined, [], OPTS) as number;

  isolate.dispose();
  return {
    perCallUs: minOf(shortSamples),
    loopUs: minOf(loopSamples),
    statusAfterShort,
    statusAfterLoop,
  };
}

console.log(`\n[isolate-tierup] итераций в ядре=${ITERS}, вызовов=${CALLS}, повторов=${REPEATS}\n`);

console.log('── Опыт 1: как есть ──────────────────────────────────────────────');
const base = await probe();
console.log(`  короткие заходы:            ${base.perCallUs.toFixed(1)} мкс/ядро`);
console.log(`  один заход на весь пакет:   ${base.loopUs.toFixed(1)} мкс/ядро   (×${(base.perCallUs / base.loopUs).toFixed(1)})`);
console.log(`  статус ПОСЛЕ коротких:      ${base.statusAfterShort} → ${decode(base.statusAfterShort)}`);
console.log(`  статус ПОСЛЕ длинного:      ${base.statusAfterLoop} → ${decode(base.statusAfterLoop)}`);

console.log('\n── Опыт 2: --always-turbofan ─────────────────────────────────────');
setFlagsFromString('--always-turbofan');
const forced = await probe();
console.log(`  короткие заходы:            ${forced.perCallUs.toFixed(1)} мкс/ядро`);
console.log(`  один заход на весь пакет:   ${forced.loopUs.toFixed(1)} мкс/ядро   (×${(forced.perCallUs / forced.loopUs).toFixed(1)})`);
console.log(`  статус ПОСЛЕ коротких:      ${forced.statusAfterShort} → ${decode(forced.statusAfterShort)}`);

console.log('\n── Вывод ─────────────────────────────────────────────────────────');
const gain = base.perCallUs / forced.perCallUs;
if (gain > 1.5) {
  console.log(`  Флаг снимает ${gain.toFixed(1)}× с коротких заходов — механизм подтверждён, и на него`);
  console.log('  МОЖНО влиять настройкой. Дальше: мерить влияние флага на процесс целиком.');
} else {
  console.log(`  Флаг не помог (×${gain.toFixed(2)}). Настройкой это не лечится — остаётся укрупнение`);
  console.log('  порции работы на одно пересечение границы.');
}
console.log('');
