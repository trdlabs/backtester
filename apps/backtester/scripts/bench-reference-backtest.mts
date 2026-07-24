// BENCH (Docker-gated) — референс-бэктест под матрицей флагов перф-трио.
// control-center `dark-flag-validation`, item 3 (батч 1); тот же станок обслуживает U8-перф-гейт
// (`backtester-runtime-hardening` item 4).
//
// Один и тот же прогон исполняется под каждым вариантом флагов и сверяется по `result_hash` с
// baseline — так измеряется «транспортный флаг ничего не меняет, но ускоряет» (или не ускоряет).
// Прогон идёт через РЕАЛЬНЫЙ sandbox-контейнер (`buildSandboxStrategyBaselineDeps`) — единственный
// путь, где per-bar IPC вообще существует.
//
//   pnpm bench:reference
//   BENCH_REPEATS=5 BENCH_VARIANTS=off,bar_major_batch pnpm bench:reference -- --json /tmp/b.json
//
// Не CI-ассерт: печатает таблицу измерений. Чистые части покрыты юнитами
// (`test/bench-reference-harness.test.ts`).

import { readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VARIANTS,
  formatBenchMarkdown,
  identityVerdict,
  parseIpcProfileLine,
  parseVariants,
  sumIpcProfiles,
  type IpcProfile,
  type RepeatSample,
  type VariantResult,
} from './lib/bench-reference.js';

// ВАЖНО: выставляется ДО динамических импортов движка — `SandboxSession.profileEnabled` читается
// один раз в статическом поле при загрузке модуля. Статических импортов движка в этом файле быть
// не должно (они вычисляются раньше тела модуля).
process.env.BACKTESTER_IPC_PROFILE = 'true';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, '..');

const argv = process.argv.slice(2);
const jsonAt = argv.indexOf('--json');
const jsonPath = jsonAt === -1 ? undefined : argv[jsonAt + 1];

const REPEATS = Math.max(1, Number(process.env.BENCH_REPEATS ?? 3));
const REQUEST_PATH = resolve(APP_DIR, process.env.BENCH_REQUEST ?? 'test/fixtures/overlay/requests/universe-multi.json');
const BUNDLE_PATH = resolve(APP_DIR, process.env.BENCH_BUNDLE ?? 'test/fixtures/overlay/bundles/short-after-pump.bundle.json');
const variants = parseVariants(process.env.BENCH_VARIANTS);

const [
  { runBacktest },
  { buildOverlayDataset },
  { FixtureDataPort },
  { buildSandboxStrategyBaselineDeps, materializeReadableBundle },
  { FIXTURES_DIR },
  { resultHash },
] = await Promise.all([
  import('../src/engine/runner.js'),
  import('../src/engine/data-adapter.js'),
  import('../src/data/reader.js'),
  import('../test/helpers-overlay-sandbox.js'),
  import('../test/helpers.js'),
  import('../test/helpers/bar-major-fixture.js'),
]);

/** Перехват stderr сессий: строки `ipc_profile` копятся, всё остальное идёт дальше как обычно. */
function captureIpc(): { stop: () => IpcProfile[] } {
  const original = console.error;
  const collected: IpcProfile[] = [];
  console.error = (...args: unknown[]): void => {
    if (args.length === 1 && typeof args[0] === 'string') {
      const profile = parseIpcProfileLine(args[0]);
      if (profile !== undefined) {
        collected.push(profile);
        return;
      }
    }
    original(...(args as []));
  };
  return {
    stop: () => {
      console.error = original;
      return collected;
    },
  };
}

const request = JSON.parse(readFileSync(REQUEST_PATH, 'utf8'));
const bundle = JSON.parse(readFileSync(BUNDLE_PATH, 'utf8'));

console.log(
  `[bench-reference] variants=${variants.join('/')} repeats=${REPEATS} symbols=${request.symbols.length} ` +
    `cores=${cpus().length} request=${REQUEST_PATH.replace(APP_DIR + '/', '')}`,
);

const sp = await materializeReadableBundle(bundle);
const results: VariantResult[] = [];
try {
  // Данные не зависят от флагов — материализуем ленту один раз на весь замер.
  const marketTape = await buildOverlayDataset(new FixtureDataPort(FIXTURES_DIR), {
    datasetRef: request.datasetRef,
    symbols: request.symbols,
    timeframe: request.timeframe,
    period: request.period,
  });

  for (const variant of variants) {
    const samples: RepeatSample[] = [];
    for (let i = 0; i < REPEATS; i += 1) {
      const { registry, router } = buildSandboxStrategyBaselineDeps({ spDir: sp.bundleDir });
      const capture = captureIpc();
      let hash: string;
      let wallMs: number;
      try {
        const t0 = process.hrtime.bigint();
        const out = await runBacktest(request, { registry, router, marketTape, ...VARIANTS[variant] });
        wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
        const errors = router.errors();
        if (errors.length > 0) {
          throw new Error(`sandbox errors in ${variant} repeat ${i + 1}: ${JSON.stringify(errors)}`);
        }
        hash = resultHash(out);
      } finally {
        router.closeAll(); // профили печатаются именно на close()
      }
      const ipc = sumIpcProfiles(capture.stop());
      samples.push({ wallMs, resultHash: hash, ipc });
      console.log(`  ${variant} #${i + 1}: ${wallMs.toFixed(0)} ms  hash=${hash.slice(0, 16)}…  hookCalls=${ipc.hookCalls}`);
    }
    results.push({ variant, samples });
  }
} finally {
  await sp.cleanup();
}

const meta = {
  request: REQUEST_PATH.replace(APP_DIR + '/', ''),
  bundle: BUNDLE_PATH.replace(APP_DIR + '/', ''),
  symbols: request.symbols.length,
  repeats: REPEATS,
  host: `${process.platform} ${cpus().length} cores`,
};

console.log('\n' + formatBenchMarkdown(results, meta));

if (jsonPath !== undefined) {
  writeFileSync(jsonPath, JSON.stringify({ meta, results, verdict: identityVerdict(results) }, null, 2));
  console.log(`\n[bench-reference] сырые сэмплы → ${jsonPath}`);
}

if (!identityVerdict(results).pass) process.exitCode = 1;
