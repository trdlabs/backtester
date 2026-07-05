import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertWorkerConfig } from '../src/worker-main.js';
import { loadConfig } from '../src/config.js';

describe('worker-main', () => {
  it('fails fast without DATABASE_URL', () => {
    const c = loadConfig({} as NodeJS.ProcessEnv); // no DATABASE_URL
    expect(() => assertWorkerConfig(c)).toThrow(/DATABASE_URL/);
  });
  it('accepts a config with databaseUrl', () => {
    const c = loadConfig({ DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv);
    expect(() => assertWorkerConfig(c)).not.toThrow();
  });

  // Regression guard: `pnpm worker` launches via `tsx src/worker-main.ts`, so the direct-execution
  // guard MUST fire on a `.ts` entry — a `.endsWith('worker-main.js')` check silently no-op'd main()
  // under tsx (the worker process did nothing). Spawning the real entry without DATABASE_URL proves
  // main() actually RAN: it must exit non-zero with the fail-fast message. If main() never ran the
  // process would exit 0.
  it('runs main() under tsx and fails fast without DATABASE_URL', async () => {
    const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const env = { ...process.env };
    delete env.DATABASE_URL;
    delete env.BACKTESTER_TEST_DATABASE_URL;
    const { code, stderr, err } = await new Promise<{ code: number | null; stderr: string; err: Error | null }>(
      (res) => {
        const child = execFile(
          'pnpm',
          ['exec', 'tsx', 'src/worker-main.ts'],
          // Generous timeout: under a loaded machine (full-gate parallelism, pnpm store lock
          // contention) `pnpm exec tsx` cold-start can exceed 25s — an execFile timeout kill
          // yields exitCode null + EMPTY stderr, which flaked this test as "'' to match
          // /DATABASE_URL/" while the production fail-fast behavior was fine.
          { cwd: appDir, env, timeout: 60_000 },
          (e, _stdout, se) => res({ code: child.exitCode, stderr: se, err: e }),
        );
      },
    );
    expect(code, `spawn err: ${err?.message ?? 'none'}`).not.toBe(0);
    expect(stderr, `spawn err: ${err?.message ?? 'none'}`).toMatch(/DATABASE_URL/);
  }, 75_000);
});
