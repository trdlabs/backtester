// Slice 6b-A — vitest global setup: build the overlay harness `_engine` before any test runs.
//
// `_engine` is gitignored (generated from src/engine/indicators/**). `pretest` rebuilds it for
// `pnpm test`, but direct `pnpm vitest run <file>` invocations skip pretest — so we also build here so
// the drift-guard test (and any Docker-gated overlay test) always sees a fresh `_engine`. Runs once
// per vitest process, before the suite.

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export default function setup() {
  const here = dirname(fileURLToPath(import.meta.url)); // apps/backtester/scripts
  const buildScript = join(here, 'build-sandbox-harness-overlay.mjs');
  execFileSync(process.execPath, [buildScript], { stdio: 'inherit' });
}
