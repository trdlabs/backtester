#!/usr/bin/env node
// POC (analysis/18 вариант A) — собрать in-isolate харнесс в один classic-script для isolated-vm.
//
// esbuild бандлит sandbox-harness-overlay/isolate-entry.mjs (импортирует rehydrate.mjs +
// universe-instances.mjs + build-generated `_engine/**`) в IIFE БЕЗ внешних импортов —
// isolated-vm compileScript исполняет только classic scripts, ESM-граф должен быть схлопнут.
// Выход: sandbox-harness-overlay/_isolate/harness.js (gitignored, как `_engine/`).
//
// ПОРЯДОК СБОРКИ: требует построенного `_engine/` (build-sandbox-harness-overlay.mjs) — тот же
// инвариант, что у docker-харнесса; fail-fast здесь зеркалит assertHarnessComplete.

import { build } from 'esbuild';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const overlayDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'sandbox-harness-overlay');
const entry = join(overlayDir, 'isolate-entry.mjs');
const engineJs = join(overlayDir, '_engine', 'engine.js');
const outDir = join(overlayDir, '_isolate');
const outFile = join(outDir, 'harness.js');

if (!existsSync(engineJs)) {
  console.error(
    'build-isolate-harness: `_engine/` is missing — run `pnpm run build:sandbox-harness-overlay` first ' +
      '(the isolate harness bundles the SAME compiled indicator engine as the docker harness).',
  );
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
await build({
  entryPoints: [entry],
  bundle: true,
  format: 'iife', // classic script — единственная форма, которую isolate.compileScript исполняет
  platform: 'neutral', // никаких node built-ins: изолят их не имеет, сборка падает при их утечке
  outfile: outFile,
  logLevel: 'silent',
  target: 'es2022',
});
console.log(`build-isolate-harness: OK → ${outFile}`);
