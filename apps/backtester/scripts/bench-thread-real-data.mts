// ЗАМЕР ПУТИ ПОТОКА НА РЕАЛЬНЫХ ДАННЫХ — через настоящую очередь, а не мимо неё.
//
// Зачем понадобился отдельный станок. Все числа серии bt#191–206 сняты на фикстуре в 90 строк,
// размноженной тайлами, и у этой фикстуры НЕТ ни одного необязательного вида: ни oi, ни funding, ни
// ликвидаций, ни taker-потока. Реальная лента несёт все четыре. Разница не косметическая:
//
//   · колонки на реальной ленте вдвое толще — 13 float64-колонок против 7 (замер
//     `profile-tape-memory`: 6.2 МБ против 3.5 МБ на 60 тыс. строк), значит и перенос через границу
//     потока дороже;
//   · лента строится иначе — funding сворачивается в change-points, taker и oi ложатся поминутными
//     колонками, coverage-модель считает разрывы по каждому виду.
//
// То есть прежние замеры сняты на данных ЛЕГЧЕ настоящих, и множитель на них мог быть завышен.
//
// Источник данных — срез с VPS в mock-platform (`data/snapshots/fixtures/2026-06-18-real-all`):
// 11 символов, 14 230 строк, полные сутки. Синтетически расширенные срезы намеренно НЕ берутся.
//
// Путь — прод: HTTP-приём → очередь → `processNextQueued` → `materializeFor` → ветка стратегии →
// финализация. Ничего не подменяется, кроме флага `barLoopThread`. Совпадение `resultHash` —
// предусловие: сравнивать скорость путей, дающих разные числа, бессмысленно.
//
//   pnpm exec tsx apps/backtester/scripts/bench-thread-real-data.mts
//   BTR_SYMBOLS=4 BTR_REPEATS=3 pnpm exec tsx apps/backtester/scripts/bench-thread-real-data.mts

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertQuietBench, assertStableSamples, minOf } from './lib/bench-gate.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, '..');
const SNAPSHOT_REL = 'mock-platform/data/snapshots/fixtures/2026-06-18-real-all/ops/bundle.json';

/**
 * Найти срез, поднимаясь вверх до каталога, где `mock-platform` лежит соседом.
 *
 * Фиксированный относительный путь здесь не годится: глубина различается между основным чекаутом и
 * git-воркдеревом (`.claude/worktrees/<имя>/`), и посчитанный для одного он молча промахивается в
 * другом. Переопределяется через `BTR_SNAPSHOT`.
 */
function findSnapshot(): string {
  const override = process.env.BTR_SNAPSHOT;
  if (override !== undefined && override !== '') return override;
  let dir = APP_DIR;
  for (let i = 0; i < 8; i += 1) {
    const candidate = resolve(dir, SNAPSHOT_REL);
    if (existsSync(candidate)) return candidate;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(
    `не найден срез ${SNAPSHOT_REL} ни в одном родительском каталоге от ${APP_DIR}. ` +
      'Укажите путь явно через BTR_SNAPSHOT.',
  );
}

const SNAPSHOT = findSnapshot();

const SYMBOL_LIMIT = Math.max(1, Number(process.env.BTR_SYMBOLS ?? 3));
const REPEATS = Math.max(1, Number(process.env.BTR_REPEATS ?? 3));

assertQuietBench('bench-thread-real-data');

const [{ buildTestApp, AUTH }, { loadConfig }, { __resetTapeCachesForTest }] = await Promise.all([
  import('../test/helpers.js'),
  import('../src/config.js'),
  import('../src/data/tape-cache.js'),
]);

// --- Датасет из реального среза -------------------------------------------------------------------

interface Row { symbol: string; minute_ts: number; [k: string]: unknown }

const bundle = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as {
  historical: { rowsBySymbol: Record<string, Row[]> };
};
const bySymbol = bundle.historical.rowsBySymbol;
// Символы берутся ПО УБЫВАНИЮ числа строк: короткие ряды дали бы неполные окна и несравнимые длины.
const symbols = Object.entries(bySymbol)
  .sort((a, b) => b[1].length - a[1].length)
  .slice(0, SYMBOL_LIMIT)
  .map(([s]) => s);

const rows: Row[] = [];
for (const s of symbols) rows.push(...bySymbol[s]!);
rows.sort((a, b) => a.minute_ts - b.minute_ts || a.symbol.localeCompare(b.symbol));

const stamps = [...new Set(rows.map((r) => r.minute_ts))].sort((a, b) => a - b);
const datasetRef = 'real-2026-06-18-1m';
const fixturesDir = mkdtempSync(join(tmpdir(), 'btr-'));
writeFileSync(join(fixturesDir, `${datasetRef}.json`), JSON.stringify({ datasetRef, timeframe: '1m', rows }));

const kinds = (['has_oi', 'has_funding', 'has_liquidations', 'has_taker_flow'] as const).filter((k) =>
  rows.some((r) => r[k]),
);

console.log(
  `\n[bench-thread-real-data] символов=${symbols.length} (${symbols.join(', ')}), строк=${rows.length.toLocaleString('ru')}, ` +
    `минут=${stamps.length}\n  период ${new Date(stamps[0]!).toISOString()} → ${new Date(stamps[stamps.length - 1]!).toISOString()}` +
    `\n  виды в данных: ${kinds.join(', ') || 'нет'}\n  повторов=${REPEATS}\n`,
);

// --- Прогон через настоящую очередь ---------------------------------------------------------------

const baselineRequest = JSON.parse(
  readFileSync(resolve(APP_DIR, 'test/fixtures/overlay/requests/baseline.json'), 'utf8'),
) as Record<string, unknown>;
const strategyBundle = JSON.parse(
  readFileSync(resolve(APP_DIR, 'test/fixtures/overlay/bundles/short-after-pump.bundle.json'), 'utf8'),
);

const period = {
  from: new Date(stamps[0]!).toISOString(),
  to: new Date(stamps[stamps.length - 1]! + 60_000).toISOString(),
};

/**
 * Три конфигурации, а не две.
 *
 * `docker` — то, чем прод исполняет недоверенный код СЕГОДНЯ (`BACKTESTER_SANDBOX_BACKEND`
 * по умолчанию `docker`). Это опорная точка: всё остальное меряется относительно неё, иначе
 * непонятно, что прод получит на самом деле.
 *
 * Прежние числа серии сравнивали `docker` с «изолят + поток» разом и приписывали весь множитель
 * потоку. Это неверно: там два независимых рычага, и разделить их можно только промежуточной
 * точкой `isolate` без потока.
 */
type Config = 'docker' | 'isolate' | 'isolate+thread';
const CONFIGS: readonly Config[] = (process.env.BTR_CONFIGS ?? 'docker,isolate,isolate+thread')
  .split(',')
  .map((c) => c.trim() as Config)
  .filter((c) => c.length > 0);

async function runOnce(cfg: Config, runId: string): Promise<{ wallMs: number; hash: string }> {
  __resetTapeCachesForTest();
  const app = await buildTestApp({
    enableOverlayEngine: true,
    workerConcurrency: 1,
    barLoopThread: cfg === 'isolate+thread',
    fixturesDir,
    overlaySandbox: {
      ...loadConfig().overlaySandbox,
      backend: cfg === 'docker' ? 'docker' : 'isolate',
    },
  } as never);
  try {
    const res = await app.server.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: AUTH,
      payload: {
        ...baselineRequest,
        runId,
        engine: 'strategy',
        moduleBundle: strategyBundle,
        datasetRef,
        symbols,
        timeframe: '1m',
        period,
        metrics: ['pnl', 'win_rate'],
      },
    });
    if (res.statusCode !== 202) throw new Error(`приём отклонил задание: ${res.statusCode} ${res.body.slice(0, 300)}`);

    // Замеряется ТОЛЬКО осушение очереди: приём и постройка приложения одинаковы у всех
    // конфигураций и к разнице отношения не имеют.
    const t0 = process.hrtime.bigint();
    const processed = await app.drain();
    const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
    if (processed !== 1) throw new Error(`осушено заданий: ${processed}, ожидалось 1`);

    const row = await app.store.get(runId);
    if (row?.status !== 'completed') {
      throw new Error(`прогон не завершился: ${row?.status} ${row?.terminalCode ?? ''}`);
    }
    return { wallMs, hash: row.resultHash! };
  } finally {
    await app.dispose();
  }
}

/**
 * Отстой между конфигурациями.
 *
 * Чередование раскладывает помеху поровну только тогда, когда помеха не ТЯНЕТСЯ за конфигурацией.
 * docker её тянет: контейнеры сносятся асинхронно и уже после того, как прогон вернул управление,
 * поэтому следующая конфигурация платит за чужую уборку. Видно прямо: между прогонами станка
 * изолят давал то 422, то 832 мкс/бар, тогда как поток менялся слабо — то есть страдала именно та
 * конфигурация, что шла сразу за docker.
 *
 * Ждём не фиксированную паузу, а СПАДА нагрузки — фиксированная была бы либо мала на медленной
 * машине, либо расточительна на быстрой.
 */
async function settle(): Promise<void> {
  const deadline = Date.now() + SETTLE_MAX_MS;
  for (;;) {
    const la1 = Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0]);
    if (la1 <= SETTLE_LOAD || Date.now() > deadline) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}

const SETTLE_LOAD = Number(process.env.BTR_SETTLE_LOAD ?? 1.0);
const SETTLE_MAX_MS = Number(process.env.BTR_SETTLE_MAX_MS ?? 30_000);

const walls = new Map<Config, number[]>(CONFIGS.map((c) => [c, []]));

// Чередование, а не фазы (bt#195). Прогрев — нулевой повтор.
for (let rep = 0; rep <= REPEATS; rep += 1) {
  for (const cfg of CONFIGS) {
    await settle();
    const { wallMs } = await runOnce(cfg, `btr-${cfg.replace('+', '-')}-${rep}`);
    if (rep > 0) walls.get(cfg)!.push(wallMs);
  }
}

// Паритет здесь НЕ проверяется: `runId` входит в хэшируемый результат, а он у каждого прогона свой.
// Побитовое совпадение путей доказано отдельными гейтами — бэкендов (bt#192) и потока на прод-пути
// (`test/worker-thread-parity.integration.test.ts`), где оба пути идут под ОДНИМ runId.

// Гейт воспроизводимости — тот же, что у остальных станков серии. Без него станок печатает числа,
// снятые под чужой нагрузкой, а такое число задним числом неотличимо от чистого. Прогоны docker
// особенно уязвимы: контейнер на сессию, и разброс между повторами доходил до двух раз.
for (const cfg of CONFIGS) assertStableSamples(cfg, walls.get(cfg)!);

const bars = rows.length;
const base = CONFIGS.includes('docker') ? minOf(walls.get('docker')!) : minOf(walls.get(CONFIGS[0]!)!);

console.log('  ОСУШЕНИЕ ОЧЕРЕДИ (минимум из повторов)\n');
console.log('    конфигурация      │     wall │  мкс/бар │ против docker');
console.log('   ───────────────────┼──────────┼──────────┼──────────────');
for (const cfg of CONFIGS) {
  const m = minOf(walls.get(cfg)!);
  const perBar = (m * 1000) / bars;
  const gain = base / m;
  console.log(
    `    ${cfg.padEnd(17)} │ ${m.toFixed(0).padStart(6)} мс │ ${perBar.toFixed(1).padStart(8)} │ ×${gain.toFixed(2)}`,
  );
}

console.log('\n  повторы:');
for (const cfg of CONFIGS) {
  console.log(`    ${cfg.padEnd(17)} ${walls.get(cfg)!.map((x) => x.toFixed(0)).join(', ')}`);
}

// Разделение рычагов — то, ради чего в матрице есть промежуточная точка `isolate`.
if (CONFIGS.includes('docker') && CONFIGS.includes('isolate') && CONFIGS.includes('isolate+thread')) {
  const d = minOf(walls.get('docker')!);
  const i = minOf(walls.get('isolate')!);
  const t = minOf(walls.get('isolate+thread')!);
  console.log('\n  РАЗДЕЛЕНИЕ РЫЧАГОВ:');
  console.log(`    смена бэкенда docker → изолят   ×${(d / i).toFixed(2)}`);
  console.log(`    добавление потока к изоляту     ×${(i / t).toFixed(2)}`);
  console.log(`    вместе                          ×${(d / t).toFixed(2)}`);
}
console.log('');

rmSync(fixturesDir, { recursive: true, force: true });
