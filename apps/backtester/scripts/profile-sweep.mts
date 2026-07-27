// PERF — ряд по длине окна: линейно или квадратично?
//
// Это станок-детектор, а не станок-измеритель. Абсолютные мкс/бар он тоже печатает, но его
// единственный вопрос — как растёт СУММАРНОЕ время при удвоении числа баров. ~×2 — линейно,
// ~×4 — квадратично. Ровно это отличает состояние «движок индикаторов пересоздаётся на каждом
// баре» (control-center `docs/analysis/19`, дефект O(n²)) от починенного.
//
// Почему отдельно от `profile-runner.mts`: тот меряет ОДНУ длину и включает в замер старт изолята
// (~443 мс, см. отчёт 2026-07-27). На ряде это постоянное слагаемое сжимало бы отношения к единице
// и прятало квадратичность. Здесь стартовая стоимость платится один раз, а внутри ряда меряется
// только `runBacktest`.
//
//   pnpm exec tsx apps/backtester/scripts/profile-sweep.mts                   # trusted-зонд
//   SWEEP_BACKEND=isolate pnpm exec tsx apps/backtester/scripts/profile-sweep.mts   # реальный бандл
//   SWEEP_BARS=1000,2000,4000,8000 SWEEP_REPEATS=3 ... (значения по умолчанию)

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertQuietBench, minOf } from './lib/bench-gate.js';
import {
  makeIsolateDeps,
  makeRequest,
  makeTrustedDeps,
  DEFAULT_PROBE,
  type WorkloadSpec,
} from './lib/profile-runner-fixture.js';
import { runBacktest, type RunDeps } from '../src/engine/runner.js';
import { contentRef } from '../src/determinism/hash.js';
import { materializeBundle } from '../src/engine/sandbox/bundle-materialize.js';
import type { ModuleBundle as InlineModuleBundle } from '@trading/research-contracts';

assertQuietBench('profile-sweep');

const SIZES = (process.env.SWEEP_BARS ?? '1000,2000,4000,8000')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
const REPEATS = Math.max(1, Number(process.env.SWEEP_REPEATS ?? 3));
const BACKEND = process.env.SWEEP_BACKEND === 'isolate' ? 'isolate' : 'trusted';
const SYMBOL = process.env.SWEEP_SYMBOL ?? 'BTCUSDT';
const LOOKBACK = Math.max(0, Number(process.env.SWEEP_LOOKBACK ?? 0));
const WALL_MS_PER_CALL = Math.max(2_000, Number(process.env.SWEEP_WALL_MS_PER_CALL ?? 600_000));

// `short-after-pump` спрашивает `ctx.indicators` каждый бар — именно этот класс стратегий страдал
// от пересоздания движка. Контрольный бандл без индикаторов существует в `profile-runner.mts`;
// здесь берём тот, что болен, иначе детектор нечего детектировать.
const BUNDLE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'test/fixtures/overlay/bundles/short-after-pump.bundle.json',
);

function specFor(bars: number): WorkloadSpec {
  const base: WorkloadSpec = {
    symbols: [SYMBOL],
    bars,
    seed: 12345,
    barMajor: false,
    probe: { ...DEFAULT_PROBE, lookback: LOOKBACK },
  };
  if (BACKEND !== 'isolate') return base;
  const bundle = JSON.parse(readFileSync(BUNDLE_PATH, 'utf8')) as InlineModuleBundle;
  return { ...base, module: { id: bundle.manifest.id, version: bundle.manifest.version } };
}

let bundleDir: string | undefined;
let cleanup: (() => Promise<void>) | undefined;
if (BACKEND === 'isolate') {
  const bundle = JSON.parse(readFileSync(BUNDLE_PATH, 'utf8')) as InlineModuleBundle;
  const materialized = await materializeBundle(bundle);
  bundleDir = materialized.bundleDir;
  cleanup = () => materialized.cleanup();
}

console.log(
  `[profile-sweep] backend=${BACKEND} sizes=${SIZES.join('/')} repeats=${REPEATS} symbol=${SYMBOL}` +
    (BACKEND === 'isolate' ? `  bundle=short-after-pump (индикаторная)` : `  probe=trusted`),
);

interface Row {
  readonly bars: number;
  readonly ms: number;
  readonly hash: string;
}

const rows: Row[] = [];
for (const bars of SIZES) {
  const spec = specFor(bars);
  const request = makeRequest(spec);
  const deps: RunDeps =
    BACKEND === 'isolate' ? makeIsolateDeps(spec, bundleDir!, WALL_MS_PER_CALL) : makeTrustedDeps(spec);
  try {
    const samples: number[] = [];
    let hash = '';
    // Прогрев на каждой длине: JIT прогревается формой кода, но кэши ленты — размером.
    for (let r = 0; r < REPEATS + 1; r += 1) {
      const started = process.hrtime.bigint();
      const out = await runBacktest(request, deps);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      if (out.status !== 'completed') throw new Error('прогон отклонён: ' + JSON.stringify(out.validation));
      hash = contentRef(out.baseline);
      if (r > 0) samples.push(ms);
    }
    const ms = minOf(samples);
    rows.push({ bars, ms, hash });
    console.log(`  ${String(bars).padStart(6)} баров: ${ms.toFixed(0).padStart(7)} мс  ${((ms * 1000) / bars).toFixed(1).padStart(7)} мкс/бар`);
  } finally {
    deps.router?.closeAll();
  }
}
if (cleanup !== undefined) await cleanup();

console.log('\n| Баров | Суммарно, мс | мкс/бар | Рост к предыдущему |');
console.log('| ---: | ---: | ---: | ---: |');
for (const [i, row] of rows.entries()) {
  const growth = i === 0 ? '—' : `×${(row.ms / rows[i - 1]!.ms).toFixed(2)}`;
  console.log(`| ${row.bars} | ${row.ms.toFixed(0)} | ${((row.ms * 1000) / row.bars).toFixed(1)} | ${growth} |`);
}

// Вердикт печатается машиной, а не читателем таблицы: «×2.3» и «×3.8» глазами путаются, особенно
// когда очень хочется увидеть первое.
const growths = rows.slice(1).map((row, i) => row.ms / rows[i]!.ms);
const worst = growths.length > 0 ? Math.max(...growths) : 0;
const LINEAR_CEILING = Number(process.env.SWEEP_LINEAR_CEILING ?? 2.6);
console.log(
  `\n[profile-sweep] худший рост на удвоение: ×${worst.toFixed(2)} — ` +
    (worst <= LINEAR_CEILING ? `ЛИНЕЙНО (потолок ×${LINEAR_CEILING})` : `КВАДРАТИЧНО (потолок ×${LINEAR_CEILING})`),
);
for (const row of rows) console.log(`[profile-sweep] hash@${row.bars}=${row.hash}`);
if (worst > LINEAR_CEILING) process.exitCode = 1;
