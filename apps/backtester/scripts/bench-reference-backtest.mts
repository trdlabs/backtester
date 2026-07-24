// BENCH (Docker-gated) — референс-бэктест под матрицей флагов перф-трио.
// control-center `dark-flag-validation`, item 3 (батч 1); тот же станок обслуживает U8-перф-гейт
// (`backtester-runtime-hardening` item 4).
//
// Один и тот же прогон исполняется под каждым вариантом флагов и сверяется по `result_hash` со
// СВОИМ референсом (см. `IDENTITY_BASELINE`). Прогон идёт через РЕАЛЬНЫЙ sandbox-контейнер —
// единственный путь, где per-bar IPC вообще существует.
//
//   pnpm bench:reference
//   BENCH_REPEATS=5 BENCH_VARIANTS=bar_major_batch pnpm bench:reference -- --json /tmp/b.json
//
// Порядок прогонов — round-robin (внешний цикл — повтор, внутренний — вариант) плюс один
// отбрасываемый прогрев: иначе первый вариант поглощает всю холодную стоимость (Docker-слои,
// page cache, JIT), а последний выглядит быстрее просто потому, что он последний.
//
// Не CI-ассерт: печатает таблицу измерений. Чистые части покрыты юнитами
// (`test/bench-reference-harness.test.ts`).

import { readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VARIANTS,
  engagementProblem,
  formatBenchMarkdown,
  identityVerdict,
  parseIpcProfileLine,
  parseVariants,
  sumIpcProfiles,
  type IpcProfile,
  type RepeatSample,
  type VariantName,
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

const request = JSON.parse(readFileSync(REQUEST_PATH, 'utf8'));
const bundle = JSON.parse(readFileSync(BUNDLE_PATH, 'utf8'));
const SYMBOLS: number = request.symbols.length;

console.log(
  `[bench-reference] variants=${variants.join('/')} repeats=${REPEATS} (+1 прогрев) symbols=${SYMBOLS} ` +
    `cores=${cpus().length} request=${REQUEST_PATH.replace(APP_DIR + '/', '')}`,
);

const sp = await materializeReadableBundle(bundle);
const results = new Map<VariantName, RepeatSample[]>(variants.map((v) => [v, []]));

/** Один прогон варианта: строит свежий роутер, меряет wall, собирает IPC-профиль после closeAll. */
async function runOnce(variant: VariantName, marketTape: unknown): Promise<RepeatSample> {
  const spec = VARIANTS[variant];
  const { registry, router } = buildSandboxStrategyBaselineDeps({
    spDir: sp.bundleDir,
    ...(spec.routerUniverse ? { universe: { enabled: true, n: SYMBOLS, memBaseMb: 128, memPerSymbolMb: 8 } } : {}),
  });

  const originalError = console.error;
  const profiles: IpcProfile[] = [];
  console.error = (...args: unknown[]): void => {
    if (args.length === 1 && typeof args[0] === 'string') {
      const profile = parseIpcProfileLine(args[0]);
      if (profile !== undefined) {
        profiles.push(profile);
        return;
      }
    }
    originalError(...(args as []));
  };

  let hash: string;
  let wallMs: number;
  try {
    const t0 = process.hrtime.bigint();
    const out = await runBacktest(request, { registry, router, marketTape, ...spec.run } as never);
    wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const errors = router.errors();
    if (errors.length > 0) throw new Error(`sandbox errors (${variant}): ${JSON.stringify(errors)}`);
    hash = resultHash(out);
  } finally {
    router.closeAll(); // профили печатаются именно на close()
    console.error = originalError;
  }
  return { wallMs, resultHash: hash, ipc: sumIpcProfiles(profiles), sessions: profiles.length };
}

try {
  // Данные не зависят от флагов — материализуем ленту один раз на весь замер.
  const marketTape = await buildOverlayDataset(new FixtureDataPort(FIXTURES_DIR), {
    datasetRef: request.datasetRef,
    symbols: request.symbols,
    timeframe: request.timeframe,
    period: request.period,
  });

  const warm = await runOnce(variants[0]!, marketTape);
  console.log(`  [прогрев ${variants[0]}] ${warm.wallMs.toFixed(0)} ms — отброшен`);

  for (let i = 0; i < REPEATS; i += 1) {
    for (const variant of variants) {
      const s = await runOnce(variant, marketTape);
      results.get(variant)!.push(s);
      console.log(
        `  ${variant} #${i + 1}: ${s.wallMs.toFixed(0)} ms  hash=${s.resultHash.slice(7, 19)}…  ` +
          `сессий=${s.sessions} hookCalls=${s.ipc.hookCalls} hookBatches=${s.ipc.hookBatches} barMajorBatches=${s.ipc.barMajorBatches}`,
      );
    }
  }
} finally {
  await sp.cleanup();
}

const ordered: VariantResult[] = variants.map((v) => ({ variant: v, samples: results.get(v)! }));
const offHash = results.get('off')?.[0]?.resultHash;

// Замер, в котором флаг не оставил следа, — НЕДЕЙСТВИТЕЛЬНЫЙ, а не «без ускорения».
const notEngaged: string[] = [];
for (const r of ordered) {
  for (const s of r.samples) {
    const problem = engagementProblem(r.variant, s, offHash);
    if (problem !== undefined) notEngaged.push(`${r.variant}: ${problem}`);
  }
}

const meta = {
  request: REQUEST_PATH.replace(APP_DIR + '/', ''),
  bundle: BUNDLE_PATH.replace(APP_DIR + '/', ''),
  symbols: SYMBOLS,
  repeats: REPEATS,
  host: `${process.platform} ${cpus().length} cores`,
};

console.log('\n' + formatBenchMarkdown(ordered, meta));

const verdict = identityVerdict(ordered);
if (jsonPath !== undefined) {
  writeFileSync(jsonPath, JSON.stringify({ meta, results: ordered, verdict, notEngaged }, null, 2));
  console.log(`\n[bench-reference] сырые сэмплы → ${jsonPath}`);
}

if (notEngaged.length > 0) {
  console.error('\nЗАМЕР НЕДЕЙСТВИТЕЛЕН — флаг не оставил следа в IPC-профиле:');
  for (const n of [...new Set(notEngaged)]) console.error(`  - ${n}`);
  process.exitCode = 2;
} else if (!verdict.pass || verdict.unanchored.length > 0) {
  process.exitCode = 1;
}
