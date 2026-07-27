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

import { cpus } from 'node:os';

import { makeRequest, makeTrustedDeps, DEFAULT_PROBE, type WorkloadSpec } from './lib/profile-runner-fixture.js';
import { runBacktest } from '../src/engine/runner.js';
import { contentRef } from '../src/determinism/hash.js';

const BARS = Math.max(1, Number(process.env.PROFILE_BARS ?? 60_000));
const REPEATS = Math.max(1, Number(process.env.PROFILE_REPEATS ?? 3));
const SYMBOLS = (process.env.PROFILE_SYMBOLS ?? 'BTCUSDT').split(',').map((s) => s.trim()).filter((s) => s !== '');
const BAR_MAJOR = process.env.PROFILE_BAR_MAJOR === 'true';

const LOOKBACK = Math.max(0, Number(process.env.PROFILE_LOOKBACK ?? 0));
const probe = { ...DEFAULT_PROBE, lookback: LOOKBACK };
const spec: WorkloadSpec = { symbols: SYMBOLS, bars: BARS, seed: 12345, barMajor: BAR_MAJOR, probe };

console.log(
  `[profile-runner] bars=${BARS} symbols=${SYMBOLS.length} (${SYMBOLS.join(',')}) barMajor=${BAR_MAJOR} ` +
    `repeats=${REPEATS} probe=entry/${probe.entryEvery}+hold/${probe.holdBars}+lookback/${probe.lookback} cores=${cpus().length}`,
);

// Лента строится ОДИН раз и переиспользуется: её постройка (deep-freeze 60k баров) не относится к
// стоимости прогона, и попав в профиль, она исказила бы разбивку.
const t0 = process.hrtime.bigint();
const deps = makeTrustedDeps(spec);
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
  const out = await runBacktest(request, deps);
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

// Прогрев отбрасывается: первый прогон несёт JIT-разогрев и холодные кэши.
const warm = await runOnce();
console.log(`  [прогрев] ${warm.wallMs.toFixed(0)} мс — отброшен`);

const samples: Sample[] = [];
for (let i = 0; i < REPEATS; i += 1) {
  const s = await runOnce();
  samples.push(s);
  console.log(
    `  #${i + 1}: ${s.wallMs.toFixed(0)} мс  ${((s.wallMs * 1000) / s.barsProcessed).toFixed(1)} мкс/бар  ` +
      `баров=${s.barsProcessed}  hash=${s.hash.slice(7, 19)}…`,
  );
}

const walls = samples.map((s) => s.wallMs).sort((a, b) => a - b);
const median = walls.length % 2 === 1 ? walls[walls.length >> 1]! : (walls[(walls.length >> 1) - 1]! + walls[walls.length >> 1]!) / 2;
const bars = samples[0]!.barsProcessed;

// Нестабильность результата между повторами ломает основание сравнения так же, как и ошибка замера.
const distinct = new Set(samples.map((s) => s.hash));
if (distinct.size > 1) {
  console.error(`\nЗАМЕР НЕДЕЙСТВИТЕЛЕН: result_hash различается между повторами (${distinct.size} различных) — прогон недетерминирован.`);
  process.exitCode = 2;
}

console.log(
  `\n[profile-runner] median ${median.toFixed(0)} мс на ${bars} баров = ` +
    `${((median * 1000) / bars).toFixed(1)} мкс/бар (min ${walls[0]!.toFixed(0)} мс, max ${walls[walls.length - 1]!.toFixed(0)} мс)`,
);
console.log(`[profile-runner] result_hash=${samples[0]!.hash}`);
