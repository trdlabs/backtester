// Slice 6b-A — build the overlay sandbox harness's `_engine/` from the SINGLE-SOURCE indicator engine.
//
// The lifted harness (sandbox-harness-overlay/{entry,rehydrate,deny-shims}.mjs) is hand-authored and
// copied verbatim from the platform. `rehydrate.mjs` imports `./_engine/engine.js`. This script
// compiles `apps/backtester/src/engine/indicators/**` (the one place indicator logic lives, lifted in
// 6a) → ESM JS into `sandbox-harness-overlay/_engine/`, writes `_engine/package.json` ({type:module})
// so plain `node` treats the emitted `.js` as ESM, and records a drift manifest. The container runs
// `node /sandbox/harness/entry.mjs` with NO node_modules — so the emitted tree MUST be relative-import
// self-contained. We assert that after emit (HARD STOP on any bare-package import).

import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeIndicatorSourceHash } from './indicator-source-hash.mjs';

const here = dirname(fileURLToPath(import.meta.url)); // apps/backtester/scripts
const appRoot = dirname(here); // apps/backtester
const overlayDir = join(appRoot, 'sandbox-harness-overlay');
const engineDir = join(overlayDir, '_engine');
const tsconfig = join(overlayDir, 'tsconfig.engine.json');
const repoRoot = dirname(dirname(appRoot));

function collectFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** Match every ESM import/export specifier that names a module (static + dynamic + re-export). */
const IMPORT_RE =
  /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;

function assertSelfContained() {
  const offenders = [];
  for (const abs of collectFiles(engineDir)) {
    if (!abs.endsWith('.js')) continue;
    const src = readFileSync(abs, 'utf8');
    let m;
    IMPORT_RE.lastIndex = 0;
    while ((m = IMPORT_RE.exec(src)) !== null) {
      const spec = m[1] ?? m[2];
      if (spec === undefined) continue;
      const isRelative = spec.startsWith('./') || spec.startsWith('../');
      if (!isRelative) {
        offenders.push({ file: relative(repoRoot, abs).split('\\').join('/'), import: spec });
      }
    }
  }
  if (offenders.length > 0) {
    console.error(
      '\nHARD STOP — emitted _engine is NOT container-self-contained (container has no node_modules).',
    );
    for (const o of offenders) console.error(`  ${o.file}  ->  bare import: ${o.import}`);
    console.error(
      '\nThe indicator engine has a runtime (non-type) dependency. Surface this before vendoring/bundling.',
    );
    process.exit(1);
  }
}

function main() {
  // Clean prior emit so stale files can't linger.
  rmSync(engineDir, { recursive: true, force: true });
  mkdirSync(engineDir, { recursive: true });

  // Compile the indicator engine to ESM JS. tsc resolves from the local tsconfig (NodeNext) and walks
  // up to apps/backtester/node_modules for the type-only contract import (erased on emit).
  const tscBin = join(repoRoot, 'node_modules', '.bin', 'tsc');
  execFileSync(tscBin, ['-p', tsconfig], { stdio: 'inherit', cwd: repoRoot });

  // Mark the emitted tree as ESM so plain `node` loads `_engine/*.js` as modules (matches the
  // harness's `import './_engine/engine.js'`).
  writeFileSync(join(engineDir, 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`);

  // HARD STOP: every emitted import must be relative.
  assertSelfContained();

  // Drift manifest — the same hash the drift-guard test recomputes from src/engine/indicators/**.
  const sourceHash = computeIndicatorSourceHash();
  writeFileSync(
    join(engineDir, '.build-manifest.json'),
    `${JSON.stringify({ sourceHash }, null, 2)}\n`,
  );

  console.log('built _engine from src/engine/indicators; sourceHash=%s', sourceHash);
}

main();
