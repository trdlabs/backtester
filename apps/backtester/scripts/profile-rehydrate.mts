// PERF — декомпозиция ПОБАРНОЙ стоимости харнесса (`sandbox-harness-overlay/rehydrate.mjs`).
//
// Зачем отдельный станок, а не `--cpu-prof` на `profile-runner.mts`: работа харнесса идёт ВНУТРИ
// `isolated-vm`, то есть в отдельном V8-изоляте, и хостовый CPU-профилировщик её не видит — там она
// схлопывается в один native-кадр вызова. Поэтому тот же код гоняется здесь напрямую на хосте:
// абсолютные числа чуть отличаются от внутриизолятных, но декомпозиция и характер роста — те самые.
//
// Вопрос станка: бандл, который не делает НИЧЕГО (`return {kind:'idle'}`), стоит в изоляте
// ~350–400 мкс/бар против ~40 мкс/бар у trusted-скелета. Из чего эти сотни микросекунд?
//
// МЕТОД (правка после bt#195). Сценарии ЧЕРЕДУЮТСЯ, а не идут фазами. Первая редакция мерила
// каждый сценарий целиком по очереди, и это оказалось источником систематического смещения:
// долгая работа предыдущей фазы занимает оба закреплённых ядра, фоновый оптимизирующий компилятор
// V8 не успевает, и следующая фаза весь прогон идёт неоптимизированной. Внутри прогона смещение
// постоянно, поэтому гейт воспроизводимости минимума его не видит; между прогонами оно гуляет в
// разы — так был получен и отозван вывод bt#194.
//
//   pnpm exec tsx apps/backtester/scripts/profile-rehydrate.mts
//   REHYDRATE_BARS=1000,2000,4000,8000 pnpm exec tsx apps/backtester/scripts/profile-rehydrate.mts

import { createRequire } from 'node:module';

import { assertQuietBench } from './lib/bench-gate.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

assertQuietBench('profile-rehydrate');

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS = resolve(HERE, '../sandbox-harness-overlay');

const { rehydrateContext, createSeededRng } = (await import(
  resolve(HARNESS, 'rehydrate.mjs')
)) as {
  rehydrateContext: (snapshot: unknown, buffer: unknown[], rng: unknown) => { indicators: { query(r: unknown): unknown } };
  createSeededRng: (seed: number) => unknown;
};
const { createIndicatorEngine } = (await import(resolve(HARNESS, '_engine/engine.js'))) as {
  createIndicatorEngine: (candles: unknown[]) => { accessorAt(t: number): { query(r: unknown): unknown } };
};

const SIZES = (process.env.REHYDRATE_BARS ?? '1000,2000,4000,8000')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

interface Bar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function makeBar(i: number): Bar {
  const px = 100 + Math.sin(i / 50) * 5;
  return { ts: 1_700_000_000_000 + i * 60_000, open: px, high: px + 0.5, low: px - 0.5, close: px, volume: 1000 };
}

function snapshotAt(bar: Bar, barIndex: number): unknown {
  return {
    run: { runId: 'rehydrate-bench', mode: 'research', seed: 1 },
    params: {},
    symbol: 'BTCUSDT',
    barIndex,
    bar,
    position: null,
    pendingIntent: null,
    portfolio: { equity: 10_000, openPositions: 0 },
    clockNow: bar.ts,
  };
}

const RSI = { name: 'rsi', params: { period: 14 } };

/** Один сценарий: гоняем n баров, накапливая буфер РОВНО как харнесс, и меряем суммарное время. */
function measure(n: number, mode: 'rehydrate' | 'rehydrate+query' | 'engine-ctor' | 'query-warm'): number {
  const rng = createSeededRng(1);
  const buffer: Bar[] = [];

  // Тёплый вариант — то, чем стал бы харнесс после подъёма движка на уровень сессии: движок
  // строится ОДИН раз, состояние остаётся горячим, на баре берётся только accessorAt(t).
  const warmEngine = mode === 'query-warm' ? createIndicatorEngine(buffer) : undefined;

  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i += 1) {
    const bar = makeBar(i);
    buffer.push(bar);
    const snap = snapshotAt(bar, i);
    switch (mode) {
      case 'rehydrate':
        rehydrateContext(snap, buffer, rng);
        break;
      case 'rehydrate+query': {
        const ctx = rehydrateContext(snap, buffer, rng);
        ctx.indicators.query(RSI);
        break;
      }
      case 'engine-ctor':
        createIndicatorEngine(buffer).accessorAt(i);
        break;
      case 'query-warm':
        warmEngine!.accessorAt(i).query(RSI);
        break;
    }
  }
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

const MODES = ['rehydrate', 'rehydrate+query', 'engine-ctor', 'query-warm'] as const;
const LABEL: Record<(typeof MODES)[number], string> = {
  rehydrate: 'rehydrate (без запроса индикатора)',
  'rehydrate+query': 'rehydrate + query(rsi)',
  'engine-ctor': 'createIndicatorEngine на бар (голый)',
  'query-warm': 'query(rsi) на ГОРЯЧЕМ движке (одна постройка)',
};

console.log(`[profile-rehydrate] сценарии на ${SIZES.join('/')} баров; прогрев отбрасывается\n`);

// Берём МИНИМУМ из нескольких повторов, а не среднее: сценарии аллоцируют много, GC-паузы ложатся
// случайно и раздувают среднее, тогда как минимум — самая чистая оценка стоимости самой работы.
const REPEATS = Math.max(1, Number(process.env.REHYDRATE_REPEATS ?? 5));

// Чередование по ВСЕМ парам (сценарий, размер): помеха от соседа раскладывается на всех поровну.
const results = new Map<string, Map<number, number>>(MODES.map((m) => [m, new Map<number, number>()]));
for (const mode of MODES) for (let w = 0; w < 2; w += 1) measure(200, mode); // прогрев JIT
const best = new Map<string, number>();
for (let r = 0; r < REPEATS; r += 1) {
  for (const n of SIZES) {
    for (const mode of MODES) {
      const key = `${mode}@${n}`;
      const ms = measure(n, mode);
      const prev = best.get(key);
      if (prev === undefined || ms < prev) best.set(key, ms);
    }
  }
}
for (const mode of MODES) for (const n of SIZES) results.get(mode)!.set(n, best.get(`${mode}@${n}`)!);

console.log('| Сценарий | ' + SIZES.map((n) => `${n} баров`).join(' | ') + ' |');
console.log('| --- | ' + SIZES.map(() => '---:').join(' | ') + ' |');
for (const mode of MODES) {
  const row = results.get(mode)!;
  const cells = SIZES.map((n) => {
    const ms = row.get(n)!;
    return `${ms.toFixed(0)} мс / ${((ms * 1000) / n).toFixed(1)} мкс`;
  });
  console.log(`| ${LABEL[mode]} | ${cells.join(' | ')} |`);
}

// Показатель роста: во сколько раз растёт СУММАРНОЕ время при удвоении баров.
// ~2 — линейно, ~4 — квадратично. Это и есть весь диагноз, без интерпретаций.
console.log('\n| Сценарий | ' + SIZES.slice(1).map((n, i) => `×${SIZES[i]}→${n}`).join(' | ') + ' |');
console.log('| --- | ' + SIZES.slice(1).map(() => '---:').join(' | ') + ' |');
for (const mode of MODES) {
  const row = results.get(mode)!;
  const ratios = SIZES.slice(1).map((n, i) => (row.get(n)! / row.get(SIZES[i]!)!).toFixed(2));
  console.log(`| ${LABEL[mode]} | ${ratios.join(' | ')} |`);
}

const _require = createRequire(import.meta.url);
void _require;
