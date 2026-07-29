// PERF — стоит ли ОДИН И ТОТ ЖЕ чистый JS внутри изолята дороже, чем на хосте.
//
// Зачем этот вопрос. Сквозной замер (bt#193) разложил пербарную цену изолята так: базовая работа
// на доверенном пути 41 мкс, конверт границы ~144 мкс, работа харнесса ВНУТРИ изолята 430 мкс.
// Последняя статья доминирует, и напрашивается вывод «харнесс написан плохо». Но у него есть
// конкурент: в замере границы `JSON.parse` того же 653-байтного сообщения стоил 15 мкс ВНУТРИ
// изолята против 5–6 мкс на весь хостовый кодек (stringify+parse) — то есть та же работа внутри
// заметно дороже.
//
// Эти две гипотезы требуют разного лечения и потому должны быть разделены ДО любой правки:
//   · «харнесс делает лишнее»          → чинить харнесс, выигрыш реален;
//   · «в изоляте всё исполняется медленнее» → харнесс ни при чём, и оптимизировать его бессмысленно.
//
// ОТЗЫВ ПРЕДЫДУЩЕГО ВЫВОДА (bt#194). Первая редакция станка напечатала ×11 на коротких заходах и
// заключила, что код в них не поднимается V8 на оптимизирующий уровень. Вывод НЕВЕРЕН, и вот чем
// это установлено:
//
//   · прямой опрос `%GetOptimizationStatus` внутри изолята (`profile-isolate-tierup.mts`) после
//     тысяч коротких заходов возвращает «оптимизирована, turbofan» — то есть tier-up происходит;
//   · повторные прогоны того же станка дали ×11.1, ×1.31, ×1.24, ×3.42. Величина гуляет в разы
//     между прогонами при том, что ВНУТРИ прогона гейт воспроизводимости минимума проходит.
//
// Второе и есть диагноз самого станка: смещение постоянно внутри одного процесса и потому
// невидимо для гейта половин, а между процессами меняется. Правдоподобная причина — станок
// закреплён за двумя ядрами, а фоновый оптимизирующий компилятор V8 конкурирует за них с
// измеряющим потоком: где он успел отработать, отношение около единицы; где нет — код весь прогон
// идёт интерпретатором, и выходит ×11.
//
// Отсюда правка метода: замеры сценариев ЧЕРЕДУЮТСЯ (round-robin), а не идут фазами. При фазовом
// порядке длинный хостовый разогрев занимал ядра ровно перед изолятными сценариями и создавал
// именно то смещение, которое станок потом печатал как результат.
//
// ЧТО СТАНОК ПОКАЗЫВАЕТ ДОСТОВЕРНО: изолят НЕ медленнее хоста, если дать ему непрерывный кусок
// работы. Величину «налога на дробление» он на этой машине не разрешает — и обязан об этом
// говорить, а не печатать число.
//
// Историческая справка — числа первой редакции (НЕ ОПИРАТЬСЯ):
//
//   работа на заход   хост      изолят, заход на ядро   изолят, один заход на пакет
//   16 мкс            16.2      185.3  (x11.1)          16.0  (x0.99)
//   800 мкс          800.7      848.6  (x1.05)         848.8  (x1.06)
//
// Фиксированной цены захода нет: накладные у короткого вызова (169 мкс) БОЛЬШЕ, чем у длинного
// (48 мкс). Единственное, что это объясняет — код, вызываемый короткими заходами снаружи, НЕ
// поднимается V8 на оптимизирующий уровень: каждый заход исполняет его заново интерпретатором.
// Длинный вызов успевает поймать OSR внутри своего цикла и дальше идёт оптимизированным, а пакет
// из 800 ядер в одном заходе — тем более. Таймаут ни при чём: без него x10.3 против x11.1.
//
// Практический смысл: пербарный хук — это короткий заход, поэтому стратегия исполняется
// интерпретатором на КАЖДОМ баре. Отсюда и 430 мкс «работы харнесса» из bt#193 при 41 мкс той же
// работы на доверенном пути. Лечится не переписыванием харнесса, а укрупнением порции работы на
// одно пересечение — либо выяснением, можно ли заставить isolated-vm доводить tier-up между
// вызовами.
//
// Как разделяются. Берётся ядро без ввода-вывода, без аллокаций сложных объектов и без внешних
// зависимостей — чистая арифметика в цикле — и гоняется дважды: на хосте и внутри изолята через
// уже прекомпилированную ссылку (чтобы не мерить компиляцию строки). Отношение — и есть
// «налог изолята» на исполнение кода. Всё, что сверх него, честно принадлежит харнессу.
//
// Ядро намеренно тупое: если бы оно звало встроенные функции движка или аллоцировало, замер
// смешал бы налог интерпретатора с разницей в реализации встроенных примитивов.
//
//   taskset -c 2,3 pnpm exec tsx apps/backtester/scripts/profile-isolate-cpu.mts

import { assertQuietBench, assertStableSamples, minOf } from './lib/bench-gate.js';

assertQuietBench('profile-isolate-cpu');

const ITERS = Math.max(1, Number(process.env.IC_ITERS ?? 2_000));
const CALLS = Math.max(1, Number(process.env.IC_CALLS ?? 5_000));
const REPEATS = Math.max(4, Number(process.env.IC_REPEATS ?? 12));
const WARMUP = Math.max(1, Number(process.env.IC_WARMUP ?? 3));

const IVM_SPECIFIER = 'isolated-vm';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ivmMod: any = await import(IVM_SPECIFIER);
const ivm = ivmMod.default ?? ivmMod;

// Ядро — одним исходником на обе стороны, чтобы «тот же код» было буквально, а не на словах.
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

// --- Хост ------------------------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const hostKernel = new Function(`${KERNEL_SRC}; return kernel;`)() as (n: number) => number;

// --- Изолят ----------------------------------------------------------------------------------------
const isolate = new ivm.Isolate({ memoryLimit: 128 });
const context = await isolate.createContext();
await (
  await isolate.compileScript(
    `${KERNEL_SRC};
     globalThis.__k = kernel;
     // Тот же цикл, но ЦЕЛИКОМ внутри: один заход на весь пакет вызовов.
     globalThis.__kLoop = function (calls, n) { let s = 0; for (let c = 0; c < calls; c += 1) s += kernel(n); return s; };`,
  )
).run(context);
const refKernel = await context.global.get('__k', { reference: true });
const refKernelLoop = await context.global.get('__kLoop', { reference: true });
const APPLY = { result: { copy: true }, timeout: 30_000 } as const;

// --- Замер -----------------------------------------------------------------------------------------

let sink = 0;

function measureHost(): number {
  const t0 = process.hrtime.bigint();
  for (let c = 0; c < CALLS; c += 1) sink += hostKernel(ITERS);
  return Number(process.hrtime.bigint() - t0) / 1000 / CALLS; // мкс на вызов
}

function measureIsolate(): number {
  const t0 = process.hrtime.bigint();
  for (let c = 0; c < CALLS; c += 1) sink += refKernel.applySync(undefined, [ITERS], APPLY) as number;
  return Number(process.hrtime.bigint() - t0) / 1000 / CALLS;
}

/**
 * То же самое БЕЗ `timeout`.
 *
 * Пол границы в bt#191 — 5.5 мкс на прекомпилированный `applySync`, но там вызываемая функция не
 * делала ничего. Здесь тот же `applySync` с 16-микросекундным ядром внутри стоит под 175 мкс, то
 * есть накладные выросли в тридцать раз от того, что вызов стал делать работу. Так ведёт себя не
 * стоимость перехода, а сторожевой механизм: `timeout` в isolated-vm реализован через отдельный
 * поток и `TerminateExecution`, и его присутствие может менять режим исполнения.
 *
 * Замер разделяет: если без таймаута цена падает — платим за гард, и это наш выбор, а не свойство
 * изолята. ВНИМАНИЕ: снятие таймаута в проде недопустимо (враждебный бандл повесит воркер) —
 * это диагностический вариант, не предложение.
 */
const APPLY_NO_TIMEOUT = { result: { copy: true } } as const;

function measureIsolateNoTimeout(): number {
  const t0 = process.hrtime.bigint();
  for (let c = 0; c < CALLS; c += 1) sink += refKernel.applySync(undefined, [ITERS], APPLY_NO_TIMEOUT) as number;
  return Number(process.hrtime.bigint() - t0) / 1000 / CALLS;
}

/**
 * Тот же пакет вызовов, но ОДНИМ заходом в изолят.
 *
 * Это и есть развилка диагноза. Если цена одного ядра здесь падает до хостовой, значит налог берётся
 * ЗА ЗАХОД, а не за исполнение — и лечится он укрупнением порции работы на пересечение, а не
 * переписыванием харнесса. Если остаётся высокой — в изоляте действительно медленнее исполняется код,
 * и никакая правка харнесса этого не снимет.
 */
function measureIsolateLoop(): number {
  const t0 = process.hrtime.bigint();
  sink += refKernelLoop.applySync(undefined, [CALLS, ITERS], APPLY) as number;
  return Number(process.hrtime.bigint() - t0) / 1000 / CALLS;
}

/**
 * Round-robin по сценариям, а не фазами.
 *
 * Первая редакция мерила каждый сценарий целиком по очереди, и длинный хостовый разогрев занимал
 * оба закреплённых ядра ровно перед изолятными сценариями. Фоновый оптимизирующий компилятор V8
 * не успевал, изолятный код весь прогон шёл интерпретатором, и станок печатал это как «налог
 * изолята» — величину, которая между прогонами меняется в разы. Чередование раскладывает такую
 * помеху на все сценарии поровну.
 */
function runAll(scenarios: readonly (readonly [string, () => number])[]): Map<string, number> {
  for (let w = 0; w < WARMUP; w += 1) for (const [, fn] of scenarios) fn();
  const samples = new Map<string, number[]>(scenarios.map(([l]) => [l, []]));
  for (let r = 0; r < REPEATS; r += 1) {
    for (const [label, fn] of scenarios) samples.get(label)!.push(fn());
  }
  const out = new Map<string, number>();
  for (const [label, xs] of samples) {
    assertStableSamples(`isolate-cpu ${label}`, xs);
    out.set(label, minOf(xs));
  }
  return out;
}

// Проверка тождественности ДО замера: если стороны считают разное, сравнивать их скорость незачем.
const hostValue = hostKernel(ITERS);
const isoValue = refKernel.applySync(undefined, [ITERS], APPLY) as number;
if (hostValue !== isoValue) {
  console.error(`ядро вернуло разное: хост ${hostValue}, изолят ${isoValue} — сравнение бессмысленно`);
  process.exit(2);
}

console.log(`\n[isolate-cpu] итераций в ядре=${ITERS}, вызовов=${CALLS}, повторов=${REPEATS}, ядро вернуло ${hostValue}\n`);

const measured = runAll([
  ['host', measureHost],
  ['isolate', measureIsolate],
  ['isolate-no-timeout', measureIsolateNoTimeout],
  ['isolate-loop', measureIsolateLoop],
]);
const host = measured.get('host')!;
const iso = measured.get('isolate')!;
const isoNoTo = measured.get('isolate-no-timeout')!;
const isoLoop = measured.get('isolate-loop')!;

// Пол границы (bt#191): прекомпилированный `applySync` без полезной нагрузки ≈ 5.5 мкс. Вычитаем
// его, иначе налог на исполнение был бы завышен стоимостью самого захода.
const BOUNDARY_FLOOR_US = 5.5;
const isoNet = iso - BOUNDARY_FLOOR_US;

console.log(`  хост                              ${host.toFixed(1).padStart(9)} мкс/ядро`);
console.log(`  изолят, заход на каждое ядро      ${iso.toFixed(1).padStart(9)} мкс/ядро`);
console.log(`  … он же минус пол границы         ${isoNet.toFixed(1).padStart(9)} мкс/ядро`);
console.log(`  изолят, заход без таймаута        ${isoNoTo.toFixed(1).padStart(9)} мкс/ядро`);
console.log(`  изолят, ОДИН заход на весь пакет  ${isoLoop.toFixed(1).padStart(9)} мкс/ядро`);
console.log('');
console.log(`  налог при заходе на каждое ядро:  ×${(isoNet / host).toFixed(2)}`);
console.log(`  налог без таймаута:               ×${((isoNoTo - BOUNDARY_FLOOR_US) / host).toFixed(2)}`);
console.log(`  налог при одном заходе на пакет:  ×${(isoLoop / host).toFixed(2)}`);
console.log('');
console.log('  Достоверно: изолят НЕ медленнее хоста на непрерывном куске работы' +
  ` (×${(isoLoop / host).toFixed(2)}).`);
console.log('');
console.log('  Величину «налога на дробление» этот станок на данной машине НЕ РАЗРЕШАЕТ: между');
console.log('  прогонами она наблюдалась от ×1.2 до ×11 при проходящем гейте внутри прогона.');
console.log('  Опираться на неё нельзя — см. отзыв вывода bt#194 в шапке файла.');
console.log(`\n  (sink=${sink} — чтобы V8 не выбросил замеряемую работу)\n`);

isolate.dispose();
