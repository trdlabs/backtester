import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'apps/**/test/**/*.test.ts',
      'packages/**/test/**/*.test.ts',
      'scripts/**/*.test.ts',
    ],
    environment: 'node',
    // Build the overlay harness `_engine` (gitignored, generated from src/engine/indicators/**) once
    // before the suite, so direct `vitest run <file>` invocations — which skip the `pretest` script —
    // still see a fresh `_engine` for the drift-guard and any Docker-gated overlay test.
    globalSetup: ['apps/backtester/scripts/vitest-global-setup.mjs'],
  },
});
