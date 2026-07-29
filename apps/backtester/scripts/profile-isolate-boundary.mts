// PERF — декомпозиция стоимости ПЕРЕХОДА host↔isolate (границы), без работы стратегии.
//
// Что уже померено другими станками и почему их не хватает.
//   · `profile-context.mts`   — постройка `StrategyContext` на хосте, ДО границы.
//   · `profile-rehydrate.mts` — работа харнесса ПОСЛЕ того, как сообщение уже внутри изолята.
// Между ними — сам переход: сборка снапшота, `JSON.stringify`, вход в изолят, копирование
// аргумента, `JSON.parse` внутри, копирование ответа наружу, `JSON.parse` на хосте. Эту полосу не
// видит ни один из двух станков: хостовый профилировщик схлопывает её в native-кадр, а внутренний
// станок начинает считать уже после неё.
//
// Как устроен замер. Лестница: каждая ступень добавляет РОВНО ОДИН слой к предыдущей, поэтому
// цена слоя — разность соседних ступеней, а не доля в профиле. Работы стратегии нет нигде: внутри
// изолята живёт заглушка, а не харнесс. Мы меряем цену конверта, а не письма.
//
//   0 loop            — накладные самого цикла (пол измерения)
//   1 applySync       — вызов прекомпилированной ссылки, без аргументов        ← пол границы
//   2 + payload       — тот же вызов, аргументом реальный JSON снапшота        ← копирование внутрь
//   3 + JSON.parse    — заглушка разбирает аргумент                            ← разбор внутри
//   4 + result        — заглушка возвращает реальный JSON решений              ← копирование наружу
//   5 evalClosureSync — то же, но через `evalClosure`                          ← компиляция строки
//   6 evalClosure     — то же асинхронно (текущий прод)                        ← промис + поток
//   7 + host race     — плюс `Promise.race` с `setTimeout` (текущий прод)      ← хостовый гард
//   8 host codec      — `JSON.stringify` + `JSON.parse` на хосте, без изолята
//
// Ступень 7 — это ровно то, что прод платит за бар помимо работы стратегии. Ступень 1 —
// неустранимый пол. Разности между ними называют цену каждого проектного решения поимённо.
//
// Отдельный вопрос — чувствительность к размеру. `analysis/18` предлагает `ExternalCopy` и
// диффы снапшота; и то и другое окупается ТОЛЬКО если цена растёт с байтами. Если она
// фиксированная на вызов, уменьшать payload бессмысленно, и чинить надо механизм вызова. Станок
// прогоняет прод-ступень на трёх размерах payload и отвечает на это прямо.
//
//   taskset -c 2,3 pnpm exec tsx apps/backtester/scripts/profile-isolate-boundary.mts
//   IB_BARS=20000 IB_REPEATS=9 taskset -c 2,3 pnpm exec tsx ...

import { assertQuietBench, assertStableSamples, minOf } from './lib/bench-gate.js';

assertQuietBench('profile-isolate-boundary');

const BARS = Math.max(1, Number(process.env.IB_BARS ?? 20_000));
const REPEATS = Math.max(4, Number(process.env.IB_REPEATS ?? 9));
const WALL_MS = Number(process.env.IB_WALL_MS ?? 2_000);

// widened specifier — тот же паттерн, что в `isolate-executor.ts`: tsc не резолвит нативный аддон.
const IVM_SPECIFIER = 'isolated-vm';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ivmMod: any = await import(IVM_SPECIFIER);
const ivm = ivmMod.default ?? ivmMod;

// --- Реальная форма сообщения --------------------------------------------------------------------
// Повторяет `{hook, snapshot, newBar}` из `IsolateModuleExecutor.callHook` (см. context-serializer).
// `params` — единственное поле переменного размера, через него и масштабируем payload.

const T0 = 1_700_000_000_000;

function buildMessage(paramCount: number): unknown {
  const params: Record<string, unknown> = {};
  for (let i = 0; i < paramCount; i += 1) params[`tunable_${i}`] = 0.5 + i / 1000;
  const bar = { ts: T0, open: 100.25, high: 100.75, low: 99.5, close: 100.5, volume: 1234.5 };
  return {
    hook: 'onBarClose',
    snapshot: {
      run: { runId: 'ib-bench-0000', mode: 'research', seed: 1 },
      params,
      symbol: 'BTCUSDT',
      barIndex: 4321,
      bar,
      position: { side: 'long', size: 0.125, entryPrice: 99.875, stop: 98.0, take: 105.0 },
      pendingIntent: null,
      portfolio: { equity: 10_432.19, openPositions: 1 },
      clockNow: T0,
    },
    newBar: bar,
  };
}

// Ответ заглушки — то, что харнесс отдаёт на подавляющем большинстве баров (решения нет).
const RESULT_JSON = '{"ok":true,"decisions":[]}';

// --- Изолят с заглушкой ---------------------------------------------------------------------------
// Внутри НЕ харнесс, а четыре функции ровно под ступени лестницы. Заглушка «трогает» разобранный
// объект (`m.snapshot.barIndex`), чтобы V8 не выбросил разбор как мёртвый код.

const isolate = new ivm.Isolate({ memoryLimit: 128 });
const context = await isolate.createContext();
await (
  await isolate.compileScript(`
    globalThis.__b = {
      noop() { return '{}'; },
      sink(s) { return typeof s === 'string' ? '{}' : '{}'; },
      parse(s) { const m = JSON.parse(s); return m.snapshot.barIndex >= 0 ? '{}' : '{}'; },
      full(s) { const m = JSON.parse(s); return m.snapshot.barIndex >= 0 ? ${JSON.stringify(RESULT_JSON)} : '{}'; },
      // Заглушка с РЕГУЛИРУЕМОЙ работой внутри: нужна, чтобы проверить, зависит ли цена
      // асинхронного захода от того, сколько вызванная функция считает.
      work(s, n) {
        const m = JSON.parse(s);
        let acc = m.snapshot.barIndex;
        for (let i = 1; i <= n; i += 1) { acc = (acc * 31 + i) % 1000003; }
        return acc >= 0 ? ${JSON.stringify(RESULT_JSON)} : '{}';
      },
    };
  `)
).run(context);

const bag = await context.global.get('__b', { reference: true });
const refNoop = await bag.get('noop', { reference: true });
const refSink = await bag.get('sink', { reference: true });
const refParse = await bag.get('parse', { reference: true });
const refFull = await bag.get('full', { reference: true });

const APPLY_OPTS = { result: { copy: true }, timeout: WALL_MS } as const;
const EVAL_OPTS = { result: { copy: true }, timeout: WALL_MS } as const;

// --- Ступени --------------------------------------------------------------------------------------

type Rung = { readonly id: string; readonly label: string; readonly run: (json: string) => Promise<void> | void };

// eslint-disable-next-line @typescript-eslint/no-empty-function
function noopLocal(_s: string): string {
  return '{}';
}

/** Копия хостового гарда из `evalHarness` — Promise.race с таймером на каждый вызов. */
async function withHostRace<T>(p: Promise<T>, budgetMs: number): Promise<T> {
  let raceTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    return (await Promise.race([
      p,
      new Promise((_res, rej) => {
        raceTimer = setTimeout(() => rej(new Error('isolate call timed out (host race)')), budgetMs + 500);
        raceTimer.unref?.();
      }),
    ])) as T;
  } finally {
    clearTimeout(raceTimer);
  }
}

let sink = 0;

const RUNGS: readonly Rung[] = [
  { id: '0', label: 'loop            (пол измерения)', run: (j) => void (sink += noopLocal(j).length) },
  { id: '1', label: 'applySync       (пол границы)', run: () => void (sink += (refNoop.applySync(undefined, [], APPLY_OPTS) as string).length) },
  { id: '2', label: '+ payload       (копирование внутрь)', run: (j) => void (sink += (refSink.applySync(undefined, [j], APPLY_OPTS) as string).length) },
  { id: '3', label: '+ JSON.parse    (разбор внутри)', run: (j) => void (sink += (refParse.applySync(undefined, [j], APPLY_OPTS) as string).length) },
  { id: '4', label: '+ result        (копирование наружу)', run: (j) => void (sink += (refFull.applySync(undefined, [j], APPLY_OPTS) as string).length) },
  {
    id: '5',
    label: 'evalClosureSync (компиляция строки)',
    run: (j) => void (sink += (context.evalClosureSync('return globalThis.__b.full($0)', [j], EVAL_OPTS) as string).length),
  },
  {
    id: '6',
    label: 'evalClosure     (промис + поток)',
    run: async (j) => {
      sink += ((await context.evalClosure('return globalThis.__b.full($0)', [j], EVAL_OPTS)) as string).length;
    },
  },
  {
    id: '7',
    label: '+ host race     = ТЕКУЩИЙ ПРОД',
    run: async (j) => {
      const p = context.evalClosure('return globalThis.__b.full($0)', [j], EVAL_OPTS) as Promise<string>;
      sink += (await withHostRace(p, WALL_MS)).length;
    },
  },
  {
    id: '8',
    label: 'host codec      (stringify+parse, без изолята)',
    run: () => {
      const json = JSON.stringify(MESSAGE);
      sink += (JSON.parse(RESULT_JSON) as { decisions: unknown[] }).decisions.length + json.length;
    },
  },
];

// --- Прогон ---------------------------------------------------------------------------------------

/**
 * Прогрев — ПОЛНЫМИ проходами прямо перед замером ступени, а не общей разминкой в начале.
 *
 * Почему так. Первая версия грела все ступени по 200 итераций разом, и повторы ступени `applySync`
 * легли явным убывающим трендом: 8, 10, 7, 7, … 6, 5, 5. Это не чужая работа на стенде — это V8,
 * который дотягивал код до верхнего уровня оптимизации уже ВНУТРИ замера. Гейт воспроизводимости
 * такой тренд честно ловит (половины систематически разъезжаются), но чинить надо не гейт:
 * пока ступень греется, её первые повторы измеряют компилятор, а не границу.
 *
 * Двух проходов хватило не всем: ступень с разбором И возвратом строки продолжала съезжать
 * (21 → 15 мкс за 160 тыс. вызовов) — там к JIT добавляется рост кучи ВНУТРИ изолята, а он
 * выходит на стационар медленнее. Отсюда пять проходов: гейт не ослаблен, устранена причина.
 */
const WARMUP_PASSES = Math.max(1, Number(process.env.IB_WARMUP ?? 5));

async function measure(rung: Rung, json: string): Promise<number[]> {
  for (let w = 0; w < WARMUP_PASSES; w += 1) {
    for (let i = 0; i < BARS; i += 1) await rung.run(json);
  }
  const samples: number[] = [];
  for (let r = 0; r < REPEATS; r += 1) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < BARS; i += 1) await rung.run(json);
    const t1 = process.hrtime.bigint();
    samples.push(Number(t1 - t0) / 1000 / BARS); // мкс на вызов
  }
  return samples;
}

/**
 * Все ступени ЧЕРЕДУЯСЬ, а не по очереди целиком.
 *
 * Фазовый порядок оказался источником систематического смещения (см. отзыв в `profile-isolate-cpu`):
 * долгая работа предыдущей ступени занимала оба закреплённых ядра, фоновый оптимизирующий
 * компилятор V8 не успевал, и следующая ступень весь прогон шла неоптимизированной. Внутри прогона
 * это стабильно — гейт половин пропускает; между прогонами гуляет в разы. Чередование раскладывает
 * помеху на все ступени поровну и делает результат воспроизводимым между процессами.
 */
async function measureAll(rungs: readonly Rung[], json: string): Promise<Map<string, number[]>> {
  for (let w = 0; w < WARMUP_PASSES; w += 1) {
    for (const rung of rungs) for (let i = 0; i < BARS; i += 1) await rung.run(json);
  }
  const samples = new Map<string, number[]>(rungs.map((r) => [r.id, []]));
  for (let r = 0; r < REPEATS; r += 1) {
    for (const rung of rungs) {
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < BARS; i += 1) await rung.run(json);
      const t1 = process.hrtime.bigint();
      samples.get(rung.id)!.push(Number(t1 - t0) / 1000 / BARS);
    }
  }
  return samples;
}

const PARAM_COUNTS = (process.env.IB_PARAMS ?? '0,8,64').split(',').map((s) => Number(s.trim()));
const REAL_PARAMS = PARAM_COUNTS[1] ?? 8;

let MESSAGE = buildMessage(REAL_PARAMS);
const REAL_JSON = JSON.stringify(MESSAGE);

console.log(
  `\n[isolate-boundary] ivm=${String(ivmMod.default !== undefined)} bars=${BARS} repeats=${REPEATS} ` +
    `payload=${Buffer.byteLength(REAL_JSON, 'utf8')} байт (${REAL_PARAMS} params), ответ=${RESULT_JSON.length} байт\n`,
);

console.log('  #  слой                                            мкс/вызов      Δ к предыдущему');
console.log('  ─────────────────────────────────────────────────────────────────────────────────');

// Разрешение станка. Относительный допуск ×1.15 бессмысленен на величинах порядка десятых долей
// микросекунды: пустой цикл давал половины 0.1 и 0.1 при дрейфе ×1.22 — не потому, что по стенду
// прошлась чужая работа, а потому что там нечего мерить, и в дело вступают гранулярность таймера
// и случайность JIT. Ниже порога число печатается с пометкой `~` и объявляется неразрешимым:
// действовать по нему нельзя — ровно то же правило, по которому волны D/E не отчитывались
// эффектами ниже разрешения стенда. Выше порога гейт остаётся жёстким отказом.
const GATE_FLOOR_US = 1.0;

/** Куча ИЗОЛЯТА (не хоста) в МБ — растёт ли она от вызова к вызову. */
async function isolateHeapMb(): Promise<number> {
  const h = (await isolate.getHeapStatistics()) as { used_heap_size: number };
  return h.used_heap_size / (1024 * 1024);
}

let prev: number | undefined;
const results = new Map<string, number>();
const allSamples = await measureAll(RUNGS, REAL_JSON);
for (const rung of RUNGS) {
  const heapBefore = await isolateHeapMb();
  const samples = allSamples.get(rung.id)!;
  const heapAfter = await isolateHeapMb();
  if (process.env.IB_HEAP === 'true') {
    console.log(
      `      [heap] #${rung.id}: ${heapBefore.toFixed(1)} → ${heapAfter.toFixed(1)} МБ` +
        `   повторы: ${samples.map((x) => x.toFixed(1)).join(', ')}`,
    );
  }
  const below = minOf(samples) < GATE_FLOOR_US;
  if (!below) assertStableSamples(`isolate-boundary #${rung.id}`, samples);
  const us = minOf(samples);
  results.set(rung.id, us);
  // Ступень 8 стоит вне лестницы (это хост без изолята) — дельту для неё не считаем.
  const delta = rung.id === '8' || prev === undefined ? '' : `${us - prev >= 0 ? '+' : ''}${(us - prev).toFixed(3)}`;
  const shown = `${below ? '~' : ' '}${us.toFixed(3)}`;
  console.log(`  ${rung.id}  ${rung.label.padEnd(46)}  ${shown.padStart(9)}  ${delta.padStart(18)}`);
  if (rung.id !== '8') prev = us;
}

// --- Чувствительность к размеру payload -----------------------------------------------------------
// Прод-ступень на трёх размерах. Если цена почти не меняется — она фиксированная на вызов, и
// `ExternalCopy` / диффы снапшота из analysis/18 не окупятся; чинить надо механизм вызова.

console.log('\n  Чувствительность прод-ступени (#7) к размеру payload:');
console.log('  ─────────────────────────────────────────────────────');
const prod = RUNGS.find((r) => r.id === '7')!;
for (const n of PARAM_COUNTS) {
  MESSAGE = buildMessage(n);
  const json = JSON.stringify(MESSAGE);
  const samples = await measure(prod, json); // measure() сама греет под новый размер
  assertStableSamples(`isolate-boundary size=${n}`, samples);
  console.log(`  ${String(Buffer.byteLength(json, 'utf8')).padStart(6)} байт  →  ${minOf(samples).toFixed(3)} мкс/вызов`);
}

console.log(
  `\n  «~» — ступень ниже ${GATE_FLOOR_US.toFixed(1)} мкс, разрешения станка: гейт воспроизводимости` +
    ' к ней не применялся, действовать по такому числу нельзя.' +
    `\n  (sink=${sink} — чтобы V8 не выбросил замеряемую работу)\n`,
);

isolate.dispose();
