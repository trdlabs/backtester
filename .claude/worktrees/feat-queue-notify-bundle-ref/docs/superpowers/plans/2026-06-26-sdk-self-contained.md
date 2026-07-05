# Self-contained `@trading-backtester/sdk` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the published `@trading-backtester/sdk` tarball self-contained (no `@trading-platform/sdk` transitive URL dependency) so the clean-consumer CI gate goes green.

**Architecture:** Bundle the kernel's runtime into `dist/*.js` (tsup `noExternal`), copy the kernel's fs-read schema JSONs into the two dist entry dirs that need them, inline the kernel's subpath-exported types into the published `.d.ts` via a dts-bundling tool (chosen in Task 2 by trying both candidates), and move the kernel to `devDependencies`. Only `packages/sdk` is touched; the kernel stays the source of truth (the build snapshots the pinned installed release → drift-free).

**Tech Stack:** TypeScript, tsup (esbuild), Vitest, pnpm. Package: `packages/sdk`. Spec: `docs/superpowers/specs/2026-06-26-sdk-self-contained-design.md`.

## Global Constraints

- **Self-contained published artifact.** After the change, NO published file (`dist/**/*.js` or `dist/**/*.d.ts`) may reference `@trading-platform/sdk` as an import/require/`from`, and the published `package.json` `dependencies` MUST NOT contain `@trading-platform/sdk`. (esbuild banner COMMENTS like `// ../../node_modules/.../schema-assets.js` are not imports — acceptable.)
- **Acceptance gate = `scripts/verify-sdk-clean-consumer.ts`** (the failing CI step). All 4 of its steps must pass against the packed tarball: (1) `pnpm install --lockfile-only` with no `ERR_PNPM_EXOTIC_SUBDEP`, (2) `pnpm install --frozen-lockfile`, (3) `tsc --noEmit` on the smoke `.ts`, (4) `node smoke.mjs` including `allSchemaAssets().length === 5`.
- **Source of truth stays the kernel.** Schemas are COPIED from the installed kernel (`node_modules/@trading-platform/sdk/dist/validation/schemas/017/*.json`) at build time — never hand-vendored into source. The 5 schema filenames: `module-manifest.schema.json`, `strategy-decision.schema.json`, `overlay-decision.schema.json`, `backtest-run-request.schema.json`, `validation-result.schema.json`.
- **`decimal.js` stays a runtime `dependency` and stays external** (normal registry dep, not exotic).
- **Version bump `0.2.0` → `0.2.1`** in `packages/sdk/package.json`.
- **No SDK source-code (`src/**`) changes.** Only build config, `package.json`, and new build scripts.
- **Spike-validated facts:** `noExternal` bundles the runtime; the fs-read schema code lands in BOTH `dist/contracts/index.js` AND `dist/builder/index.js`; tsup's own dts (`dts.resolve`) does NOT inline subpath types.
- **Run a single SDK build:** `pnpm --filter @trading-backtester/sdk build`. Reproduce the CI gate locally: `pnpm sdk:pack && pnpm exec tsx scripts/verify-sdk-clean-consumer.ts ".artifacts/sdk/trading-backtester-sdk-0.2.1.tgz"`.
- **Branch:** `fix/sdk-self-contained` (already created; spec committed). Commit per task.

---

## File Structure

- `packages/sdk/tsup.config.ts` — **MODIFY.** Add `noExternal` (bundle kernel runtime); set `dts: false` (Task 2 owns dts); add `onSuccess` to run the schema-copy script.
- `packages/sdk/scripts/copy-schemas.mjs` — **NEW.** Post-build copy of the 5 kernel schema JSONs into `dist/contracts/schemas/017/` and `dist/builder/schemas/017/`.
- `packages/sdk/package.json` — **MODIFY.** Kernel → `devDependencies`; version `0.2.1`; add the dts-tool build wiring (Task 2).
- `packages/sdk/rollup.dts.config.mjs` **or** `packages/sdk/api-extractor.json` (×5) — **NEW (Task 2).** Whichever dts-bundling tool wins; inlines kernel subpath types into the published `.d.ts`.

---

## Task 1: Runtime bundle + schema copy + packaging

**Files:**
- Modify: `packages/sdk/tsup.config.ts`
- Create: `packages/sdk/scripts/copy-schemas.mjs`
- Modify: `packages/sdk/package.json`

**Interfaces:**
- Produces: a build that emits self-contained runtime JS (`dist/*.js` with no kernel import) + the 5 schema JSONs under `dist/contracts/schemas/017/` and `dist/builder/schemas/017/`; published `package.json` with the kernel in `devDependencies` and `version: "0.2.1"`.

> Note: this task makes the RUNTIME half self-contained and the install + runtime smoke pass. The published `.d.ts` still references the kernel until Task 2, so the full clean-consumer `tsc` step (3) does NOT pass yet — that is expected and is Task 2's deliverable.

- [ ] **Step 1: Write the schema-copy script**

Create `packages/sdk/scripts/copy-schemas.mjs`:

```javascript
// Post-build: copy the kernel's 5 fs-read 017 JSON schemas next to EACH dist entry whose
// bundled code resolves them via import.meta.url. The spike showed the schema-assets fs-read lands
// in dist/contracts/index.js AND dist/builder/index.js, so both need a sibling schemas/017 dir.
// Source of truth = the installed pinned kernel release (drift-free; no hand-vendored copies).
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sdkRoot = resolve(here, '..'); // packages/sdk
const require = createRequire(import.meta.url);

// The kernel's validation entry sits next to its schemas/017 dir (schema-assets.js uses the same).
const kernelValidationEntry = require.resolve('@trading-platform/sdk/validation');
const kernelSchemasDir = join(dirname(kernelValidationEntry), 'schemas', '017');

const EXPECTED = [
  'module-manifest.schema.json',
  'strategy-decision.schema.json',
  'overlay-decision.schema.json',
  'backtest-run-request.schema.json',
  'validation-result.schema.json',
];

if (!existsSync(kernelSchemasDir)) {
  throw new Error(`copy-schemas: kernel schemas dir not found: ${kernelSchemasDir}`);
}
const present = new Set(readdirSync(kernelSchemasDir));
for (const f of EXPECTED) {
  if (!present.has(f)) throw new Error(`copy-schemas: missing kernel schema "${f}" in ${kernelSchemasDir}`);
}

const targets = [
  join(sdkRoot, 'dist', 'contracts', 'schemas', '017'),
  join(sdkRoot, 'dist', 'builder', 'schemas', '017'),
];
for (const dir of targets) {
  mkdirSync(dir, { recursive: true });
  for (const f of EXPECTED) cpSync(join(kernelSchemasDir, f), join(dir, f));
}
console.log(`copy-schemas: copied ${EXPECTED.length} schemas into ${targets.length} dirs`);
```

- [ ] **Step 2: Wire tsup to bundle the kernel runtime and run the copy**

Edit `packages/sdk/tsup.config.ts` to the following (keep the `entry` block as-is):

```typescript
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'contracts/index': 'src/contracts/index.ts',
    'builder/index': 'src/builder/index.ts',
    'client/index': 'src/client/index.ts',
    'artifacts/index': 'src/artifacts/index.ts',
  },
  format: ['esm'],
  // dts is produced by the dedicated dts-bundling step (Task 2), not tsup — tsup/rollup-dts
  // cannot inline @trading-platform/sdk subpath-exported types.
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
  target: 'node22',
  // Bundle the kernel runtime into dist/*.js so the published artifact has no exotic URL dep.
  noExternal: [/^@trading-platform\/sdk/],
  // Copy the kernel's fs-read 017 schemas next to the dist entries that resolve them.
  onSuccess: 'node scripts/copy-schemas.mjs',
});
```

- [ ] **Step 3: Move the kernel to devDependencies and bump the version**

Edit `packages/sdk/package.json`:
- Change `"version": "0.2.0"` → `"version": "0.2.1"`.
- Remove `"@trading-platform/sdk": "https://github.com/.../trading-platform-sdk-0.7.2.tgz"` from `dependencies` and add the SAME entry (same URL spec) under `devDependencies`. Keep `"decimal.js": "^10.4.3"` in `dependencies`.

Resulting `dependencies` / `devDependencies` (illustrative):

```json
  "dependencies": {
    "decimal.js": "^10.4.3"
  },
  "devDependencies": {
    "@trading-platform/sdk": "https://github.com/alexnikolskiy/trading-platform-sdk/releases/download/sdk-v0.7.2/trading-platform-sdk-0.7.2.tgz",
    "tsup": "^8.3.5",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
```

- [ ] **Step 4: Build and verify the runtime half is self-contained**

Run: `pnpm install` (re-link after the dep move), then `pnpm --filter @trading-backtester/sdk build`
Expected: build succeeds; `copy-schemas: copied 5 schemas into 2 dirs` printed.

Then verify no kernel runtime import remains and schemas are present:

```bash
# No kernel import/require in any dist .js (banner comments "// ..." are fine):
grep -rnE "(import|require|from)[^/]*['\"]@trading-platform/sdk" packages/sdk/dist --include='*.js' || echo "NO RUNTIME KERNEL IMPORT ✓"
# 5 schemas next to BOTH entries:
ls packages/sdk/dist/contracts/schemas/017 packages/sdk/dist/builder/schemas/017
# Runtime smoke from the built dist:
node -e "import('./packages/sdk/dist/contracts/index.js').then(m => { if (m.allSchemaAssets().length !== 5) { console.error('FAIL len', m.allSchemaAssets().length); process.exit(1);} console.log('allSchemaAssets OK = 5'); })"
```

Expected: `NO RUNTIME KERNEL IMPORT ✓`; 5 `.json` files in each dir; `allSchemaAssets OK = 5`.

- [ ] **Step 5: Confirm the packed tarball drops the kernel dependency**

Run: `pnpm sdk:pack` then inspect the packed `package.json` dependencies:

```bash
tar -xzO -f .artifacts/sdk/trading-backtester-sdk-0.2.1.tgz package/package.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const p=JSON.parse(s);console.log('deps:',JSON.stringify(p.dependencies)); if(p.dependencies['@trading-platform/sdk']){console.error('FAIL: kernel still in deps');process.exit(1);} console.log('kernel NOT in published deps ✓');})"
```

Expected: `deps: {"decimal.js":"^10.4.3"}` and `kernel NOT in published deps ✓`.

(Optional sanity: `pnpm exec tsx scripts/verify-sdk-clean-consumer.ts ".artifacts/sdk/trading-backtester-sdk-0.2.1.tgz"` — steps 1, 2, 4 now pass; step 3 `tsc` still FAILS on unresolved `@trading-platform/sdk` types. That is Task 2.)

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/tsup.config.ts packages/sdk/scripts/copy-schemas.mjs packages/sdk/package.json
git commit -m "fix(sdk): bundle kernel runtime + copy schemas + kernel to devDeps (0.2.1)"
```

---

## Task 2: dts bundling — inline kernel subpath types → full gate green

**Files:**
- Create: `packages/sdk/rollup.dts.config.mjs` (Candidate 1) OR `packages/sdk/api-extractor.json` + per-entry configs (Candidate 2)
- Modify: `packages/sdk/package.json` (add the dts devDep(s) + wire the dts step into `build`)

**Interfaces:**
- Consumes: the tsup runtime build from Task 1 (`dts: false`, so no `.d.ts` is emitted by tsup).
- Produces: published `.d.ts` for all 5 entrypoints (`index`, `contracts`, `builder`, `client`, `artifacts`) with the kernel's subpath-exported types INLINED — no `@trading-platform/sdk` reference in any `dist/**/*.d.ts`.

**Decision criterion (which tool wins):** the published `.d.ts` contain no `@trading-platform/sdk` reference AND clean-consumer step 3 (`tsc --noEmit`) passes. Try Candidate 1 first (lighter); fall back to Candidate 2 if Candidate 1 cannot inline the subpath types across all 5 entrypoints.

- [ ] **Step 1: Candidate 1 — `rollup-plugin-dts` with `respectExternal`**

Add devDeps: `pnpm --filter @trading-backtester/sdk add -D rollup rollup-plugin-dts`.

First emit raw per-entry `.d.ts` via `tsc` (tsup no longer does dts). Add a `tsconfig.dts.json` in `packages/sdk`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "declaration": true,
    "emitDeclarationOnly": true,
    "noEmit": false,
    "outDir": "dist-types"
  },
  "include": ["src/**/*.ts"]
}
```

Create `packages/sdk/rollup.dts.config.mjs`:

```javascript
import { dts } from 'rollup-plugin-dts';

const entries = ['index', 'contracts/index', 'builder/index', 'client/index', 'artifacts/index'];

// respectExternal: true makes rollup-dts follow and INLINE external package types
// (the kernel's @trading-platform/sdk/research-contract and /validation subpath exports)
// instead of leaving them as bare re-exports the consumer cannot resolve.
export default entries.map((e) => ({
  input: `dist-types/${e}.d.ts`,
  output: { file: `dist/${e}.d.ts`, format: 'es' },
  plugins: [dts({ respectExternal: true })],
}));
```

Wire the build in `packages/sdk/package.json` scripts:

```json
  "scripts": {
    "build": "tsup && tsc -p tsconfig.dts.json && rollup -c rollup.dts.config.mjs && rimraf dist-types",
    "test": "vitest run test",
    "prepack": "pnpm build"
  }
```

Add `rimraf` if not present: `pnpm --filter @trading-backtester/sdk add -D rimraf` (or replace `rimraf dist-types` with `node -e "require('node:fs').rmSync('dist-types',{recursive:true,force:true})"`).

- [ ] **Step 2: Build and check Candidate 1 inlined the types**

Run: `pnpm --filter @trading-backtester/sdk build`
Then:

```bash
grep -rnE "['\"]@trading-platform/sdk" packages/sdk/dist --include='*.d.ts' && echo "STILL REFERENCED ✗" || echo "NO KERNEL TYPES IN .d.ts ✓"
```

Expected (Candidate 1 success): `NO KERNEL TYPES IN .d.ts ✓`. If it prints `STILL REFERENCED ✗` (rollup-dts left subpath types external), proceed to Step 3 (Candidate 2). Otherwise SKIP Step 3.

- [ ] **Step 3: Candidate 2 (only if Candidate 1 failed) — api-extractor `bundledPackages`**

Remove the rollup-dts wiring from Step 1. Add devDep: `pnpm --filter @trading-backtester/sdk add -D @microsoft/api-extractor`.

Keep the `tsc -p tsconfig.dts.json` raw-emit. For EACH of the 5 entrypoints create `packages/sdk/api-extractor.<entry>.json` (entry ∈ index, contracts, builder, client, artifacts) of the form (example for `contracts`):

```json
{
  "$schema": "https://developer.microsoft.com/json-schemas/api-extractor/v7/api-extractor.schema.json",
  "mainEntryPointFilePath": "<projectFolder>/dist-types/contracts/index.d.ts",
  "bundledPackages": ["@trading-platform/sdk"],
  "compiler": { "tsconfigFilePath": "<projectFolder>/tsconfig.dts.json" },
  "dtsRollup": {
    "enabled": true,
    "untrimmedFilePath": "<projectFolder>/dist/contracts/index.d.ts"
  },
  "apiReport": { "enabled": false },
  "docModel": { "enabled": false },
  "tsdocMetadata": { "enabled": false }
}
```

(For the root `index`, `mainEntryPointFilePath` is `dist-types/index.d.ts` and `untrimmedFilePath` is `dist/index.d.ts`; analogous for `builder`, `client`, `artifacts`.)

Wire the build:

```json
  "scripts": {
    "build": "tsup && tsc -p tsconfig.dts.json && node scripts/run-api-extractor.mjs && rimraf dist-types"
  }
```

Create `packages/sdk/scripts/run-api-extractor.mjs`:

```javascript
import { Extractor, ExtractorConfig } from '@microsoft/api-extractor';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entries = ['index', 'contracts', 'builder', 'client', 'artifacts'];
for (const e of entries) {
  const cfg = ExtractorConfig.loadFileAndPrepare(join(sdkRoot, `api-extractor.${e}.json`));
  const res = Extractor.invoke(cfg, { localBuild: true, showVerboseMessages: false });
  if (!res.succeeded) {
    console.error(`api-extractor failed for ${e}: ${res.errorCount} errors`);
    process.exit(1);
  }
}
console.log('api-extractor: rolled up 5 entrypoints');
```

Rebuild and re-run the Step 2 grep — expect `NO KERNEL TYPES IN .d.ts ✓`.

- [ ] **Step 4: Full acceptance — the clean-consumer gate green**

Run, in order:

```bash
pnpm --filter @trading-backtester/sdk build
pnpm sdk:verify
pnpm sdk:pack
pnpm exec tsx scripts/verify-sdk-clean-consumer.ts ".artifacts/sdk/trading-backtester-sdk-0.2.1.tgz"
pnpm --filter @trading-backtester/sdk test
pnpm check
```

Expected:
- `sdk:verify` → "SDK tarball OK".
- clean-consumer → "Clean-consumer verification PASSED." (all 4 steps, including step 3 `tsc` and step 4 `allSchemaAssets().length === 5`).
- SDK tests → green.
- `pnpm check` → typecheck + 394 tests green (unaffected).

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/package.json packages/sdk/tsconfig.dts.json packages/sdk/rollup.dts.config.mjs packages/sdk/api-extractor.*.json packages/sdk/scripts/run-api-extractor.mjs
# (git add only the files the winning candidate created)
git commit -m "fix(sdk): inline kernel subpath types into published d.ts — clean-consumer gate green"
```

---

## Self-Review

**Spec coverage:**
- Runtime bundling (`noExternal`) → Task 1 Step 2. ✓
- Schema copy to both dist dirs (R2) → Task 1 Step 1+2. ✓
- Kernel → devDeps + version 0.2.1 → Task 1 Step 3. ✓
- dts subpath-type inlining (R1), tool chosen by criterion → Task 2 (Candidate 1 → fallback Candidate 2). ✓
- Acceptance via clean-consumer 4 steps + sdk:verify + SDK tests + pnpm check → Task 2 Step 4. ✓
- Non-goals (no kernel/cross-repo change, no src changes, decimal.js external) → respected (only build config + package.json + build scripts touched). ✓

**Placeholder scan:** The dts tool is intentionally a try-both with an explicit decision criterion (grep clean + clean-consumer tsc green), not a placeholder — both candidates have complete, runnable config. Task 1 is honestly scoped as "runtime half" with the gate completion deferred to Task 2 (stated, not vague).

**Type/consistency:** Schema filenames (5) identical between the copy script and the global constraint. The published-artifact self-containment check (grep for `@trading-platform/sdk`) is applied consistently to `.js` (Task 1) and `.d.ts` (Task 2). Version `0.2.1` consistent across package.json, pack, and the clean-consumer tarball path.
