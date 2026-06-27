/**
 * verify-sdk-clean-consumer.ts
 *
 * Verifies that a packed SDK tarball can be installed and used by a clean consumer
 * completely OUTSIDE the workspace — no workspace packages, no file: links, no
 * hoisted node_modules from the monorepo.
 *
 * Usage:  tsx scripts/verify-sdk-clean-consumer.ts <path-to.tgz>
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tarball = process.argv[2];
if (!tarball) {
  console.error('Usage: tsx scripts/verify-sdk-clean-consumer.ts <path-to.tgz>');
  process.exit(1);
}

const absoluteTarball = resolve(tarball);

// Smoke test — TypeScript source (compile-time coverage of all entrypoints)
const smokeTs = `\
import { SDK_VERSION } from '@trading-backtester/sdk';
import type { ModuleBundle } from '@trading-backtester/sdk/contracts';
import { createModuleManifest } from '@trading-backtester/sdk/builder';
import { BacktesterClient } from '@trading-backtester/sdk/client';
import { isContentHash } from '@trading-backtester/sdk/artifacts';
void [SDK_VERSION, createModuleManifest, BacktesterClient, isContentHash];
const bundle: ModuleBundle | undefined = undefined;
void bundle;
`;

// Smoke test — runtime ESM
const smokeMjs = `\
import { SDK_VERSION } from '@trading-backtester/sdk';
import { allSchemaAssets } from '@trading-backtester/sdk/contracts';
import { createModuleManifest, createModuleBundle, computeInlineBundleHash } from '@trading-backtester/sdk/builder';
import { BacktesterClient } from '@trading-backtester/sdk/client';
import { isContentHash } from '@trading-backtester/sdk/artifacts';
import { readFileSync } from 'node:fs';
const expected = JSON.parse(readFileSync(new URL('./node_modules/@trading-backtester/sdk/package.json', import.meta.url), 'utf8')).version;
if (SDK_VERSION !== expected) { console.error('SDK_VERSION', SDK_VERSION, '!== package.json', expected); process.exit(1); }
if (typeof createModuleManifest !== 'function') process.exit(1);
if (typeof BacktesterClient !== 'function') process.exit(1);
if (!isContentHash(\`sha256:\${'a'.repeat(64)}\`)) process.exit(1);
if (allSchemaAssets().length !== 5) process.exit(1);
const manifest = createModuleManifest({
  id: 'smoke',
  version: '1.0.0',
  kind: 'overlay',
  name: 'Smoke overlay',
  summary: 'clean-consumer smoke',
  rationale: 'verifies the published SDK builds bundles standalone',
  hooks: ['apply'],
  paramsSchema: { type: 'object' },
  capabilities: { platformSdk: true },
  dataNeeds: { closedCandlesUpToCurrent: true },
});
const bundle = createModuleBundle({ manifest, entry: 'index.js', files: { 'index.js': 'export default () => ({ apply: () => null })' } });
if (!isContentHash(computeInlineBundleHash(bundle))) process.exit(1);
`;

const tsconfigJson = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
    noEmit: true,
    skipLibCheck: false,
  },
  include: ['smoke.ts'],
}, null, 2);

let tmpDir: string | null = null;
let exitCode = 0;

try {
  // Create temp directory OUTSIDE the repo (under OS tmpdir)
  tmpDir = mkdtempSync(join(tmpdir(), 'sdk-consumer-'));
  console.log(`\nClean consumer temp dir: ${tmpDir}`);

  const packageJson = JSON.stringify({
    name: 'sdk-smoke-consumer',
    version: '1.0.0',
    private: true,
    type: 'module',
    dependencies: {
      '@trading-backtester/sdk': absoluteTarball,
    },
    devDependencies: {
      typescript: '^5.7.2',
    },
  }, null, 2);

  writeFileSync(join(tmpDir, 'package.json'), packageJson);
  writeFileSync(join(tmpDir, 'tsconfig.json'), tsconfigJson);
  writeFileSync(join(tmpDir, 'smoke.ts'), smokeTs);
  writeFileSync(join(tmpDir, 'smoke.mjs'), smokeMjs);

  const execOpts = { cwd: tmpDir, stdio: 'inherit' as const, encoding: 'utf8' as const };

  // Step 1: resolve deps first (--lockfile-only; fast, no side effects)
  console.log('\n[1/4] pnpm install --lockfile-only ...');
  execFileSync('pnpm', ['install', '--lockfile-only'], execOpts);

  // Step 2: install with frozen lockfile
  console.log('\n[2/4] pnpm install --frozen-lockfile ...');
  execFileSync('pnpm', ['install', '--frozen-lockfile'], execOpts);

  // Step 3: typecheck smoke.ts
  console.log('\n[3/4] tsc --noEmit ...');
  execFileSync('pnpm', ['exec', 'tsc', '--noEmit'], execOpts);

  // Step 4: run smoke.mjs
  console.log('\n[4/4] node smoke.mjs ...');
  execFileSync('node', ['smoke.mjs'], execOpts);

  console.log('\nClean-consumer verification PASSED.');
} catch (err) {
  console.error('\nClean-consumer verification FAILED:', err instanceof Error ? err.message : String(err));
  exitCode = 1;
} finally {
  // NOTE: process.exit() inside try/catch would skip this finally (Node terminates
  // synchronously), leaking the temp dir — so set exitCode and exit AFTER cleanup.
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}
process.exit(exitCode);
