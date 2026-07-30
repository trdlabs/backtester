// I1 — ГЕЙТ ПАРИТЕТА БЭКЕНДОВ: docker против isolate на ОДНОМ прогоне.
//
// Зачем именно этот шаг и именно первым. Изолятный бэкенд (`analysis/18` вариант A) написан,
// покрыт юнитами и живёт за `BACKTESTER_SANDBOX_BACKEND=isolate`, но по умолчанию прод по-прежнему
// ходит в docker — контейнер на сессию, round-trip на бар. Прежде чем что-либо решать про смену
// бэкенда исполнения НЕДОВЕРЕННОГО кода, надо доказать две вещи, и обе — измерением:
//
//   1) СМЕНА БЭКЕНДА НЕ ДВИГАЕТ НИ ОДНОГО ЧИСЛА. `result_hash` обоих прогонов обязан совпасть
//      побитово. Если не совпал — бэкенды считают по-разному, и это дефект, а не «другой режим».
//   2) СКОЛЬКО ЭТО НА САМОМ ДЕЛЕ СТОИТ. Микростанок границы (`profile-isolate-boundary.mts`)
//      меряет конверт в отрыве от прогона; здесь — сквозной wall-time настоящего бэктеста.
//
// Почему лента размножается. Штатная фикстура `universe-fixture-1m` — 30 баров на символ. На таком
// окне стоимость старта контейнера и стоимость баров одного порядка, и «мкс/бар» из такого замера
// был бы величиной про docker-старт, а не про транспорт. Поэтому лента тиражируется по времени:
// тот же паттерн пампа повторяется K раз со сдвигом на длину окна. Это сохраняет точки срабатывания
// стратегии относительно каждого тайла и даёт длину, на которой пербарная цена доминирует.
// Побочно это УСИЛИВАЕТ гейт паритета: чем больше баров, тем больше поводов разойтись.
//
// Почему двух длин, а не одной. Смоук на 180 барах дал у изолята 3849 мкс/бар — при том, что
// микростанок границы меряет конверт в 144 мкс. Разница вся сидит в ПОСТОЯННОЙ части прогона
// (старт контейнера / открытие изолята, компиляция бандла, материализация ленты), и деление
// полного wall на число баров её просто размазывает по барам. Поэтому станок гоняет матрицу на
// ДВУХ длинах и считает наклон: wall(N) = fixed + N × perBar. Наклон — цена бара, свободный член —
// цена входа. Одно число вместо двух здесь врало бы в разы.
//
//   BSB_TILES=4,20 BSB_REPEATS=3 pnpm exec tsx apps/backtester/scripts/bench-sandbox-backend.mts
//
// Требует Docker (иначе половина матрицы невозможна) и собранного isolate-харнесса
// (`pnpm run build:isolate-harness`). Не CI-ассерт: печатает таблицу и вердикт паритета.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, '..');

const TILE_SIZES = (process.env.BSB_TILES ?? '4,20')
  .split(',')
  .map((s) => Math.max(1, Number(s.trim())))
  .filter((n) => Number.isFinite(n))
  .sort((a, b) => a - b);
if (TILE_SIZES.length < 2) throw new Error('BSB_TILES: нужны минимум две длины — наклон по одной точке не считается');
const REPEATS = Math.max(1, Number(process.env.BSB_REPEATS ?? 3));
const REQUEST_PATH = resolve(APP_DIR, 'test/fixtures/overlay/requests/universe-multi.json');
const BUNDLE_PATH = resolve(APP_DIR, 'test/fixtures/overlay/bundles/short-after-pump.bundle.json');
const SOURCE_DATASET = resolve(APP_DIR, 'fixtures/candles/universe-fixture-1m.json');

const [
  { runBacktest },
  { buildOverlayDataset },
  { FixtureDataPort },
  { buildSandboxStrategyBaselineDeps, buildTrustedStrategyBaselineDeps, materializeReadableBundle },
  { resultHash },
  { runBacktestInThread },
  { threadRouterSpec },
] = await Promise.all([
  import('../src/engine/runner.js'),
  import('../src/engine/data-adapter.js'),
  import('../src/data/reader.js'),
  import('../test/helpers-overlay-sandbox.js'),
  import('../test/helpers/bar-major-fixture.js'),
  import('../src/engine/thread/run-in-thread.js'),
  import('../test/helpers-thread-spec.js'),
]);


// --- Размноженная лента ---------------------------------------------------------------------------

interface Row {
  symbol: string;
  minute_ts: number;
  [k: string]: unknown;
}

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
  readonly request: typeof baseRequest;
  readonly bars: number;
}

/**
 * Тайлы строятся сдвигом `minute_ts` на целое число окон — форма свечей не трогается, поэтому
 * стратегия видит ровно тот же паттерн, только K раз подряд. Никакой генерации «похожих» данных:
 * любое отличие формы сделало бы длины несравнимыми между собой.
 */
function buildTiled(tiles: number): Tiled {
  const rows: Row[] = [];
  for (let k = 0; k < tiles; k += 1) {
    for (const r of source.rows) rows.push({ ...r, minute_ts: r.minute_ts + k * WINDOW_MS });
  }
  const dir = mkdtempSync(join(tmpdir(), `bsb-${tiles}x-`));
  const datasetRef = `bsb-tiled-${tiles}x-1m`;
  writeFileSync(join(dir, `${datasetRef}.json`), JSON.stringify({ datasetRef, timeframe: source.timeframe, rows }));
  return {
    fixturesDir: dir,
    request: {
      ...baseRequest,
      datasetRef,
      period: {
        from: new Date(stamps[0]!).toISOString(),
        to: new Date(stamps[0]! + WINDOW_MS * tiles).toISOString(),
      },
    },
    bars: stamps.length * tiles * SYMBOLS,
  };
}

console.log(
  `[bench-sandbox-backend] длины=${TILE_SIZES.join('/')} тайлов, повторов=${REPEATS} (+1 прогрев), ` +
    `символов=${SYMBOLS}, бар-вычислений=${TILE_SIZES.map((t) => stamps.length * t * SYMBOLS).join('/')}`,
);

// --- Прогон ---------------------------------------------------------------------------------------

// `trusted` — доверенный двойник БЕЗ песочницы: та же стратегия in-process. Он не кандидат в прод
// (недоверенный код обязан жить в песочнице), он опорная точка: разность trusted↔isolate и есть
// цена песочницы, а без неё «мкс/бар изолята» неразложимо.
// `isolate-thread` — тот же изолятный бэкенд, но барный цикл целиком уехал в worker_thread. Его
// присутствие в матрице отвечает на единственный вопрос, который перенос обязан пройти прежде
// всего: НЕ ДВИГАЕТ ЛИ ОН РЕЗУЛЬТАТ. Тайминг у него читается с поправкой — поток строит ленту
// заново (через границу едет рецепт, а не данные), и эта постройка ложится в цену входа.
type Backend = 'docker' | 'isolate' | 'trusted' | 'isolate-thread';
const BACKENDS: readonly Backend[] = ['docker', 'isolate', 'trusted', 'isolate-thread'];

const sp = await materializeReadableBundle(bundle);
/** wall-замеры: бэкенд → длина (в барах) → повторы. */
const walls = new Map<Backend, Map<number, number[]>>(BACKENDS.map((b) => [b, new Map()]));
const hashes = new Map<number, Set<string>>();

async function runOnce(backend: Backend, tiled: Tiled, marketTape: unknown): Promise<{ wallMs: number; hash: string }> {
  if (backend === 'isolate-thread') {
    const t0 = process.hrtime.bigint();
    const out = await runBacktestInThread({
      request: tiled.request,
      bundleDir: sp.bundleDir,
      // Описание роутера строится ТЕМ ЖЕ помощником, что и в тестах: одна форма на все зовущие
      // стороны, иначе станок снова начнёт мерить конфигурацию, которой в проде не бывает.
      router: threadRouterSpec('isolate'),
      dataPort: { kind: 'fixture', dir: tiled.fixturesDir },
      dataset: {
        datasetRef: tiled.request.datasetRef,
        symbols: tiled.request.symbols,
        timeframe: tiled.request.timeframe,
        period: tiled.request.period,
      },
    });
    const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
    if (out.sandboxErrors.length > 0) {
      throw new Error(`sandbox errors (thread): ${JSON.stringify(out.sandboxErrors).slice(0, 600)}`);
    }
    return { wallMs, hash: resultHash(out.result as never) };
  }
  const { registry, router } =
    backend === 'trusted'
      ? buildTrustedStrategyBaselineDeps()
      : buildSandboxStrategyBaselineDeps({ spDir: sp.bundleDir, sandboxBackend: backend });
  try {
    const t0 = process.hrtime.bigint();
    // Запрос читается из фикстуры целиком; локальный тип покрывает только поля, которые станок
    // подменяет (datasetRef/period) — остальные едут как есть, поэтому приведение на границе.
    const out = await runBacktest(tiled.request as never, { registry, router, marketTape } as never);
    const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const errors = router.errors();
    if (errors.length > 0) throw new Error(`sandbox errors (${backend}): ${JSON.stringify(errors).slice(0, 600)}`);
    return { wallMs, hash: resultHash(out) };
  } finally {
    router.closeAll();
  }
}

const built: Tiled[] = [];
try {
  for (const tiles of TILE_SIZES) {
    const tiled = buildTiled(tiles);
    built.push(tiled);
    hashes.set(tiled.bars, new Set());

    // Лента строится ОДИН раз на длину: оба бэкенда обязаны получить один и тот же вход, иначе
    // сравнение хэшей ничего не доказывает.
    const marketTape = await buildOverlayDataset(new FixtureDataPort(tiled.fixturesDir), {
      datasetRef: tiled.request.datasetRef,
      symbols: tiled.request.symbols,
      timeframe: tiled.request.timeframe,
      period: tiled.request.period,
    });

    // Прогрев отбрасывается: первый прогон поглощает холодную стоимость (слои docker, page cache,
    // JIT), и без него первый бэкенд в порядке обхода выглядел бы хуже просто потому, что первый.
    const warm = await runOnce(BACKENDS[0]!, tiled, marketTape);
    console.log(`  [прогрев ${BACKENDS[0]} ${tiled.bars} бар] ${warm.wallMs.toFixed(0)} мс — отброшен`);

    // Round-robin: внешний цикл — повтор, внутренний — бэкенд. Дрейф машины ложится на оба поровну.
    for (let i = 0; i < REPEATS; i += 1) {
      for (const backend of BACKENDS) {
        const s = await runOnce(backend, tiled, marketTape);
        const perBackend = walls.get(backend)!;
        if (!perBackend.has(tiled.bars)) perBackend.set(tiled.bars, []);
        perBackend.get(tiled.bars)!.push(s.wallMs);
        hashes.get(tiled.bars)!.add(s.hash);
        console.log(
          `  ${backend.padEnd(7)} ${String(tiled.bars).padStart(5)} бар #${i + 1}: ` +
            `${s.wallMs.toFixed(0).padStart(7)} мс   hash=${s.hash.slice(7, 19)}…`,
        );
      }
    }
  }
} finally {
  await sp.cleanup();
  for (const t of built) rmSync(t.fixturesDir, { recursive: true, force: true });
}

// --- Вердикт --------------------------------------------------------------------------------------

const minOf = (xs: readonly number[]): number => xs.reduce((a, b) => (b < a ? b : a), Infinity);

const short = Math.min(...TILE_SIZES.map((t) => stamps.length * t * SYMBOLS));
const long = Math.max(...TILE_SIZES.map((t) => stamps.length * t * SYMBOLS));

console.log('\n  бэкенд     wall(коротк.)   wall(длин.)   мкс/бар (наклон)   вход, мс (св. член)');
console.log('  ────────────────────────────────────────────────────────────────────────────────');
const perBar = new Map<Backend, number>();
for (const b of BACKENDS) {
  const w1 = minOf(walls.get(b)!.get(short)!);
  const w2 = minOf(walls.get(b)!.get(long)!);
  // wall(N) = fixed + N × perBar → наклон по двум точкам. Минимум из повторов на каждой длине:
  // станки много аллоцируют, GC ложится случайно, и среднее задрало бы обе точки по-разному.
  const usPerBar = ((w2 - w1) * 1000) / (long - short);
  const fixedMs = w1 - (usPerBar * short) / 1000;
  perBar.set(b, usPerBar);
  console.log(
    `  ${b.padEnd(9)} ${w1.toFixed(0).padStart(10)} мс ${w2.toFixed(0).padStart(11)} мс ` +
      `${usPerBar.toFixed(1).padStart(15)} ${fixedMs.toFixed(0).padStart(19)}`,
  );
}

// Паритет — главное, что доказывает станок. Все хэши всех повторов обоих бэкендов на одной длине
// обязаны совпасть: один и тот же вход через два исполнителя обязан дать один и тот же результат,
// иначе смена бэкенда меняет ответы и принимать её нельзя ни при какой скорости.
let parityOk = true;
for (const [bars, set] of hashes) {
  if (set.size !== 1) {
    parityOk = false;
    console.error(`\n  ПАРИТЕТ (${bars} бар): ✗ РАЗОШЛИСЬ — ${set.size} различных result_hash:`);
    for (const h of set) console.error(`    ${h}`);
  }
}

// Отказ по НЕВОЗМОЖНОМУ НАКЛОНУ. Отрицательная цена бара означает, что длинный прогон оказался
// быстрее короткого, то есть пербарная работа целиком утонула в постоянной части и наклон меряет
// шум. Смоук на 180/360 барах дал изоляту −144.6 мкс/бар ровно так. Печатать такое число нельзя:
// задним числом оно неотличимо от настоящего. Лечится длиной, а не терпимостью.
const impossible = [...perBar.entries()].filter(([, us]) => us <= 0);

console.log('');
if (impossible.length > 0) {
  console.error('  ЗАМЕР ОТКЛОНЁН — невозможный наклон (длинный прогон быстрее короткого):');
  for (const [b, us] of impossible) console.error(`    ${b}: ${us.toFixed(1)} мкс/бар`);
  console.error('\n  Пербарная цена утонула в постоянной части прогона. Увеличьте BSB_TILES так,');
  console.error('  чтобы барная работа заметно превышала цену входа, и повторите.');
  if (parityOk) console.error('  (паритет при этом пройден — недействительны только тайминги)');
  process.exitCode = 4;
} else if (parityOk) {
  const d = perBar.get('docker')!;
  const i = perBar.get('isolate')!;
  const t = perBar.get('trusted')!;
  console.log('  ПАРИТЕТ: ✓ на каждой длине один result_hash на всех бэкендах');
  console.log(`  СКОРОСТЬ: docker ${d.toFixed(1)} → isolate ${i.toFixed(1)} мкс/бар  = ×${(d / i).toFixed(1)}`);
  const th = perBar.get('isolate-thread')!;
  console.log(`            docker ${d.toFixed(1)} → isolate-thread ${th.toFixed(1)} мкс/бар  = ×${(d / th).toFixed(1)}`);
  console.log('');
  // Разложение считается ТОЛЬКО вычитанием доверенной опорной точки. Прежняя редакция вычитала
  // сюда же константу «конверт границы ~144.5 мкс» из bt#191 и приписывала остаток харнессу —
  // атрибуция оказалась неверной (bt#196: харнесс стоит единицы микросекунд), поэтому константы
  // здесь больше нет. Станок печатает то, что померил, и не делит это по догадке.
  console.log('  ЦЕНА ПЕСОЧНИЦЫ (сверх доверенного пути):');
  console.log(`    доверенный путь — контекст, движок, стратегия      ${t.toFixed(1).padStart(7)} мкс`);
  console.log(`    изолят в главном потоке, асинхронно                ${(i - t).toFixed(1).padStart(7)} мкс сверху`);
  console.log(`    изолят в отдельном потоке, синхронно               ${(th - t).toFixed(1).padStart(7)} мкс сверху  (×${((i - t) / (th - t)).toFixed(1)} дешевле)`);
} else {
  console.error('  Смена бэкенда меняет результат прогона. Это дефект исполнителя, а не «другой режим»;');
  console.error('  до выяснения причины изолятный бэкенд включать нельзя.');
  process.exitCode = 1;
}
