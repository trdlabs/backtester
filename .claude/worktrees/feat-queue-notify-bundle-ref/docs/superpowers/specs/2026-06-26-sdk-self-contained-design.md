# Self-contained `@trading-backtester/sdk` — design

**Date:** 2026-06-26
**Branch:** `fix/sdk-self-contained` (from `main`)
**Status:** design approved, spec under review

## Problem

The CI step **"Build and inspect public SDK"** (`.github/workflows/ci.yml`) fails on `main` — it has reddened every recent run and masks real failures. The failing sub-step is `verify-sdk-clean-consumer.ts`, which packs `@trading-backtester/sdk` and installs the tarball in a clean directory **outside** the workspace to prove a fresh consumer can use it.

Root cause: `packages/sdk/package.json` declares a **runtime dependency** on `@trading-platform/sdk` resolved via a **GitHub-release URL tarball** (`sdk-v0.7.2`). A clean consumer's `pnpm install` rejects it:

```
[ERR_PNPM_EXOTIC_SUBDEP] Exotic dependency "@trading-platform/sdk" (resolved via url)
is not allowed in subdependencies when blockExoticSubdeps is enabled
```

pnpm's default `blockExoticSubdeps` blocks URL-resolved packages when they appear as **sub**dependencies (a dep-of-a-dep), which is exactly how the kernel reaches a consumer of `@trading-backtester/sdk`. So the published SDK — described in its own `package.json` as a **"Standalone … SDK"** — is in fact uninstallable from scratch. This surfaced with PR #50 (042 FU2, "re-source 017 schemas from @trading-platform/sdk kernel"), which made the kernel a runtime dependency.

## Goal

Make the published `@trading-backtester/sdk` tarball **self-contained**: a clean external consumer installs and uses it (runtime + types) with no `@trading-platform/sdk` transitive dependency. The existing clean-consumer check is the acceptance gate.

## Non-goals

- No change to `@trading-platform/sdk` (cross-repo; `043-exec-trust-model` is active there — any change would be worktree+speckit+gortex, out of scope here).
- No change to the SDK's **source** API surface or to 042's "kernel is the single source of truth" decision. The kernel stays the source of truth; only the **published build artifact** inlines it.
- No change to how the monorepo apps consume the kernel (they import it directly; unaffected).
- Not publishing the SDK in this slice — the fix makes the CI gate (build + pack + clean-consumer) green; an actual release follows the existing `sdk-release.yml` flow.

## Empirical findings (a spike validated the approach before this spec)

A throwaway build with `noExternal` + `dts.resolve` was run and inspected:

- **Runtime JS bundling WORKS.** `noExternal: [/^@trading-platform\/sdk/]` inlines the kernel runtime into `dist/*.js`; the only residual `@trading-platform` strings in `.js` are esbuild banner comments, not imports.
- **R2 — schema assets are read from disk at runtime.** The kernel's `validation/schema-assets.js` does `readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'schemas', '017', <file>))`. Bundling the JS does **not** carry the 5 JSON schema files. The bundled fs-read code lands in **both** `dist/contracts/index.js` **and** `dist/builder/index.js` (each resolves `import.meta.url` relative to itself), so the schemas must be copied next to **both** entrypoints.
- **R1 — tsup/rollup-dts does NOT inline subpath-exported types.** Neither `dts: { resolve: [regex] }` nor `dts: { resolve: true }` inlined the kernel types; `dist/contracts/index.d.ts` still `import`/`export`s from `@trading-platform/sdk/research-contract` and `@trading-platform/sdk/validation`. A consumer's `tsc` would fail to resolve them. A different dts-bundling tool that follows subpath exports is required.

These three facts drive the design below.

## Approach (chosen: A — bundle the kernel into the published SDK)

Rejected alternatives: **B (publish the kernel to a registry)** — clean runtime+types but cross-repo publish + consumer registry auth, and 043 is active in that repo; **C (relax `blockExoticSubdeps` in the check)** — hides the defect, real external consumers on default pnpm still fail.

## Architecture / changes

Only `packages/sdk` is touched. No SDK source-code changes; apps and the 394-test suite are unaffected (apps import the kernel directly, not via the published SDK).

### 1. Runtime bundling — `packages/sdk/tsup.config.ts`
- Add `noExternal: [/^@trading-platform\/sdk/]` → the kernel runtime (including subpaths `/validation`, `/research-contract`) is inlined into `dist/*.js`. (Spike-validated.)
- `decimal.js` stays **external** — it is a normal registry dependency (`^10.4.3`), not exotic, and consumers install it normally.

### 2. Type bundling (R1) — a dts tool that inlines subpath-exported external types
- tsup's built-in dts (rollup-dts) cannot inline `@trading-platform/sdk/research-contract` / `/validation` subpath types. Replace it with a dts-bundling step that **follows subpath exports and inlines the kernel types** into each entry's `.d.ts`.
- **Tool choice is deferred to a plan step**, not fixed here: candidates are **api-extractor** (`bundledPackages: ['@trading-platform/sdk']`) and **`rollup-plugin-dts`** (`respectExternal: true`). The plan tries both on the real 5 entrypoints (`index`, `contracts`, `builder`, `client`, `artifacts`) and picks the one whose output makes the clean-consumer `tsc --noEmit` (step 3) pass with no residual `@trading-platform/sdk` reference in any published `.d.ts`. Neither tool is currently in the repo, so adoption is part of the work.

### 3. Schema-asset copy (R2) — post-build step
- Add `scripts/copy-sdk-schemas.mjs`, run via tsup `onSuccess` (or chained in the SDK `build` script). It copies the 5 schema JSON files from the **installed kernel** — `node_modules/@trading-platform/sdk/dist/validation/schemas/017/*.json` — into **both** `dist/contracts/schemas/017/` and `dist/builder/schemas/017/`.
- Source of truth stays the kernel: the copy reads the pinned installed release, so there is no drift (042's invariant holds). `dist` is already in `files`, so the copied schemas ship in the tarball.
- The script fails loudly if the 5 expected files are not found (no silent partial copy).

### 4. `packages/sdk/package.json`
- Move `@trading-platform/sdk` from `dependencies` → `devDependencies` (the build needs it to bundle runtime + types + schemas; the published package no longer declares it).
- `decimal.js` stays in `dependencies`.
- Bump `version` `0.2.0` → `0.2.1` (the fixed packaging; current 0.2.0 is uninstallable).

## Verification (acceptance)

The existing `scripts/verify-sdk-clean-consumer.ts` is the acceptance gate; after the change all four steps pass in a temp consumer outside the workspace:

1. `pnpm install --lockfile-only` — no `ERR_PNPM_EXOTIC_SUBDEP` (no URL dep in the tarball).
2. `pnpm install --frozen-lockfile`.
3. `tsc --noEmit` on the smoke `.ts` — pins **R1** (all 5 entrypoint types resolve; no `@trading-platform/sdk` in published `.d.ts`).
4. `node smoke.mjs` — pins **R2** at runtime, including `allSchemaAssets().length === 5`, `createModuleManifest`, `computeInlineBundleHash`.

Plus:
- `pnpm sdk:verify` (tarball inspect) — valid composition; the package's `dependencies` no longer contains `@trading-platform/sdk`; the schema JSONs are present under `dist/`.
- `pnpm --filter @trading-backtester/sdk test` — the SDK's own tests stay green (bundling didn't break runtime).
- `pnpm check` (typecheck + 394 tests) — unaffected, run to confirm.
- `pnpm sdk:pack && tsx scripts/verify-sdk-clean-consumer.ts <tgz>` reproduces the CI gate locally — green.

## Risks & rollback

- **R1/R2 are de-risked** by the spike: runtime bundling proven; the two failure modes have concrete, located fixes (schema copy to 2 dirs; dts tool that inlines subpath types). The residual unknown is *which* dts tool — resolved by the plan step against criterion (3).
- Changes are confined to `packages/sdk` (`tsup.config.ts`, `package.json`, a new dts config, a new copy script). If neither dts tool can cleanly inline the subpath types across all 5 entrypoints, fall back to **Variant B (publish the kernel to a registry)** as a separate cross-repo project — but the spike makes that unlikely.

## Scope

A single focused plan: ~3–4 files in `packages/sdk` + the clean-consumer gate as the test. No decomposition.
