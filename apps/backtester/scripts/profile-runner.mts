// PERF — станок для профилирования ЧИСТОЙ стоимости JS-раннера на бар.
//
// Контекст (control-center `docs/analysis/18`, постскриптум-2): после loop-in-isolate граница
// сэндбокса перестала быть узким местом (77.5 мкс/бар batch против 450 мкс lockstep), а 42-дневное
// T2-окно (59 893 бара) занимает 48.6 с, из них engine 34.8 с. Значит ~0.5 мс/бар живёт в самом
// раннере. Владелец: «после замеров принимать решение» о Rust-ядре — этот станок и есть замер.
//
// Станок НЕ гоняет Docker и НЕ гоняет изолят: стратегия — trusted-замыкание стоимостью в счётчик,
// поэтому всё измеренное время принадлежит раннеру (processBar / builder.build / decisionRecords /
// promise-машинерия), а не стратегии и не транспорту.
//
//   pnpm exec tsx apps/backtester/scripts/profile-runner.mts
//   PROFILE_BARS=60000 PROFILE_REPEATS=3 pnpm exec tsx apps/backtester/scripts/profile-runner.mts
//
// Под профилировщиком (даёт `.cpuprofile`, разбирается `analyze-cpuprofile.mts`):
//   node --cpu-prof --cpu-prof-dir=.artifacts/prof --import tsx apps/backtester/scripts/profile-runner.mts

import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertQuietBench, assertStableSamples, minOf } from './lib/bench-gate.js';
import { buildRows, datasetRefOf, makeIsolateDeps, makeRequest, makeTrustedDeps, DEFAULT_PROBE, type WorkloadSpec } from './lib/profile-runner-fixture.js';
import { loadConfig } from '../src/config.js';
import { runBacktestInThread } from '../src/engine/thread/run-in-thread.js';
import type { ThreadRunSpec } from '../src/engine/thread/run-spec.js';
import { encodeTapeColumns } from '../src/engine/tape-columns.js';
import type { RunOutcome } from '../src/engine/artifacts.js';
import { runBacktest, type RunDeps } from '../src/engine/runner.js';
import { contentRef } from '../src/determinism/hash.js';
import { materializeBundle } from '../src/engine/sandbox/bundle-materialize.js';
import type { ModuleBundle as InlineModuleBundle } from '@trading/research-contracts';

assertQuietBench('profile-runner');

const BARS = Math.max(1, Number(process.env.PROFILE_BARS ?? 60_000));
const REPEATS = Math.max(1, Number(process.env.PROFILE_REPEATS ?? 3));

/**
 * ДВУХТОЧЕЧНЫЙ РЕЖИМ (`PROFILE_TWO_POINT=true`) — отделяет предельную цену бара от фиксированной.
 *
 * Зачем. Один и тот же код давал 243.7 мкс/бар на 2 тыс. баров, 133.8 на 15 тыс. и ~60–80 на 40 тыс.
 * Разница вчетверо — и это не «оптимизации JS», а фиксированная часть, поделённая на разное число
 * баров: каждый замерный проход несёт открытие сессии изолята, запуск потока и прочее, что от длины
 * прогона не зависит. Пока она сидит внутри «мкс/бар», числа с прогонов разной длины НЕСОПОСТАВИМЫ.
 *
 * Как считается. Тот же прогон меряется на N и на N/2 барах; предельная цена — разность:
 *
 *     предельная = (T(N) − T(N/2)) / (N − N/2)
 *     фиксированная = T(N) − N × предельная
 *
 * Всё, что не зависит от числа баров, в разности сокращается само — не важно, из чего оно состоит.
 * Дополнительный выигрыш: половинный прогон идёт ПОСЛЕ полного, то есть по уже прогретому JIT, и
 * разность меньше загрязнена разогревом.
 */
const TWO_POINT = process.env.PROFILE_TWO_POINT === 'true';
const SYMBOLS = (process.env.PROFILE_SYMBOLS ?? 'BTCUSDT').split(',').map((s) => s.trim()).filter((s) => s !== '');
const BAR_MAJOR = process.env.PROFILE_BAR_MAJOR === 'true';
// Шаг B2: пербарная заморозка контекста. `false` — прод-режим прогона.
const CONTEXT_FREEZE = process.env.PROFILE_CONTEXT_FREEZE !== 'false';

const LOOKBACK = Math.max(0, Number(process.env.PROFILE_LOOKBACK ?? 0));
const BACKEND = process.env.PROFILE_BACKEND === 'isolate' ? 'isolate' : 'trusted';
// Несёт ли лента рыночные виды. По умолчанию НЕТ — так станок мерил всегда, и менять историческую
// точку отсчёта молча нельзя. Но прод-ленты несут все четыре, поэтому без `=true` станок меряет
// форму, которой на проде не существует: `ctx.market` не строится, `serializeContext` не зондирует
// окна, и целая ветка бара выпадает из замера.
const MARKET_KINDS = process.env.PROFILE_MARKET_KINDS === 'true';
// Батч баров 17b. По умолчанию ВЫКЛЮЧЕН — как в проде (`BACKTESTER_BAR_BATCHING=false`). Раньше он
// был жёстко зашит в `makeIsolateDeps` как `{maxBars:64}`, и станок мерил ветку `runSymbol` с окном
// контекстов, которую прод не исполняет. Значение <2 трактуется как «выключен» (батч из одного бара
// смысла не имеет и в раннере всё равно отсекается).
const BATCH_BARS = Math.max(0, Number(process.env.PROFILE_BATCH_BARS ?? 0));
// Путь к НАСТОЯЩЕЙ ленте (выгрузка из mock-platform). Задан ⇒ синтетика не строится, а `PROFILE_BARS`
// и `PROFILE_MARKET_KINDS` игнорируются: длина и состав видов берутся из данных.
const TAPE_FILE = process.env.PROFILE_TAPE_FILE;
// Гонять ли барный цикл в отдельном потоке — КАК В ПРОДЕ. По умолчанию нет: историческую точку
// отсчёта станка молча сдвигать нельзя, но без `=true` профиль торгового пути нечитаем (см.
// `threadSpec`).
const THREAD = process.env.PROFILE_THREAD === 'true';
// Профили риска/исполнения: историческая точка отсчёта станка (`nocost`) или прод (`prod`).
// В режиме потока выбора нет — поток строит прод-реестр, и `paper_match` в нём отсутствует.
const EXEC_PROFILE: 'nocost' | 'prod' = process.env.PROFILE_EXEC === 'prod' || THREAD ? 'prod' : 'nocost';
if (THREAD && process.env.PROFILE_EXEC !== undefined && process.env.PROFILE_EXEC !== 'prod') {
  // Молча подменить профиль — значит выдать несравнимое число за сравнимое.
  throw new Error(`PROFILE_THREAD=true требует PROFILE_EXEC=prod (задано "${process.env.PROFILE_EXEC}")`);
}
const WALL_MS_PER_CALL = Math.max(2_000, Number(process.env.PROFILE_WALL_MS_PER_CALL ?? 600_000));
const probe = { ...DEFAULT_PROBE, lookback: LOOKBACK };

// В isolate-режиме модуль исполняет РЕАЛЬНЫЙ бандл, поэтому `moduleRef` обязан указывать на его
// манифест, а не на зонд: иначе реестр не разрешит ссылку и прогон будет отклонён до симуляции.
//
// `PROFILE_BUNDLE` — имя фикстуры бандла. Ключ существует потому, что бандл по умолчанию
// (`short_after_pump`) на синтетической ленте НЕ СОВЕРШАЕТ НИ ОДНОЙ СДЕЛКИ: ему нужен памп +10% за
// 20 минут, а лента — случайное блуждание с шагом ±0.2. Значит станок мерил ПЛОСКИЙ прогон, а
// плоскость решает, работает ли батч 17b (он включается лишь при отсутствии позиции, pending и
// оверлеев). Настоящая стратегия (`long-oi.bundle.json` — `long-dump-reversal-oi-liq-fsm`, та, что
// торгует на paper) держит позицию и проходит по дорогому пути.
const BUNDLE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'test/fixtures/overlay/bundles',
  process.env.PROFILE_BUNDLE ?? 'short-after-pump.bundle.json',
);

/**
 * Контрольный бандл: тот же путь исполнения, но БЕЗ единого обращения к `ctx.indicators`.
 *
 * Существует ради одного вопроса: `short-after-pump` спрашивает индикаторы каждый бар, а харнесс
 * пересоздаёт движок индикаторов на каждой регидрации (`rehydrate.mjs`), из-за чего холодное
 * состояние переигрывается от нулевого бара (`indicators/engine.ts`). Если этот бандл линеен там,
 * где `short-after-pump` квадратичен, причина доказана, а не выведена по совпадению.
 */
function minimalBundle(reference: InlineModuleBundle): InlineModuleBundle {
  return {
    ...reference,
    manifest: { ...reference.manifest, id: 'perf_idle_probe', version: '1.0.0', hooks: ['onBarClose'] },
    entry: 'module/index.js',
    files: { 'module/index.js': 'export default function () { return { onBarClose() { return { kind: "idle" }; } }; }\n' },
  } as InlineModuleBundle;
}

const referenceBundle = JSON.parse(readFileSync(BUNDLE_PATH, 'utf8')) as InlineModuleBundle;
const inlineBundle =
  BACKEND !== 'isolate'
    ? undefined
    : process.env.PROFILE_BUNDLE === 'minimal'
      ? minimalBundle(referenceBundle)
      : referenceBundle;

const spec: WorkloadSpec = {
  symbols: SYMBOLS,
  bars: BARS,
  seed: 12345,
  barMajor: BAR_MAJOR,
  marketKinds: MARKET_KINDS,
  ...(BATCH_BARS >= 2 ? { batchBars: BATCH_BARS } : {}),
  ...(TAPE_FILE !== undefined ? { tapeFile: TAPE_FILE } : {}),
  execProfile: EXEC_PROFILE,
  probe,
  ...(inlineBundle !== undefined
    ? { module: { id: inlineBundle.manifest.id, version: inlineBundle.manifest.version } }
    : {}),
};

console.log(
  `[profile-runner] backend=${BACKEND} bars=${BARS} symbols=${SYMBOLS.length} (${SYMBOLS.join(',')}) ` +
    `barMajor=${BAR_MAJOR} repeats=${REPEATS} ` +
    (BACKEND === 'isolate'
      ? `module=${spec.module!.id}@${spec.module!.version} batch=64 wallMsPerCall=${WALL_MS_PER_CALL}`
      : `probe=entry/${probe.entryEvery}+hold/${probe.holdBars}+lookback/${probe.lookback}`) +
    ` contextFreeze=${CONTEXT_FREEZE} marketKinds=${MARKET_KINDS} batchBars=${BATCH_BARS >= 2 ? BATCH_BARS : 'выкл'} поток=${THREAD} профили=${EXEC_PROFILE}` +
    ` cores=${cpus().length}`,
);

// Лента строится ОДИН раз и переиспользуется: её постройка (deep-freeze 60k баров) не относится к
// стоимости прогона, и попав в профиль, она исказила бы разбивку.
const t0 = process.hrtime.bigint();
let materialized: { readonly bundleDir: string; cleanup(): Promise<void> } | undefined;
let deps: RunDeps;
if (inlineBundle !== undefined) {
  materialized = await materializeBundle(inlineBundle);
  deps = makeIsolateDeps(spec, materialized.bundleDir, WALL_MS_PER_CALL);
} else {
  deps = makeTrustedDeps(spec);
}
const request = makeRequest(spec);
// Колонки для режима потока строятся ЗДЕСЬ, а не в `threadSpec()`.
//
// Раньше `threadSpec()` звался ВНУТРИ замеряемой области `runOnce`, и `buildRows(spec)` +
// `encodeTapeColumns` исполнялись на КАЖДОМ замерном проходе. Надпись «подготовка ленты — вне
// замера» была верна только для непоточного пути, а весь сегодняшний перф снимался как раз в
// потоке — то есть каждый проход нёс скрытую фиксированную добавку.
//
// Она же объясняла, почему цена бара падала с ростом их числа: фиксированное делилось на большее.
// Сравнения арм от этого не страдали (обе платили одинаково), но абсолютные числа были завышены и
// НЕ СОПОСТАВИМЫ между прогонами разной длины.
const threadColumns =
  THREAD && inlineBundle !== undefined
    ? encodeTapeColumns(datasetRefOf(spec), '1m', undefined, buildRows(spec))
    : undefined;

/** Одна точка замера: своя лента, свой запрос, свои колонки. Строится ВНЕ замеряемой области. */
interface Point {
  readonly request: typeof request;
  readonly deps: RunDeps;
  readonly columns: ReturnType<typeof encodeTapeColumns> | undefined;
  readonly bars: number;
}

function makePoint(bars: number): Point {
  const s = { ...spec, bars };
  return {
    request: makeRequest(s),
    // Длину прогона задаёт ДАТАСЕТ, а не период в запросе: с укороченным периодом, но полной лентой
    // раннер всё равно обрабатывает все бары (проверено — половинная точка давала те же 4000).
    deps: inlineBundle !== undefined ? makeIsolateDeps(s, materialized!.bundleDir, WALL_MS_PER_CALL) : makeTrustedDeps(s),
    columns: THREAD && inlineBundle !== undefined ? encodeTapeColumns(datasetRefOf(s), '1m', undefined, buildRows(s)) : undefined,
    bars,
  };
}

const fullPoint: Point = { request, deps, columns: threadColumns, bars: BARS };
const halfPoint: Point | undefined = TWO_POINT ? makePoint(Math.floor(BARS / 2)) : undefined;
const buildMs = Number(process.hrtime.bigint() - t0) / 1e6;
console.log(`  [подготовка ленты] ${buildMs.toFixed(0)} мс — вне замера${threadColumns !== undefined ? ' (включая колонки потока)' : ''}`);

interface Sample {
  readonly wallMs: number;
  readonly hash: string;
  readonly barsProcessed: number;
  readonly trades: number;
  readonly meaningfulDecisions: number;
  readonly riskDecisions: number;
}

/**
 * Спека прогона в ПОТОКЕ — та же, что строит воркер (`jobs/worker.ts`).
 *
 * Зачем режим вообще нужен. Станок гонял цикл на ГЛАВНОМ потоке, а там заход в изолят
 * асинхронный (`evalClosure`); в проде цикл живёт в worker_thread, где включается синхронный
 * (`evalClosureSync`) и снимается измеренный штраф ~150 мкс на пересечение (bt#191/196). На
 * профиле торгового пути это дало `evalHarness` 131 мкс/бар и `idle` 96 мкс/бар — две трети
 * видимого, и всё это конфигурация, которой в проде НЕТ. Пока станок не умеет так же, профиль
 * торгового пути нечитаем: любая доля считается от фантома.
 *
 * Через границу едут КОЛОНКИ, а не лента: structured clone переносит данные, но не методы.
 */
function threadSpec(p: Point): ThreadRunSpec {
  if (materialized === undefined) {
    throw new Error('режим потока требует бандла: задайте PROFILE_BACKEND=isolate');
  }
  if (p.columns === undefined) throw new Error('колонки потока не построены');
  const policy = { ...loadConfig().overlaySandbox.policy };
  const scaled = { ...policy, limits: { ...policy.limits, wallTimeMsPerCall: WALL_MS_PER_CALL } };
  return {
    request: p.request as unknown,
    bundleDir: materialized.bundleDir,
    router: { policy: scaled, sandboxDeps: {}, sandboxBackend: 'isolate' },
    dataPort: { kind: 'columns', columns: p.columns },
    flags: {
      contextFreeze: CONTEXT_FREEZE,
      ...(BATCH_BARS >= 2 ? { barBatching: { maxBars: BATCH_BARS } } : {}),
    },
  };
}

async function runOnce(p: Point = fullPoint): Promise<Sample> {
  const started = process.hrtime.bigint();
  const out = THREAD
    ? ((await runBacktestInThread(threadSpec(p))).result as RunOutcome)
    : await runBacktest(p.request, { ...p.deps, contextFreeze: CONTEXT_FREEZE });
  const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
  if (out.status !== 'completed') {
    throw new Error('прогон отклонён: ' + JSON.stringify(out.validation));
  }
  const evidence = out.baseline as unknown as { readonly evidence?: { readonly barsProcessed?: number } };
  // Сделки и бары-в-позиции печатаются НЕ для полноты отчёта. Без них станок молча меряет
  // стратегию, которая ничего не делает, и выдаёт это за замер торгового пути: `short_after_pump`
  // на синтетической ленте не входит в позицию ни разу, и это выяснилось только по метрикам
  // `pnl:0, win_rate:0` постфактум. Число сделок — самопроверка фикстуры, а не украшение.
  // ВНИМАНИЕ на источник: `BacktestRunResult` НЕ несёт `orders` и `riskDecisions` — они живут только
  // во внутренних аккумуляторах раннера. Первая редакция этих счётчиков читала их с результата и
  // всегда получала undefined → печатала `риска=0 ордеров=0` рядом с шестьюстами решениями и одной
  // сделкой. Противоречие бросилось в глаза, но могло и не броситься. Считаем по тому, что в
  // результате ЕСТЬ: вердикт риска приложен к каждой записи решения.
  const res = out.baseline as unknown as {
    readonly trades?: readonly unknown[];
    readonly decisionRecords?: readonly {
      readonly finalDecision?: { readonly kind?: string } | null;
      readonly riskDecision?: unknown;
    }[];
  };
  // `решений` и `риска` РАЗЛИЧАЮТ ПРИЧИНУ, когда сделок ноль: молчит стратегия (решений 0) или её
  // выходы отклоняет риск (решения есть, ордеров нет). Без этой пары «сделок=0» ничего не объясняет,
  // и приходится гадать — чем я уже занимался дважды за сессию.
  const meaningful = (res.decisionRecords ?? []).filter(
    (d) => d.finalDecision != null && d.finalDecision.kind !== undefined && d.finalDecision.kind !== 'idle',
  ).length;
  return {
    wallMs,
    hash: contentRef(out.baseline),
    barsProcessed: evidence.evidence?.barsProcessed ?? BARS * SYMBOLS.length,
    trades: res.trades?.length ?? 0,
    meaningfulDecisions: meaningful,
    riskDecisions: (res.decisionRecords ?? []).filter((d) => d.riskDecision != null).length,
  };
}

const samples: Sample[] = [];
const halfSamples: Sample[] = [];
try {
  // Прогрев отбрасывается: первый прогон несёт JIT-разогрев и холодные кэши.
  const warm = await runOnce();
  console.log(`  [прогрев] ${warm.wallMs.toFixed(0)} мс — отброшен`);

  for (let i = 0; i < REPEATS; i += 1) {
    const s = await runOnce();
    samples.push(s);
    console.log(
      `  #${i + 1}: ${s.wallMs.toFixed(0)} мс  ${((s.wallMs * 1000) / s.barsProcessed).toFixed(1)} мкс/бар  ` +
        `баров=${s.barsProcessed}  решений=${s.meaningfulDecisions}  риска=${s.riskDecisions}  ` +
        `сделок=${s.trades}  hash=${s.hash.slice(7, 19)}…`,
    );
  }
  if (TWO_POINT) {
    // Половинный прогон ПОСЛЕ полного — намеренно: JIT уже прогрет, и разность несёт цену баров,
    // а не разогрева. Повторов столько же, минимум берётся так же.
    for (let i = 0; i < REPEATS; i += 1) {
      const s = await runOnce(halfPoint!);
      halfSamples.push(s);
      console.log(
        `  ½#${i + 1}: ${s.wallMs.toFixed(0)} мс  баров=${s.barsProcessed}  hash=${s.hash.slice(7, 19)}…`,
      );
    }
  }
} finally {
  // Изолят держит живые сессии до `closeAll` — без него процесс не завершится.
  deps.router?.closeAll();
  if (materialized !== undefined) await materialized.cleanup();
}

const walls = samples.map((s) => s.wallMs).sort((a, b) => a - b);
// Минимум, а не медиана и не среднее: см. `lib/bench-gate.ts` — GC-паузы ложатся случайно.
assertStableSamples('profile-runner', walls);
const best = minOf(walls);
const bars = samples[0]!.barsProcessed;

// Нестабильность результата между повторами ломает основание сравнения так же, как и ошибка замера.
const distinct = new Set(samples.map((s) => s.hash));
if (distinct.size > 1) {
  console.error(`\nЗАМЕР НЕДЕЙСТВИТЕЛЕН: result_hash различается между повторами (${distinct.size} различных) — прогон недетерминирован.`);
  process.exitCode = 2;
}

console.log(
  `\n[profile-runner] min ${best.toFixed(0)} мс на ${bars} баров = ` +
    `${((best * 1000) / bars).toFixed(1)} мкс/бар (max ${walls[walls.length - 1]!.toFixed(0)} мс из ${walls.length} повторов)`,
);
console.log(`[profile-runner] result_hash=${samples[0]!.hash}`);

if (TWO_POINT && halfSamples.length > 0) {
  const halfWalls = halfSamples.map((s) => s.wallMs).sort((a, b) => a - b);
  assertStableSamples('profile-runner ½', halfWalls);
  const halfBest = minOf(halfWalls);
  // Длины берутся из ПОСТРОЕННЫХ лент, а не из `evidence.barsProcessed`: последнее в обеих точках
  // возвращает одно и то же число (проверено отладкой — лента 4000 свечей, а отчёт говорит 8000),
  // то есть на роль длины прогона не годится. Длина ленты известна нам достоверно: мы её и строили.
  const halfBars = halfPoint!.bars;
  const fullBars = fullPoint.bars;
  const deltaBars = fullBars - halfBars;
  if (deltaBars <= 0) throw new Error(`двухточечный режим: половинный прогон не короче полного (${halfBars} против ${bars})`);
  const marginalUs = ((best - halfBest) * 1000) / deltaBars;
  const fixedMs = best - (marginalUs * fullBars) / 1000;
  console.log(
    `[profile-runner] две точки: ${halfBars}→${bars} баров, ${halfBest.toFixed(0)}→${best.toFixed(0)} мс\n` +
      `[profile-runner] ПРЕДЕЛЬНАЯ цена бара = ${marginalUs.toFixed(1)} мкс  (фиксированная часть прогона ${fixedMs.toFixed(0)} мс` +
      `, то есть ${((fixedMs * 1000) / bars).toFixed(1)} мкс/бар при ${bars} барах)`,
  );
  // Предельная цена не может быть отрицательной: это признак того, что прогоны несопоставимы
  // (разная торговая активность на половине ленты, шум больше эффекта) — молчать тут нельзя.
  if (marginalUs <= 0) {
    console.error('\nДВЕ ТОЧКИ НЕДЕЙСТВИТЕЛЬНЫ: предельная цена ≤ 0 — половинный прогон не быстрее полного.');
    process.exitCode = 2;
  } else if (fixedMs < 0) {
    // Отрицательная фиксированная часть означает, что полный прогон дороже удвоенного половинного.
    // Это либо СВЕРХЛИНЕЙНОСТЬ (что само по себе находка и требует разбора), либо шум машины —
    // и одно от другого отличается повтором, а не рассуждением. Молчать нельзя: без этой строки
    // число уедет в отчёт как «предельная цена», хотя модель «фиксированное + линейное» не описывает
    // данные вовсе.
    console.error(
      `\nДВЕ ТОЧКИ ПОДОЗРИТЕЛЬНЫ: фиксированная часть отрицательна (${fixedMs.toFixed(0)} мс) — полный прогон` +
        ' дороже удвоенного половинного. Либо сверхлинейность, либо стенд шумит; повторить на тихой машине.',
    );
    process.exitCode = 2;
  }
}
