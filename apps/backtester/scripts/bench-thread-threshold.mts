// ТОЧКА ОКУПАЕМОСТИ ПОТОКА: с какого размера прогона вынос барного цикла перестаёт быть убытком.
//
// Зачем. Флаг `BACKTESTER_BAR_LOOP_THREAD` сегодня включает путь потока БЕЗУСЛОВНО, а у потока есть
// постоянная цена входа: он поднимается и импортирует весь свой граф модулей под загрузчиком
// TypeScript. На длинном прогоне она теряется в шуме, на прогоне в тридцать баров — превышает всю
// экономию. Значит нужен порог, и взять его надо из замера, а не назначить.
//
// МЕТОД. Не подбор («попробуем 500, потом 1000»), а НАКЛОН по двум длинам:
//
//   wall(N) = fixed + N × perBar
//
// Две длины дают `perBar` и `fixed` для каждого пути. Точка окупаемости тогда считается, а не
// угадывается:
//
//   N* = (fixedПоток − fixedГлавный) / (perBarГлавный − perBarПоток)
//
// И — обязательно — САМОПРОВЕРКА: посчитанное N* проверяется прямым замером в этой точке. Если
// модель верна, пути там сходятся; если разошлись, значит зависимость не линейна и число
// публиковать нельзя. Отдельная проверка на структурно невозможное: отрицательный наклон или
// отрицательная постоянная — отказ с ненулевым кодом, а не строка в отчёте.
//
// ЧЕРЕДОВАНИЕ, а не фазы. Замеры идут round-robin по всем парам (длина, путь). Фазовый порядок уже
// однажды дал ×11, которого нет: долгая фаза занимала оба закреплённых ядра, фоновый оптимизатор V8
// не успевал, и следующая фаза весь прогон шла неоптимизированной (отозвано в bt#195).
//
//   pnpm exec tsx apps/backtester/scripts/bench-thread-threshold.mts
//   BTT_TILES=1,8,32 BTT_REPEATS=5 pnpm exec tsx apps/backtester/scripts/bench-thread-threshold.mts

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertQuietBench, assertStableSamples, minOf } from './lib/bench-gate.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, '..');

const TILE_SIZES = (process.env.BTT_TILES ?? '2,64')
  .split(',')
  .map((s) => Math.max(1, Number(s.trim())))
  .filter((n) => Number.isFinite(n))
  .sort((a, b) => a - b);
if (TILE_SIZES.length < 2) throw new Error('BTT_TILES: нужны минимум две длины — наклон по одной точке не считается');
const REPEATS = Math.max(3, Number(process.env.BTT_REPEATS ?? 4));

const REQUEST_PATH = resolve(APP_DIR, 'test/fixtures/overlay/requests/universe-multi.json');
const BUNDLE_PATH = resolve(APP_DIR, 'test/fixtures/overlay/bundles/short-after-pump.bundle.json');
const SOURCE_DATASET = resolve(APP_DIR, 'fixtures/candles/universe-fixture-1m.json');

assertQuietBench('bench-thread-threshold');

const [
  { runStrategyBacktest },
  { buildOverlayDatasetWithColumns },
  { FixtureDataPort },
  { strategyBundleRegistry },
  { materializeReadableBundle },
  { threadRouterSpec },
  { createOverlayRouter },
  { runBacktestInThread },
  { resultHash },
  { loadBundle },
] = await Promise.all([
  import('../src/engine/run-strategy.js'),
  import('../src/engine/data-adapter.js'),
  import('../src/data/reader.js'),
  import('../src/engine/trusted-registry.js'),
  import('../test/helpers-overlay-sandbox.js'),
  import('../test/helpers-thread-spec.js'),
  import('../src/engine/sandbox/overlay-router-spec.js'),
  import('../src/engine/thread/run-in-thread.js'),
  import('../test/helpers/bar-major-fixture.js'),
  import('../src/engine/sandbox/bundle.js'),
]);

// --- Размноженная лента ---------------------------------------------------------------------------

interface Row { symbol: string; minute_ts: number; [k: string]: unknown }

const source = JSON.parse(readFileSync(SOURCE_DATASET, 'utf8')) as {
  datasetRef: string;
  timeframe: string;
  rows: Row[];
};
const stamps = [...new Set(source.rows.map((r) => r.minute_ts))].sort((a, b) => a - b);
const BAR_MS = stamps.length >= 2 ? stamps[1]! - stamps[0]! : 60_000;
const WINDOW_MS = stamps.length * BAR_MS;

const baseRequest = JSON.parse(readFileSync(REQUEST_PATH, 'utf8')) as {
  symbols: string[];
  timeframe: string;
  datasetRef: string;
  period: { from: string; to: string };
};
const SYMBOLS = baseRequest.symbols.length;
const bundle = JSON.parse(readFileSync(BUNDLE_PATH, 'utf8'));

interface Tiled {
  readonly fixturesDir: string;
  readonly request: typeof baseRequest & { engine: 'strategy' };
  readonly bars: number;
}

/** Тайл — сдвиг `minute_ts` на целое число окон: форма свечей не меняется, паттерн повторяется. */
function buildTiled(tiles: number): Tiled {
  const rows: Row[] = [];
  for (let k = 0; k < tiles; k += 1) {
    for (const r of source.rows) rows.push({ ...r, minute_ts: r.minute_ts + k * WINDOW_MS });
  }
  const dir = mkdtempSync(join(tmpdir(), `btt-${tiles}x-`));
  const datasetRef = `btt-tiled-${tiles}x-1m`;
  writeFileSync(join(dir, `${datasetRef}.json`), JSON.stringify({ datasetRef, timeframe: source.timeframe, rows }));
  return {
    fixturesDir: dir,
    request: {
      ...baseRequest,
      datasetRef,
      period: { from: new Date(stamps[0]!).toISOString(), to: new Date(stamps[0]! + WINDOW_MS * tiles).toISOString() },
      engine: 'strategy',
    },
    bars: stamps.length * tiles * SYMBOLS,
  };
}

// --- Прогон одним из двух путей -------------------------------------------------------------------

type Path = 'main' | 'thread';

const sp = await materializeReadableBundle(bundle);
// Бандл читается с диска ровно так же, как это делает `sandboxBundleFor` в проде.
const loadedBundle = loadBundle(sp.bundleDir);

/**
 * Материализация кэшируется НА ТАЙЛ и переиспользуется обоими путями и всеми повторами.
 *
 * Иначе в замер попала бы постройка ленты — она общая для обоих путей и в проде считается один раз
 * до выбора пути (`materializeFor`), то есть к разнице путей отношения не имеет. Мерить её здесь
 * значило бы разбавлять обе стороны одинаковой константой и занижать различие.
 */
const materialized = new Map<number, Awaited<ReturnType<typeof buildOverlayDatasetWithColumns>>>();

async function materializeFor(t: Tiled): Promise<Awaited<ReturnType<typeof buildOverlayDatasetWithColumns>>> {
  const hit = materialized.get(t.bars);
  if (hit) return hit;
  const m = await buildOverlayDatasetWithColumns(new FixtureDataPort(t.fixturesDir), {
    datasetRef: t.request.datasetRef,
    symbols: t.request.symbols,
    timeframe: t.request.timeframe,
    period: t.request.period,
  });
  materialized.set(t.bars, m);
  return m;
}

async function runOnce(path: Path, t: Tiled): Promise<{ wallMs: number; hash: string }> {
  const m = await materializeFor(t);
  if (path === 'thread') {
    const t0 = process.hrtime.bigint();
    const out = await runBacktestInThread({
      request: t.request,
      bundleDir: sp.bundleDir,
      router: threadRouterSpec('isolate'),
      dataPort: { kind: 'columns', columns: m.columns! },
    });
    const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
    if (out.sandboxErrors.length > 0) throw new Error(`ошибки песочницы (поток): ${JSON.stringify(out.sandboxErrors).slice(0, 400)}`);
    return { wallMs, hash: resultHash(out.result as never) };
  }
  const registry = strategyBundleRegistry(loadedBundle);
  const router = createOverlayRouter(threadRouterSpec('isolate'));
  try {
    const t0 = process.hrtime.bigint();
    const out = await runStrategyBacktest(t.request as never, { registry, marketTape: m.tape, router } as never);
    const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const errs = router.errors();
    if (errs.length > 0) throw new Error(`ошибки песочницы (главный): ${JSON.stringify(errs).slice(0, 400)}`);
    return { wallMs, hash: resultHash(out) };
  } finally {
    router.closeAll();
  }
}

// --- Замер: чередование по всем парам (длина, путь) -----------------------------------------------

const built = TILE_SIZES.map(buildTiled);
const PATHS: readonly Path[] = ['main', 'thread'];

console.log(
  `\n[bench-thread-threshold] длины=${built.map((t) => t.bars).join('/')} бар-вычислений, ` +
    `повторов=${REPEATS} (+1 прогрев), символов=${SYMBOLS}\n`,
);

const walls = new Map<string, number[]>();
const hashes = new Map<number, Set<string>>();
const key = (p: Path, bars: number): string => `${p}@${bars}`;

for (let rep = 0; rep <= REPEATS; rep += 1) {
  for (const t of built) {
    for (const p of PATHS) {
      const { wallMs, hash } = await runOnce(p, t);
      if (rep === 0) continue; // прогрев не учитывается
      (walls.get(key(p, t.bars)) ?? walls.set(key(p, t.bars), []).get(key(p, t.bars))!).push(wallMs);
      (hashes.get(t.bars) ?? hashes.set(t.bars, new Set()).get(t.bars)!).add(hash);
    }
  }
}

// Паритет — предусловие замера, а не побочный результат: сравнивать скорость путей, дающих разные
// числа, бессмысленно.
for (const [bars, set] of hashes) {
  if (set.size !== 1) {
    console.error(`\n✗ ОТКАЗ: на ${bars} бар-вычислениях пути дали РАЗНЫЕ result_hash: ${[...set].join(' / ')}`);
    process.exit(5);
  }
}

const short = built[0]!.bars;
const long = built[built.length - 1]!.bars;

interface Fit { readonly perBarUs: number; readonly fixedMs: number }

function fit(p: Path): Fit {
  const s = walls.get(key(p, short))!;
  const l = walls.get(key(p, long))!;
  assertStableSamples(`${p}@${short}`, s);
  assertStableSamples(`${p}@${long}`, l);
  const w1 = minOf(s);
  const w2 = minOf(l);
  const perBarUs = ((w2 - w1) * 1000) / (long - short);
  const fixedMs = w1 - (perBarUs * short) / 1000;
  if (!(perBarUs > 0)) {
    console.error(`\n✗ ОТКАЗ: путь «${p}» дал наклон ${perBarUs.toFixed(1)} мкс/бар — длинный прогон не может быть быстрее короткого.`);
    process.exit(4);
  }
  return { perBarUs, fixedMs };
}

const main = fit('main');
const thread = fit('thread');

console.log('  ЗАМЕР (минимум из повторов)\n');
console.log('    бар-вычислений │   главный поток │   отдельный поток');
console.log('   ────────────────┼─────────────────┼──────────────────');
for (const t of built) {
  const m = minOf(walls.get(key('main', t.bars))!);
  const th = minOf(walls.get(key('thread', t.bars))!);
  console.log(`   ${String(t.bars).padStart(15)} │ ${m.toFixed(0).padStart(12)} мс │ ${th.toFixed(0).padStart(13)} мс`);
}

console.log('\n  РАЗЛОЖЕНИЕ (wall = постоянная + N × пербарная)\n');
console.log(`    главный поток:   ${main.perBarUs.toFixed(1)} мкс/бар, постоянная ${main.fixedMs.toFixed(0)} мс`);
console.log(`    отдельный поток: ${thread.perBarUs.toFixed(1)} мкс/бар, постоянная ${thread.fixedMs.toFixed(0)} мс`);

const gainUs = main.perBarUs - thread.perBarUs;
const extraFixedMs = thread.fixedMs - main.fixedMs;

if (!(gainUs > 0)) {
  console.error(`\n✗ ОТКАЗ: поток не быстрее на бар (${gainUs.toFixed(1)} мкс/бар). Порог не имеет смысла — путь потока не окупается никогда.`);
  process.exit(4);
}
if (!(extraFixedMs > 0)) {
  console.log(`\n  Постоянная цена потока не положительна (${extraFixedMs.toFixed(0)} мс) — окупается с первого бара, порог не нужен.`);
  process.exit(0);
}

const breakEven = Math.ceil((extraFixedMs * 1000) / gainUs);
console.log(`\n  ЦЕНА ВХОДА ПОТОКА: ${extraFixedMs.toFixed(0)} мс   ВЫИГРЫШ: ${gainUs.toFixed(1)} мкс/бар`);
console.log(`  ТОЧКА ОКУПАЕМОСТИ: ${breakEven.toLocaleString('ru')} бар-вычислений\n`);

// --- Самопроверка: замер В посчитанной точке ------------------------------------------------------
//
// Модель линейна по предположению. Если она верна, в точке окупаемости пути обязаны сойтись.
// Расхождение означает, что зависимость не линейна и число публиковать нельзя.

const checkTiles = Math.max(1, Math.round(breakEven / (stamps.length * SYMBOLS)));
const check = buildTiled(checkTiles);
built.push(check);
const checkWalls: Record<Path, number[]> = { main: [], thread: [] };
for (let rep = 0; rep <= REPEATS; rep += 1) {
  for (const p of PATHS) {
    const { wallMs } = await runOnce(p, check);
    if (rep > 0) checkWalls[p].push(wallMs);
  }
}
const cm = minOf(checkWalls.main);
const ct = minOf(checkWalls.thread);
const ratio = Math.max(cm, ct) / Math.min(cm, ct);
console.log(`  САМОПРОВЕРКА в точке ${check.bars.toLocaleString('ru')} бар-вычислений: главный ${cm.toFixed(0)} мс, поток ${ct.toFixed(0)} мс (×${ratio.toFixed(2)})`);
// Допуск узкий ОСОЗНАННО. В точке окупаемости пути по определению равны, значит отношение обязано
// быть около единицы — это прямая проверка модели, а не «похоже на правду». Первая редакция станка
// стояла на допуске 1.25 и пропустила расхождение 1.20, при котором поток был уже заметно быстрее:
// то есть настоящая точка лежала левее расчётной, а станок этого не заметил. Широкий допуск здесь
// проверяет не линейность, а лишь то, что числа одного порядка.
if (ratio > 1.1) {
  console.error(
    `\n✗ ОТКАЗ: в расчётной точке окупаемости пути разошлись в ${ratio.toFixed(2)} раза при допуске 1.10.\n` +
      `  В точке окупаемости они обязаны совпасть. ${cm < ct ? 'Быстрее главный' : 'Быстрее поток'} — значит настоящая\n` +
      `  точка ${cm < ct ? 'ПРАВЕЕ' : 'ЛЕВЕЕ'} расчётной, и наклон снят на длинах, которые её не охватывают.\n` +
      '  Возьмите длины по обе стороны от предполагаемого пересечения (BTT_TILES).\n',
  );
  for (const t of built) rmSync(t.fixturesDir, { recursive: true, force: true });
  process.exit(4);
}
console.log('  ✓ модель линейна — порог достоверен\n');

for (const t of built) rmSync(t.fixturesDir, { recursive: true, force: true });
