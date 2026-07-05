# Slice 6a — Platform BacktestRunner Lift Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lift trading-platform's full `runBacktest` engine (baseline + overlay-variant simulation, overlay composition, real comparison) into trading-backtester as a parallel, flag-gated path running through the trusted in-process executor, with real comparison flowing over HTTP and the platform `verify_018_*` golden-masters passing against the service — without touching the momentum path or its golden hash.

**Architecture:** Two run paths coexist behind a worker selector. The legacy momentum `runBacktest` stays byte-for-byte untouched; a sibling `runOverlayBacktest` (lifted engine) is added under `apps/backtester/src/engine/`. 017 contract types + JSON-schema assets go into the shared `@trading/research-contracts`; the ajv validation runtime + the 15-file runner live in the app. Determinism is guaranteed by reusing `src/determinism/{canonical-json,rng,hash}` verbatim and lifting `artifacts.ts` (the `RunOutcome` shape) intact, so overlay output is byte-identical to platform `runBacktest`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), pnpm workspaces, Fastify, vitest, ajv (draft-07), decimal.js, Postgres (existing), Docker (6b only — not here). Source of truth for the lift: `trading-platform/src/research/backtest/**`, `trading-platform/src/research/validation/**`, `trading-platform/contracts/research/**`, `trading-platform/scripts/verify_018_*.mjs`.

**Reference docs:** `docs/superpowers/specs/2026-06-17-slice-6a-runner-lift-design.md` (the approved spec), `docs/ARCHITECTURE.md` (§2 reuse map, §8 determinism, §10 rollout).

---

## Conventions for every task

- **Workspace commands run from repo root** (`/home/alexxxnikolskiy/projects/trading-backtester`).
- **Typecheck:** `pnpm typecheck`. **Tests:** `pnpm test` (vitest). To run one file: `pnpm --filter @trading-backtester/service test -- test/<file>.test.ts` (adjust filter to the actual service package name in `apps/backtester/package.json`).
- **ESM imports:** this codebase uses explicit `.js` specifiers in TS (`import { x } from './y.js'`). When lifting, every relative import must keep/gain a `.js` suffix. Cross-package imports use `@trading/research-contracts`.
- **The platform repo** is at `/home/alexxxnikolskiy/projects/trading-platform` (private, read-only reference). Lift = copy file, then rewrite imports to backtester paths; do **not** add a build dependency on the platform repo.
- **Never** edit `apps/backtester/src/runner/run-backtest.ts` (the momentum runner) or `apps/backtester/src/determinism/*` except where a task explicitly says so. The four momentum golden tests (`test/determinism.test.ts`, `test/api.e2e.test.ts`, `test/client.test.ts`, `test/data-api.test.ts`) must stay green after every task.
- **Golden hash to preserve:** `sha256:eff10116147933c96d92ae50071ef66339467fb69545c38855dcd50c2c0b43ba`.
- **Commit after every task.** Branch: `feat/slice-6a-runner-lift` (create at Task 0).

---

## File structure (what gets created / modified)

**`packages/research-contracts/` (shared types + assets — NO ajv):**
- Create `src/research/decision.ts`, `module.ts`, `context.ts`, `run.ts`, `catalogs.ts`, `indicators.ts`, `market-tape.ts`, `validation-codes.ts` — lifted 017 type modules.
- Create `schemas/017/*.json` — committed 017 JSON-schema assets.
- Modify `src/index.ts` — additive re-exports; reconcile `BacktestRunRequest` (signals ∪ 017, all-optional additions); add optional `comparison?: ComparisonSummary` to `RunResultSummary`.
- Modify `src/version.ts` (or wherever `CONTRACT_VERSION` lives) — add a `PLATFORM_CONTRACT_VERSION` lockstep constant + guard.

**`apps/backtester/src/engine/` (NEW — runner + validation runtime):**
- Create the 15 lifted engine files (see Task 5 list).
- Create `validation/index.ts`, `validation/schema-registry.ts` — lifted ajv runtime.
- Create `data-adapter.ts` — `CanonicalRowV2[]` → engine `MarketTapeDataset`.
- Create `index.ts` — exports `runOverlayBacktest`.

**`apps/backtester/src/` (wiring):**
- Modify `jobs/worker.ts` — engine selector on `request.engine`.
- Modify `jobs/submit.ts` and/or `api/server.ts` validation — reject `engine:'overlay'` when disabled (pre-queue `validation_error`).
- Modify `config.ts` — add `enableOverlayEngine` (default `false`).

**`packages/client/`:**
- Modify `src/wire.ts` — additive optional `comparison` on `RunResultSummary`.

**`apps/backtester/test/` (new tests):** `overlay-engine.test.ts`, `overlay-golden.test.ts`, `overlay-gating.test.ts`, `comparison-wire.test.ts`, `contract-merge-guard.test.ts`.

**`trading-platform/scripts/` (cross-repo gate — edited in the platform repo):** add HTTP-target mode to `verify_018_baseline.mjs`, `verify_018_overlay_variant.mjs`, `verify_018_determinism.mjs`.

---

## Task 0: Branch + orient

**Files:** none (git only).

- [ ] **Step 1: Create the feature branch**

Run: `git checkout -b feat/slice-6a-runner-lift` (from `design/slice-6a-runner-lift` or `main` — confirm with `git status` first).

- [ ] **Step 2: Confirm baseline is green**

Run: `pnpm install && pnpm typecheck && pnpm test`
Expected: PASS, including the four golden-hash tests. Record the momentum golden hash appears once per those tests.

- [ ] **Step 3: Capture the exact service package name**

Run: `node -p "require('./apps/backtester/package.json').name"`
Expected: prints the package name (e.g. `@trading-backtester/service`). Use it in all `pnpm --filter` commands below.

- [ ] **Step 4: Commit (no-op marker)** — skip if nothing changed; otherwise `git commit --allow-empty -m "chore(slice-6a): branch baseline green"`.

---

## Task 1: Lift the 017 contract TYPE modules into research-contracts

**Files:**
- Create: `packages/research-contracts/src/research/{decision,module,context,run,catalogs,indicators,market-tape,validation-codes}.ts`
- Reference (read-only): `trading-platform/contracts/research/{decision,module,context,run,catalogs,indicators,market-tape,validation}.ts`

- [ ] **Step 1: Copy the type modules**

For each file, copy from `trading-platform/contracts/research/<name>.ts` to `packages/research-contracts/src/research/<name>.ts`. These are **type-only** modules (no runtime logic). Rewrite any cross-module relative import to a sibling `./<name>.js` specifier. `validation.ts` → rename to `validation-codes.ts` (it holds `ValidationCode` types only; the ajv runtime is lifted separately in Task 4). Drop any import of the platform SDK that pulls runtime — `catalogs.ts`'s `platformContractContext` is data/const; keep it, but verify it imports no `market/`, `runtime/`, or `ccxt`.

- [ ] **Step 2: Wire exports**

Add to `packages/research-contracts/src/index.ts` (additive — do not remove existing exports):

```ts
export * from './research/decision.js';
export * from './research/module.js';
export * from './research/context.js';
export * from './research/run.js';
export * from './research/catalogs.js';
export * from './research/indicators.js';
export * from './research/market-tape.js';
export * from './research/validation-codes.js';
```

- [ ] **Step 3: Typecheck — expect collisions to surface**

Run: `pnpm --filter @trading/research-contracts typecheck` (or `pnpm typecheck`).
Expected: FAIL with duplicate-export / name-collision errors for any symbol the package already defines (likely `BacktestRunRequest`, `Ref`, `RunInfo`, `ContentHash`, `CONTRACT_VERSION`). This is the reconciliation surface — Task 2 resolves it. If there are **zero** collisions, note it and proceed.

- [ ] **Step 4: Commit**

```bash
git add packages/research-contracts/src/research packages/research-contracts/src/index.ts
git commit -m "feat(slice-6a): lift 017 contract type modules into research-contracts"
```

---

## Task 2: Reconcile `BacktestRunRequest` (signals ∪ 017, additive) + name collisions

**Files:**
- Modify: `packages/research-contracts/src/research/run.ts`, `packages/research-contracts/src/index.ts`, and the existing module that defines the signals-path `BacktestRunRequest` (find it).
- Test: `apps/backtester/test/contract-merge-guard.test.ts`

- [ ] **Step 1: Locate the existing request + collisions**

Run: `pnpm --filter @trading-backtester/service test -- --run` first to confirm baseline, then search for the existing definition:
Use gortex `search_symbols` for `BacktestRunRequest` in the `trading-backtester` repo. Record its current field set.

- [ ] **Step 2: Write the failing guardrail test**

Create `apps/backtester/test/contract-merge-guard.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { BacktestRunRequest } from '@trading/research-contracts';

describe('additive 017 contract merge', () => {
  it('still accepts the legacy signals request shape unchanged', () => {
    // The exact shape the README curl / existing e2e submits today.
    const legacy: BacktestRunRequest = {
      mode: 'research',
      moduleRef: { id: 'smoke', version: '1.0.0' },
      datasetRef: 'smoke-btc-1m',
      symbols: ['BTCUSDT'],
      timeframe: '1m',
      period: { from: '2023-11-14T00:00:00.000Z', to: '2023-11-15T00:00:00.000Z' },
      seed: 42,
      metrics: [],
    };
    expect(legacy.seed).toBe(42);
    // engine is optional and defaults to momentum at the selector, absent here:
    expect((legacy as { engine?: string }).engine).toBeUndefined();
  });

  it('accepts an explicit overlay-engine request', () => {
    const overlay: BacktestRunRequest = {
      mode: 'research',
      moduleRef: { id: 'smoke', version: '1.0.0' },
      datasetRef: 'smoke-btc-1m',
      symbols: ['BTCUSDT'],
      timeframe: '1m',
      period: { from: '2023-11-14T00:00:00.000Z', to: '2023-11-15T00:00:00.000Z' },
      seed: 42,
      metrics: [],
      engine: 'overlay',
    };
    expect(overlay.engine).toBe('overlay');
  });
});
```

- [ ] **Step 3: Run it — expect compile failure**

Run: `pnpm --filter @trading-backtester/service test -- test/contract-merge-guard.test.ts`
Expected: FAIL — `engine` not on the type, and/or duplicate `BacktestRunRequest`.

- [ ] **Step 4: Merge the request type additively**

In `run.ts`, define one `BacktestRunRequest` that is the **superset**: keep every existing signals-path field, add every 017 field as **optional**, and add `engine?: 'momentum' | 'overlay'`. Remove the duplicate definition from the old location and re-export the unified one from `index.ts`. Resolve other collisions (`Ref`, `RunInfo`, `ContentHash`, `CONTRACT_VERSION`) by keeping a single canonical definition and deleting/aliasing duplicates (prefer the existing package's `ContentHash`/`CONTRACT_VERSION`; prefer the 017 `Ref`/`RunInfo`). Add the discriminator type:

```ts
export type BacktestEngine = 'momentum' | 'overlay';
```

- [ ] **Step 5: Run typecheck + the guard test**

Run: `pnpm typecheck && pnpm --filter @trading-backtester/service test -- test/contract-merge-guard.test.ts`
Expected: PASS. Then run the **four golden tests** to prove the momentum request still submits: `pnpm --filter @trading-backtester/service test -- test/determinism.test.ts test/api.e2e.test.ts`
Expected: PASS, golden hash unchanged.

- [ ] **Step 6: Commit**

```bash
git add packages/research-contracts apps/backtester/test/contract-merge-guard.test.ts
git commit -m "feat(slice-6a): reconcile BacktestRunRequest additively (signals ∪ 017) + engine discriminator"
```

---

## Task 3: Commit the 017 JSON-schema assets + CONTRACT_VERSION lockstep guard

**Files:**
- Create: `packages/research-contracts/schemas/017/*.json` (copy the committed schema files from `trading-platform/src/research/validation/` or wherever the platform stores them — find via gortex `search_text` for `SCHEMA_IDS` / `.json` schema ids).
- Modify: `packages/research-contracts/src/research/catalogs.ts` (export `SCHEMA_IDS` if not already), `packages/research-contracts/src/index.ts`.
- Test: `apps/backtester/test/contract-merge-guard.test.ts` (extend).

- [ ] **Step 1: Copy schema files**

Copy every 017 strategy-decision / run-request / module-manifest schema JSON into `packages/research-contracts/schemas/017/`. Ensure the package `files`/`exports` in `package.json` include the `schemas/` dir so it ships. Add a typed loader (`export function schemaAsset(id: string): object`) that reads from the package dir (resolved relative to the module, ESM `import.meta.url` + `node:fs`), OR import them as JSON modules if the build supports `resolveJsonModule`.

- [ ] **Step 2: Write the lockstep guard test**

Append to `contract-merge-guard.test.ts`:

```ts
import { CONTRACT_VERSION, PLATFORM_CONTRACT_VERSION } from '@trading/research-contracts';

it('CONTRACT_VERSION is in lockstep with the platform anchor', () => {
  expect(CONTRACT_VERSION).toBe(PLATFORM_CONTRACT_VERSION);
});
```

- [ ] **Step 3: Run — expect failure**

Run: `pnpm --filter @trading-backtester/service test -- test/contract-merge-guard.test.ts`
Expected: FAIL — `PLATFORM_CONTRACT_VERSION` not exported.

- [ ] **Step 4: Add the lockstep constant**

In research-contracts, add `export const PLATFORM_CONTRACT_VERSION = '017.x';` (use the exact value from `trading-platform` `CONTRACT_VERSION`, found via gortex). Keep the existing `CONTRACT_VERSION` as the package's own; the test asserts equality so a future drift fails loudly.

- [ ] **Step 5: Run — expect pass**

Run: `pnpm --filter @trading-backtester/service test -- test/contract-merge-guard.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/research-contracts
git commit -m "feat(slice-6a): commit 017 schema assets + CONTRACT_VERSION lockstep guard"
```

---

## Task 4: Lift the ajv validation runtime into the app

**Files:**
- Create: `apps/backtester/src/engine/validation/index.ts`, `apps/backtester/src/engine/validation/schema-registry.ts`
- Reference: `trading-platform/src/research/validation/{index,schema-registry}.ts`
- Modify: `apps/backtester/package.json` (add `ajv` dep if absent — match the platform's major version, draft-07).

- [ ] **Step 1: Add ajv**

Run: `pnpm --filter @trading-backtester/service add ajv@<platform-version>` (find the platform's ajv version in `trading-platform/package.json`).

- [ ] **Step 2: Copy + rewrite the runtime**

Copy both files into `apps/backtester/src/engine/validation/`. Rewrite imports: schema **assets** come from `@trading/research-contracts` (the `schemaAsset(...)` loader / `SCHEMA_IDS` from Task 3); type imports come from `@trading/research-contracts`. Keep the memoized `createSchemaRegistry()` singleton semantics intact.

- [ ] **Step 3: Smoke test the validator compiles**

Create `apps/backtester/test/overlay-engine.test.ts` with a first smoke test:

```ts
import { describe, expect, it } from 'vitest';
import { createSchemaRegistry, SCHEMA_IDS } from '../src/engine/validation/schema-registry.js';

describe('lifted validation runtime', () => {
  it('compiles the 017 schema registry', () => {
    const reg = createSchemaRegistry();
    expect(typeof reg.validateRef).toBe('function');
    expect(SCHEMA_IDS['strategy-decision']).toBeTruthy();
  });
});
```

- [ ] **Step 4: Run**

Run: `pnpm --filter @trading-backtester/service test -- test/overlay-engine.test.ts`
Expected: PASS (registry compiles, schemas resolve from the package).

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/engine/validation apps/backtester/test/overlay-engine.test.ts apps/backtester/package.json pnpm-lock.yaml
git commit -m "feat(slice-6a): lift ajv 017 validation runtime into src/engine/validation"
```

---

## Task 5: Lift the 15-file engine into `src/engine/` (reuse determinism)

**Files:**
- Create under `apps/backtester/src/engine/`: `runner.ts`, `overlay.ts`, `module-executor.ts`, `artifacts.ts`, `context.ts`, `execution.ts`, `market-tape.ts`, `metrics.ts`, `portfolio.ts`, `profiles.ts`, `protection.ts`, `registry.ts`, `risk.ts`, and a pure-helpers extract `dataset-helpers.ts`.
- Reference: `trading-platform/src/research/backtest/*.ts`

- [ ] **Step 1: Copy the engine files**

Copy each of the above from `trading-platform/src/research/backtest/`. **Do NOT copy** `rng.ts` or any canonical-json. From `dataset.ts`, copy **only** the pure helpers (`indicatorAsOf`, `smaAsOf`, `pointInTimeDataApi`, `indicatorApiFor`, `closedCandles`) into `dataset-helpers.ts`; **omit** `loadCandleDataset`, `findRepoRoot`, `defaultCandleFixturesDir` (filesystem).

- [ ] **Step 2: Rewrite imports**

In every copied file:
- `../../contracts/research/<x>.js` → `@trading/research-contracts`.
- `../validation/index.js` → `./validation/index.js`; `../validation/schema-registry.js` → `./validation/schema-registry.js`.
- `./rng.js` → `../determinism/rng.js` (the reused mulberry32).
- Any canonical-json import → `../determinism/canonical-json.js`.
- `../sandbox/sandbox-policy.js` (type-only, 019) → **delete** the import and the `sandboxPolicyRef?` / `sandboxPolicies?` / `router?` fields from `RunDeps` for 6a (trusted only). Keep `executor?` and the `createTrustedRouter` path. Leave a `// 6b: sandbox router seam re-added here` comment.
- Drop `marketTapeFromCanonicalRows`' dependency on any platform canonical reader; it should accept already-parsed `CanonicalRowV2[]` (the backtester's contract type from research-contracts).

- [ ] **Step 3: Verify the rng + canonical parity assumption**

Open `trading-platform/src/research/backtest/rng.ts` and `apps/backtester/src/determinism/rng.ts`. Confirm both are mulberry32 with identical seed mixing. Open `context.ts`'s per-symbol seeding and confirm the seed derivation (per-symbol) is reproduced exactly against `../determinism/rng`. If they differ in any constant, STOP and surface it — this is the parity linchpin (spec §5, §10).

- [ ] **Step 4: Typecheck the engine compiles**

Run: `pnpm typecheck`
Expected: PASS (no unresolved imports; sandbox types removed cleanly).

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/engine
git commit -m "feat(slice-6a): lift 15-file backtest engine into src/engine (rng/canonical reused from determinism)"
```

---

## Task 6: Data adapter — `CanonicalRowV2[]` → engine `MarketTapeDataset`

**Files:**
- Create: `apps/backtester/src/engine/data-adapter.ts`
- Reference: `apps/backtester/src/data/reader.ts` (`materialize`, `datasetFingerprint`), `apps/backtester/src/engine/market-tape.ts` (`marketTapeFromCanonicalRows`).
- Test: `apps/backtester/test/overlay-engine.test.ts` (extend).

- [ ] **Step 1: Write the failing adapter test**

Append to `overlay-engine.test.ts`:

```ts
import { buildOverlayDataset } from '../src/engine/data-adapter.js';
import { FixtureDataPort } from '../src/data/reader.js';
import { FIXTURES_DIR } from './helpers.js';

it('materializes an engine MarketTapeDataset from the fixture data port', async () => {
  const port = new FixtureDataPort(FIXTURES_DIR);
  const ds = await buildOverlayDataset(port, {
    datasetRef: 'smoke-btc-1m',
    symbols: ['BTCUSDT'],
    timeframe: '1m',
    period: { from: '2023-11-14T00:00:00.000Z', to: '2023-11-15T00:00:00.000Z' },
  });
  expect(ds.symbols()).toContain('BTCUSDT');
  expect(ds.candles('BTCUSDT').length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run — expect failure**

Run: `pnpm --filter @trading-backtester/service test -- test/overlay-engine.test.ts`
Expected: FAIL — `buildOverlayDataset` not defined.

- [ ] **Step 3: Implement the adapter**

In `data-adapter.ts`, stream `CanonicalRowV2[]` from the port (reuse the existing `materialize` pathway used by the momentum runner so the row set + ordering is identical), then pass the rows to `marketTapeFromCanonicalRows(...)` to build the engine `MarketTapeDataset`. Return it. Signature:

```ts
import type { BacktesterDataPort, CanonicalRowV2 } from '@trading/research-contracts';
import { marketTapeFromCanonicalRows, type MarketTapeDataset } from './market-tape.js';

export interface OverlayDatasetSelector {
  datasetRef: string;
  symbols: readonly string[];
  timeframe: string;
  period: { from: string; to: string };
}

export async function buildOverlayDataset(
  port: BacktesterDataPort,
  sel: OverlayDatasetSelector,
): Promise<MarketTapeDataset> {
  // reuse the same row collection the momentum path uses, then:
  const rows: CanonicalRowV2[] = await collectRows(port, sel); // mirror src/data materialize
  return marketTapeFromCanonicalRows(rows, { timeframe: sel.timeframe });
}
```

(Implement `collectRows` against the actual `BacktesterDataPort` / `materialize` API found in `src/data/reader.ts`; keep batching/back-pressure identical to the momentum path.)

- [ ] **Step 4: Run — expect pass**

Run: `pnpm --filter @trading-backtester/service test -- test/overlay-engine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/engine/data-adapter.ts apps/backtester/test/overlay-engine.test.ts
git commit -m "feat(slice-6a): data adapter — CanonicalRowV2[] to engine MarketTapeDataset"
```

---

## Task 7: `runOverlayBacktest` entrypoint + trusted registry + parity fixtures

**Files:**
- Create: `apps/backtester/src/engine/index.ts` (`runOverlayBacktest`), `apps/backtester/test/fixtures/overlay/` (lifted modules + `baseline.json` + `variant.json`).
- Reference: `trading-platform/src/research/backtest/runner.ts`, `trading-platform/specs/018-research-backtest-runner/fixtures/requests/{baseline,variant}.json`, the platform example modules `shortAfterPump` / `earlyExitShortAfterPump` (find via gortex `search_symbols`).
- Test: `apps/backtester/test/overlay-engine.test.ts` (extend).

- [ ] **Step 1: Lift the example modules + request fixtures**

Copy `shortAfterPump` (strategy) and `earlyExitShortAfterPump` (overlay) module sources into `apps/backtester/test/fixtures/overlay/modules/`, rewriting their contract imports to `@trading/research-contracts`. Copy `baseline.json` and `variant.json` request fixtures into `apps/backtester/test/fixtures/overlay/requests/`. Adjust `datasetRef`/`symbols`/`period` only if needed to match the backtester's smoke fixture; **note any change** — it shifts the golden (Task 9 derives goldens from the platform with the *same* inputs, so prefer keeping platform inputs and adding a matching dataset fixture if necessary).

- [ ] **Step 2: Write `runOverlayBacktest`**

In `apps/backtester/src/engine/index.ts`:

```ts
import { runBacktest as runEngine } from './runner.js';
import { createTrustedRegistry } from './registry.js';
import type { BacktestRunRequest } from '@trading/research-contracts';
import type { MarketTapeDataset } from './market-tape.js';
import type { TrustedModuleRegistry } from './registry.js';
import type { RunOutcome } from './artifacts.js';

export interface OverlayRunDeps {
  registry: TrustedModuleRegistry;
  marketTape?: MarketTapeDataset;
}

export function runOverlayBacktest(request: BacktestRunRequest, deps: OverlayRunDeps): RunOutcome {
  return runEngine(request, { registry: deps.registry, marketTape: deps.marketTape });
}

export type { RunOutcome } from './artifacts.js';
export { createTrustedRegistry } from './registry.js';
```

- [ ] **Step 3: Write the end-to-end engine test (baseline + variant)**

Append to `overlay-engine.test.ts` a test that builds the trusted registry from the lifted modules + `DEFAULT_RISK`/`DEFAULT_EXEC`, materializes the dataset (Task 6), and runs `runOverlayBacktest` for `baseline.json` (no overlay) and `variant.json` (with overlay):

```ts
it('runs baseline (no overlay) and overlay-variant, producing a comparison', async () => {
  const registry = buildTrustedTestRegistry(); // helper that wires the lifted modules + profiles
  const ds = await buildOverlayDataset(new FixtureDataPort(FIXTURES_DIR), selFromVariant());
  const baseline = runOverlayBacktest(loadRequest('baseline.json'), { registry, marketTape: ds });
  const variant = runOverlayBacktest(loadRequest('variant.json'), { registry, marketTape: ds });
  expect(baseline.status).toBe('completed');
  expect(variant.status).toBe('completed');
  if (variant.status === 'completed') {
    expect(variant.variant).toBeDefined();
    expect(variant.comparison).toBeDefined();
  }
});
```

- [ ] **Step 4: Run**

Run: `pnpm --filter @trading-backtester/service test -- test/overlay-engine.test.ts`
Expected: PASS — baseline has no variant/comparison; variant has both.

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/engine/index.ts apps/backtester/test/fixtures/overlay apps/backtester/test/overlay-engine.test.ts
git commit -m "feat(slice-6a): runOverlayBacktest + trusted registry + lifted 018 parity fixtures"
```

---

## Task 8: Zero-overlays edge case (impl note 1)

**Files:**
- Modify: `apps/backtester/src/engine/index.ts` (or the summary projection in Task 11) — define the contract.
- Test: `apps/backtester/test/overlay-engine.test.ts` (extend).

- [ ] **Step 1: Write the failing edge-case test**

```ts
it('overlay engine with zero overlays: comparison undefined, headline = baseline', async () => {
  const registry = buildTrustedTestRegistry();
  const ds = await buildOverlayDataset(new FixtureDataPort(FIXTURES_DIR), selFromBaseline());
  const out = runOverlayBacktest(loadRequest('baseline.json'), { registry, marketTape: ds });
  expect(out.status).toBe('completed');
  if (out.status === 'completed') {
    expect(out.variant).toBeUndefined();
    expect(out.comparison).toBeUndefined();
    // headline metrics fall back to baseline (asserted at the summary layer in Task 11):
    expect(out.baseline.metrics).toBeDefined();
  }
});
```

- [ ] **Step 2: Run — confirm the engine already satisfies it (lifted behavior)**

Run: `pnpm --filter @trading-backtester/service test -- test/overlay-engine.test.ts`
Expected: PASS if the lifted `runBacktest` already returns `variant`/`comparison` undefined when no overlays resolve. If it does **not**, add a guard in `runOverlayBacktest` that normalizes to `{ baseline, variant: undefined, comparison: undefined }`. Document the chosen contract (undefined vs degenerate) in a code comment referencing spec impl-note 1.

- [ ] **Step 3: Commit**

```bash
git add apps/backtester/src/engine apps/backtester/test/overlay-engine.test.ts
git commit -m "feat(slice-6a): define + test overlay-engine zero-overlays edge case (headline=baseline, comparison undefined)"
```

---

## Task 9: Platform-derived overlay goldens (impl note 2)

**Files:**
- Create: `apps/backtester/test/overlay-golden.test.ts`, `apps/backtester/test/fixtures/overlay/goldens/{baseline,variant}.hash`
- Tool: a one-off script `scripts/derive-overlay-goldens.mjs` (in trading-platform OR a cross-repo invocation) that runs the **platform** `runBacktest` and emits `contentRef(out)` via the shared canonical-json lineage.

- [ ] **Step 1: Derive the goldens from the PLATFORM (never from backtester output)**

In `trading-platform`, after `npm run build`, run a script that imports `dist/src/research/backtest/index.js`, runs `runBacktest` for `baseline.json` and `variant.json` with the same trusted registry, and prints `sha256(canonicalJson(out))`. The canonical-json MUST be byte-identical to the backtester's `src/determinism/canonical-json` (verify by diffing the two implementations or by hashing a shared sample). Save the two hashes into `apps/backtester/test/fixtures/overlay/goldens/`. **These are the source of truth — the backtester must match them, not vice versa** (spec impl-note 2).

- [ ] **Step 2: Write the golden pin test**

Create `overlay-golden.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { contentRef } from '../src/determinism/hash.js';
import { runOverlayBacktest } from '../src/engine/index.js';
// ... build registry + dataset as in Task 7

const GOLDEN_BASELINE = readFileSync(new URL('./fixtures/overlay/goldens/baseline.hash', import.meta.url), 'utf8').trim();
const GOLDEN_VARIANT  = readFileSync(new URL('./fixtures/overlay/goldens/variant.hash', import.meta.url), 'utf8').trim();

describe('overlay path matches platform-derived goldens', () => {
  it('baseline result_hash equals the platform golden', async () => {
    const out = runOverlayBacktest(loadRequest('baseline.json'), await deps());
    expect(contentRef(out)).toBe(GOLDEN_BASELINE);
  });
  it('variant result_hash equals the platform golden', async () => {
    const out = runOverlayBacktest(loadRequest('variant.json'), await deps());
    expect(contentRef(out)).toBe(GOLDEN_VARIANT);
  });
});
```

- [ ] **Step 3: Run — iterate until byte-identical**

Run: `pnpm --filter @trading-backtester/service test -- test/overlay-golden.test.ts`
Expected: initially may FAIL. If so, the divergence is a parity bug (rng seeding, canonical quantization, field ordering, or a fixture input mismatch). Debug by diffing `canonicalJson(out)` against the platform's `canonicalJson(out)` and finding the first divergent character (the same technique `verify_018_determinism` uses). Fix in the engine lift (NOT by re-freezing the golden). PASS when both match.

- [ ] **Step 4: Add the run-vs-replay byte-identity test**

Append:

```ts
it('overlay output is byte-identical on replay', async () => {
  const a = runOverlayBacktest(loadRequest('variant.json'), await deps());
  const b = runOverlayBacktest(loadRequest('variant.json'), await deps());
  expect(contentRef(a)).toBe(contentRef(b));
});
```

Run and expect PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/test/overlay-golden.test.ts apps/backtester/test/fixtures/overlay/goldens
git commit -m "feat(slice-6a): pin platform-derived overlay goldens + run-vs-replay byte-identity"
```

---

## Task 10: Additive `comparison` block on the wire (contracts + client)

**Files:**
- Modify: `packages/research-contracts/src/index.ts` (or the module defining `RunResultSummary`), `packages/client/src/wire.ts`
- Test: `apps/backtester/test/comparison-wire.test.ts`

- [ ] **Step 1: Write the failing round-trip test (WITH and WITHOUT comparison)**

Create `comparison-wire.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { RunResultSummary, ComparisonSummary } from '@trading/research-contracts';

describe('RunResultSummary.comparison (additive, optional)', () => {
  it('momentum result has comparison undefined and round-trips', () => {
    const s: RunResultSummary = {
      runId: 'r1', status: 'completed', metrics: { pnl: 1 },
      artifactRefs: [], evidence: {} as RunResultSummary['evidence'],
    };
    const wire = JSON.parse(JSON.stringify(s)) as RunResultSummary;
    expect(wire.comparison).toBeUndefined();
    expect(wire.metrics.pnl).toBe(1);
  });

  it('overlay result carries a populated comparison and round-trips', () => {
    const comparison: ComparisonSummary = {
      baseline: { pnl: 1 }, variant: { pnl: 2 },
      variants: [{ metricDeltas: [{ metric: 'pnl', delta: 1 }], tradeOutcomeChanged: true }],
    } as ComparisonSummary;
    const s: RunResultSummary = {
      runId: 'r2', status: 'completed', metrics: { pnl: 2 },
      artifactRefs: [], evidence: {} as RunResultSummary['evidence'], comparison,
    };
    const wire = JSON.parse(JSON.stringify(s)) as RunResultSummary;
    expect(wire.comparison?.variant.pnl).toBe(2);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `pnpm --filter @trading-backtester/service test -- test/comparison-wire.test.ts`
Expected: FAIL — `comparison` / `ComparisonSummary` not exported.

- [ ] **Step 3: Add the optional field in BOTH places**

In research-contracts, add `comparison?: ComparisonSummary;` to `RunResultSummary` and export `ComparisonSummary` (re-export from `./research/artifacts-comparison.ts` — lift just the `ComparisonSummary` / `ComparisonVariant` / `MetricDelta` / `OverlayEffectsSummary` types from the engine's `artifacts.ts` into a contracts-side type module, since the wire needs them but they currently live app-side). In `packages/client/src/wire.ts`, mirror the **optional** field and the types. Keep both optional — momentum leaves it undefined.

- [ ] **Step 4: Run client + contracts parity guard**

Run: `pnpm --filter @trading-backtester/service test -- test/comparison-wire.test.ts && pnpm typecheck`
Expected: PASS, and the existing compile-time client↔contracts parity guard stays green (it catches drift between wire.ts and contracts).

- [ ] **Step 5: Run the existing client golden test**

Run: `pnpm --filter @trading-backtester/service test -- test/client.test.ts`
Expected: PASS — momentum golden + client unaffected.

- [ ] **Step 6: Commit**

```bash
git add packages/research-contracts packages/client apps/backtester/test/comparison-wire.test.ts
git commit -m "feat(slice-6a): additive optional comparison block on RunResultSummary (contracts + client)"
```

---

## Task 11: Summary projection — map `RunOutcome` → `RunResultSummary`

**Files:**
- Create/Modify: the worker's result-summary builder (find where momentum builds `RunResultSummary` today, likely `jobs/worker.ts` or a `jobs/summary.ts`).
- Test: `apps/backtester/test/overlay-engine.test.ts` (extend).

- [ ] **Step 1: Write the failing projection test**

```ts
import { toRunResultSummary } from '../src/jobs/summary.js'; // or wherever momentum projects today

it('projects overlay RunOutcome: headline=variant, comparison populated', async () => {
  const out = runOverlayBacktest(loadRequest('variant.json'), await deps());
  const summary = toOverlaySummary(out, 'r2'); // new projector
  expect(summary.metrics).toEqual(asRecord(out.status === 'completed' && out.variant?.metrics));
  expect(summary.comparison).toBeDefined();
});

it('projects zero-overlay RunOutcome: headline=baseline, comparison undefined', async () => {
  const out = runOverlayBacktest(loadRequest('baseline.json'), await deps());
  const summary = toOverlaySummary(out, 'r1');
  expect(summary.comparison).toBeUndefined();
});
```

- [ ] **Step 2: Run — expect failure**

Run: `pnpm --filter @trading-backtester/service test -- test/overlay-engine.test.ts`
Expected: FAIL — `toOverlaySummary` not defined.

- [ ] **Step 3: Implement the projector**

Add `toOverlaySummary(out: RunOutcome, runId: string): RunResultSummary`: headline `metrics` = `variant.metrics` when present else `baseline.metrics`; `comparison` = `out.comparison` (undefined when no variant); `artifactRefs` from the chosen result; `evidence` from the chosen result. Keep the momentum projector untouched.

- [ ] **Step 4: Run — expect pass**

Run: `pnpm --filter @trading-backtester/service test -- test/overlay-engine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/jobs apps/backtester/test/overlay-engine.test.ts
git commit -m "feat(slice-6a): project overlay RunOutcome to RunResultSummary (headline + comparison)"
```

---

## Task 12: Config flag `enableOverlayEngine` (default off)

**Files:**
- Modify: `apps/backtester/src/config.ts` (`AppConfig`, `loadConfig`)
- Test: `apps/backtester/test/overlay-gating.test.ts`

- [ ] **Step 1: Write the failing config test**

Create `overlay-gating.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('enableOverlayEngine flag', () => {
  it('defaults to false', () => {
    expect(loadConfig({}).enableOverlayEngine).toBe(false);
  });
  it('parses BACKTESTER_ENABLE_OVERLAY_ENGINE=true', () => {
    expect(loadConfig({ BACKTESTER_ENABLE_OVERLAY_ENGINE: 'true' }).enableOverlayEngine).toBe(true);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `pnpm --filter @trading-backtester/service test -- test/overlay-gating.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add the flag**

Add `enableOverlayEngine: boolean` to `AppConfig`; in `loadConfig`, `enableOverlayEngine: env.BACKTESTER_ENABLE_OVERLAY_ENGINE === 'true'` (default false). Document the env var.

- [ ] **Step 4: Run — expect pass**

Run: `pnpm --filter @trading-backtester/service test -- test/overlay-gating.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/config.ts apps/backtester/test/overlay-gating.test.ts
git commit -m "feat(slice-6a): add enableOverlayEngine config flag (default off)"
```

---

## Task 13: Pre-queue validation — reject `engine:'overlay'` when disabled

**Files:**
- Modify: `apps/backtester/src/jobs/submit.ts` (or the validation in `api/server.ts` `POST /v1/runs` path).
- Test: `apps/backtester/test/overlay-gating.test.ts` (extend).

- [ ] **Step 1: Write the failing test**

```ts
import { buildTestApp } from './helpers.js';

it('rejects an overlay request with validation_error when the engine is off', async () => {
  const app = await buildTestApp({ enableOverlayEngine: false });
  const res = await app.inject({
    method: 'POST', url: '/v1/runs',
    headers: { authorization: 'Bearer dev-token', 'content-type': 'application/json' },
    payload: { ...baseRequest(), engine: 'overlay' },
  });
  expect(res.statusCode).toBe(400);
  expect(res.json().code).toBe('validation_error');
});

it('accepts a momentum request unchanged when the engine is off', async () => {
  const app = await buildTestApp({ enableOverlayEngine: false });
  const res = await app.inject({
    method: 'POST', url: '/v1/runs',
    headers: { authorization: 'Bearer dev-token', 'content-type': 'application/json' },
    payload: baseRequest(), // no engine field
  });
  expect(res.statusCode).toBe(202);
});
```

- [ ] **Step 2: Run — expect failure**

Run: `pnpm --filter @trading-backtester/service test -- test/overlay-gating.test.ts`
Expected: FAIL — overlay request currently 202s or errors differently.

- [ ] **Step 3: Implement the gate**

In `submitRun` validation (before persisting/enqueuing): if `request.engine === 'overlay' && !config.enableOverlayEngine`, return a `SubmitError` mapped to `400` + `{ category, code: 'validation_error', message: 'overlay engine is disabled' }`. Momentum/absent `engine` path unchanged.

- [ ] **Step 4: Run — expect pass**

Run: `pnpm --filter @trading-backtester/service test -- test/overlay-gating.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/jobs apps/backtester/src/api apps/backtester/test/overlay-gating.test.ts
git commit -m "feat(slice-6a): reject overlay requests pre-queue with validation_error when flag off"
```

---

## Task 14: Worker selector — route momentum vs overlay

**Files:**
- Modify: `apps/backtester/src/jobs/worker.ts` (`processNextQueued`; build the trusted registry + dataset for overlay runs).
- Test: `apps/backtester/test/overlay-engine.test.ts` (extend with an e2e through the worker).

- [ ] **Step 1: Write the failing e2e-through-worker test**

```ts
it('worker runs an overlay job end-to-end and stores comparison + resultHash', async () => {
  const app = await buildTestApp({ enableOverlayEngine: true });
  const handle = await submitOverlayVariant(app);     // POST /v1/runs engine:'overlay'
  await drainWorker(app);                             // existing test drain helper
  const result = await getResult(app, handle.runId);  // GET /v1/runs/:id/result
  expect(result.status).toBe('completed');
  expect(result.comparison).toBeDefined();
  expect(result.resultHash).toBe(GOLDEN_VARIANT);     // platform-derived golden
});
```

- [ ] **Step 2: Run — expect failure**

Run: `pnpm --filter @trading-backtester/service test -- test/overlay-engine.test.ts`
Expected: FAIL — worker doesn't route overlay yet.

- [ ] **Step 3: Implement the selector**

In `processNextQueued`: branch on `job.request.engine`. `'overlay'` → build the trusted registry (from the configured trusted modules) + `buildOverlayDataset(dataPort, sel)` → `runOverlayBacktest(...)` → `toOverlaySummary(...)`; persist artifacts (incl. decision-records + comparison) via the existing artifact store; `resultHash = contentRef(runOutcome)`. `'momentum'`/absent → the existing path, **unchanged**. Keep the `executorFor` (bundleHash) sandbox axis intact and orthogonal (it stays for 6b; overlay 6a uses the trusted registry only).

- [ ] **Step 4: Run — expect pass**

Run: `pnpm --filter @trading-backtester/service test -- test/overlay-engine.test.ts`
Expected: PASS — overlay e2e green, resultHash matches the platform golden through the full HTTP+worker path.

- [ ] **Step 5: Full regression**

Run: `pnpm typecheck && pnpm test`
Expected: PASS — all four momentum goldens unchanged, all new tests green.

- [ ] **Step 6: Commit**

```bash
git add apps/backtester/src/jobs apps/backtester/test/overlay-engine.test.ts
git commit -m "feat(slice-6a): worker selector routes momentum vs overlay engine (trusted)"
```

---

## Task 15: Momentum byte-identical guardrail (impl note / guardrail)

**Files:**
- Test: `apps/backtester/test/contract-merge-guard.test.ts` (extend).

- [ ] **Step 1: Add the explicit byte-identity guard**

Append a test that runs the momentum path and asserts the golden hash AND that the metrics object serializes byte-identically to a frozen snapshot — proving the additive 017 merge did not perturb momentum output:

```ts
import { runBacktest } from '../src/runner/run-backtest.js';
import { contentRef } from '../src/determinism/hash.js';
import { canonicalJson } from '../src/determinism/canonical-json.js';

it('momentum result_hash + metrics bytes are unchanged after the 017 merge', async () => {
  const result = await runMomentumSmoke(); // the exact seed:42 smoke request used by determinism.test.ts
  expect(contentRef(result)).toBe('sha256:eff10116147933c96d92ae50071ef66339467fb69545c38855dcd50c2c0b43ba');
  expect(canonicalJson(result.metrics)).toMatchSnapshot(); // freezes the metrics byte layout
});
```

- [ ] **Step 2: Run — expect pass (or create the snapshot once)**

Run: `pnpm --filter @trading-backtester/service test -- test/contract-merge-guard.test.ts`
Expected: PASS; golden hash matches; snapshot created/stable.

- [ ] **Step 3: Commit**

```bash
git add apps/backtester/test
git commit -m "test(slice-6a): guard momentum result_hash + metrics bytes unchanged post-merge"
```

---

## Task 16: HTTP-target mode for the platform `verify_018_*` scripts (cross-repo gate)

**Files (in the `trading-platform` repo):**
- Modify: `scripts/verify_018_baseline.mjs`, `scripts/verify_018_overlay_variant.mjs`, `scripts/verify_018_determinism.mjs`
- Create: `scripts/lib/verify_018_http_target.mjs` (shared submit→poll→result helper)

- [ ] **Step 1: Write the HTTP target helper**

Create `scripts/lib/verify_018_http_target.mjs`: given `BACKTESTER_BASE_URL` + bearer token, POST `/v1/runs` (engine:'overlay'), poll `/v1/runs/:id/status` to terminal, GET `/v1/runs/:id/result`. Return `{ resultSummary }` including `resultHash` + `comparison`. Reuse/import the same `canonicalJson` lineage to compute the **expected** hash from the in-process `runBacktest(request,{registry})` so the gate compares `contentRef(in_process_out)` to the service's `resultHash`.

- [ ] **Step 2: Add the target switch to each script**

In each of the three scripts, gate on `process.env.VERIFY_018_TARGET`:
- `inprocess` (default, unchanged) — existing `runBacktest(request,{registry})` + existing assertions.
- `http` — call the helper; assert `service.resultHash === contentRef(inProcessOut)`; for `overlay_variant`, additionally assert the service `comparison` block has ≥1 non-zero `metricDeltas` entry and `tradeOutcomeChanged === true`; for `determinism`, submit the same request twice and assert equal `resultHash` (run-vs-replay over HTTP).

- [ ] **Step 3: Run in-process mode (must stay green — no regression on the platform)**

Run (in `trading-platform`): `npm run build && node scripts/verify_018_overlay_variant.mjs`
Expected: `verify_018_overlay_variant: OK` (default in-process path unchanged).

- [ ] **Step 4: Run HTTP mode against the live service**

In `trading-backtester`: `BACKTESTER_ENABLE_OVERLAY_ENGINE=true pnpm start` (terminal 1). In `trading-platform` (terminal 2):
```bash
VERIFY_018_TARGET=http BACKTESTER_BASE_URL=http://127.0.0.1:8080 BACKTESTER_AUTH_TOKEN=dev-token \
  node scripts/verify_018_baseline.mjs && \
VERIFY_018_TARGET=http BACKTESTER_BASE_URL=http://127.0.0.1:8080 BACKTESTER_AUTH_TOKEN=dev-token \
  node scripts/verify_018_overlay_variant.mjs && \
VERIFY_018_TARGET=http BACKTESTER_BASE_URL=http://127.0.0.1:8080 BACKTESTER_AUTH_TOKEN=dev-token \
  node scripts/verify_018_determinism.mjs
```
Expected: all three print `OK` — `result_hash` equality holds between platform in-process and the backtester service. **This is the parity gate.** If a hash diverges, it is a real parity bug — debug via the first-divergent-char technique, fix in the engine lift, never by adjusting the gate.

- [ ] **Step 5: Commit (in the platform repo)**

```bash
# in trading-platform
git add scripts/verify_018_baseline.mjs scripts/verify_018_overlay_variant.mjs scripts/verify_018_determinism.mjs scripts/lib/verify_018_http_target.mjs
git commit -m "test(018): add HTTP-target mode to verify_018 gates (result_hash parity vs backtester service)"
```

---

## Task 17: Docs + flip the flag on

**Files:**
- Modify: `README.md` (add a "Slice 6a" section), `docs/ARCHITECTURE.md` (mark the runner lift landed; note 6b remains).

- [ ] **Step 1: Document Slice 6a**

Add a README "Slice 6a" subsection mirroring the existing slice notes: the overlay engine runs through the trusted in-process executor behind `BACKTESTER_ENABLE_OVERLAY_ENGINE=true` + `engine:'overlay'`; real `comparison` flows on `RunResultSummary`; parity proven by `verify_018_*` HTTP-target gate (`result_hash` equality); momentum path + golden unchanged; untrusted sandboxed overlay execution + trading-lab cutover + `sp4_mock` retire remain (6b + follow-ups).

- [ ] **Step 2: Decide the default**

Keep `enableOverlayEngine` default **off** in code (safe default); document that deployments flip `BACKTESTER_ENABLE_OVERLAY_ENGINE=true` once their CI runs the HTTP-target gate green. (Do not change the code default in this slice.)

- [ ] **Step 3: Final full regression**

Run: `pnpm typecheck && pnpm test`
Expected: PASS — four momentum goldens unchanged; overlay goldens, gating, wire, projection, edge-case all green.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/ARCHITECTURE.md
git commit -m "docs(slice-6a): record the trusted overlay-engine lift + verify_018 HTTP parity gate"
```

---

## Self-review (run before handoff to execution)

**Spec coverage:** Goals §2 → Tasks: engine lift (5), trusted executor (7,14), comparison block (10), byte-identity goldens (9), verify_018 HTTP gate (16), flag-gating (12,13), momentum preserved (2,15). Contracts/validation home §4.1–4.2 → Tasks 1–5. Determinism §5 → Tasks 5 (rng/canonical reuse), 9 (platform-derived goldens). Wire §4.6 → Task 10. Selector/gating §4.5 → Tasks 12–14. Error handling §6 → Task 13 (+ engine-emitted taxonomy via lift). Testing/guardrails §7 → Tasks 2,9,10,15 (all four guardrails present). Impl-note 1 (zero-overlays) → Task 8. Impl-note 2 (platform-derived goldens) → Task 9 Step 1/3. Rollout §8 order → task order. No spec section unmapped.

**Placeholder scan:** every code step shows real code or an exact lift instruction with source + target paths + import-rewrite rules; verification steps give exact commands + expected output. Where a symbol/API can only be confirmed at the file (e.g. the exact `materialize`/summary-builder names), the task says "find via gortex" and names the file — not a silent TBD.

**Type consistency:** `runOverlayBacktest`, `OverlayRunDeps`, `buildOverlayDataset`/`OverlayDatasetSelector`, `toOverlaySummary`, `RunOutcome`, `ComparisonSummary`, `enableOverlayEngine`, `engine:'momentum'|'overlay'`, `BACKTESTER_ENABLE_OVERLAY_ENGINE`, `GOLDEN_VARIANT` are used consistently across Tasks 6–16.
