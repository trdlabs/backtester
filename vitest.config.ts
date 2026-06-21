import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'apps/**/test/**/*.test.ts',
      'packages/**/test/**/*.test.ts',
      'scripts/**/*.test.ts',
    ],
    environment: 'node',
    // Headroom for deterministic tests under full-suite parallel load: the suite runs CPU/IO-heavy
    // work concurrently (esbuild of the `_engine` harness + Docker-sandbox container tests), which can
    // occasionally push an otherwise-fast filesystem test past vitest's 5s default and fail it as a
    // timeout (observed on overlay-sandbox-materialize). 30s removes that contention ceiling without
    // touching any production code, determinism, or goldens.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Build the overlay harness `_engine` (gitignored, generated from src/engine/indicators/**) once
    // before the suite, so direct `vitest run <file>` invocations — which skip the `pretest` script —
    // still see a fresh `_engine` for the drift-guard and any Docker-gated overlay test.
    globalSetup: ['apps/backtester/scripts/vitest-global-setup.mjs'],
  },
});
