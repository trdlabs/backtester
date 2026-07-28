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
import { makeIsolateDeps, makeRequest, makeTrustedDeps, DEFAULT_PROBE, type WorkloadSpec } from './lib/profile-runner-fixture.js';
import { runBacktest, type RunDeps } from '../src/engine/runner.js';
import { contentRef } from '../src/determinism/hash.js';
import { materializeBundle } from '../src/engine/sandbox/bundle-materialize.js';
import type { ModuleBundle as InlineModuleBundle } from '@trading/research-contracts';

assertQuietBench('profile-runner');

const BARS = Math.max(1, Number(process.env.PROFILE_BARS ?? 60_000));
const REPEATS = Math.max(1, Number(process.env.PROFILE_REPEATS ?? 3));
const SYMBOLS = (process.env.PROFILE_SYMBOLS ?? 'BTCUSDT').split(',').map((s) => s.trim()).filter((s) => s !== '');
const BAR_MAJOR = process.env.PROFILE_BAR_MAJOR === 'true';
// Шаг B2: пербарная заморозка контекста. `false` — прод-режим прогона.
const CONTEXT_FREEZE = process.env.PROFILE_CONTEXT_FREEZE !== 'false';

const LOOKBACK = Math.max(0, Number(process.env.PROFILE_LOOKBACK ?? 0));
const BACKEND = process.env.PROFILE_BACKEND === 'isolate' ? 'isolate' : 'trusted';
const WALL_MS_PER_CALL = Math.max(2_000, Number(process.env.PROFILE_WALL_MS_PER_CALL ?? 600_000));
const probe = { ...DEFAULT_PROBE, lookback: LOOKBACK };

// В isolate-режиме модуль исполняет РЕАЛЬНЫЙ бандл, поэтому `moduleRef` обязан указывать на его
// манифест, а не на зонд: иначе реестр не разрешит ссылку и прогон будет отклонён до симуляции.
const BUNDLE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'test/fixtures/overlay/bundles/short-after-pump.bundle.json',
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
    ` contextFreeze=${CONTEXT_FREEZE} cores=${cpus().length}`,
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
const buildMs = Number(process.hrtime.bigint() - t0) / 1e6;
console.log(`  [подготовка ленты] ${buildMs.toFixed(0)} мс — вне замера`);

interface Sample {
  readonly wallMs: number;
  readonly hash: string;
  readonly barsProcessed: number;
}

async function runOnce(): Promise<Sample> {
  const started = process.hrtime.bigint();
  const out = await runBacktest(request, { ...deps, contextFreeze: CONTEXT_FREEZE });
  const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
  if (out.status !== 'completed') {
    throw new Error('прогон отклонён: ' + JSON.stringify(out.validation));
  }
  const evidence = out.baseline as unknown as { readonly evidence?: { readonly barsProcessed?: number } };
  return {
    wallMs,
    hash: contentRef(out.baseline),
    barsProcessed: evidence.evidence?.barsProcessed ?? BARS * SYMBOLS.length,
  };
}

const samples: Sample[] = [];
try {
  // Прогрев отбрасывается: первый прогон несёт JIT-разогрев и холодные кэши.
  const warm = await runOnce();
  console.log(`  [прогрев] ${warm.wallMs.toFixed(0)} мс — отброшен`);

  for (let i = 0; i < REPEATS; i += 1) {
    const s = await runOnce();
    samples.push(s);
    console.log(
      `  #${i + 1}: ${s.wallMs.toFixed(0)} мс  ${((s.wallMs * 1000) / s.barsProcessed).toFixed(1)} мкс/бар  ` +
        `баров=${s.barsProcessed}  hash=${s.hash.slice(7, 19)}…`,
    );
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
