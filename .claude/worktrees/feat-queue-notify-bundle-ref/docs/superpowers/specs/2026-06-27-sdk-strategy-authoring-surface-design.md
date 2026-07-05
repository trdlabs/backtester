# SDK strategy-authoring-surface + breaking `./builder` rewrite

- **Date:** 2026-06-27
- **Branch:** `feat/sdk-strategy-authoring-surface` (from fresh `main`, after PR #56 signed-evidence)
- **Package:** `@trading-backtester/sdk` (`packages/sdk`)
- **Status:** design approved (2026-06-27), pending spec review

## 1. Goal

Build, in `@trading-backtester/sdk`, the **strategy-authoring-surface**: the tools + prose + worked
example that an LLM builder in `trading-lab` consumes to **generate a strategy bundle** (not an
overlay) in the canonical format. Today the SDK has only normalizers + types and zero authoring
prose/examples; the lab builder can only author overlays, so an LLM cannot produce a strategy
bundle.

This is the **first brick**. The larger goal (separate, later work): lab consumes this surface →
generates a strategy bundle → backtester validates + signs → platform runs it paper-isolated vs the
curated `long_oi` baseline → results match ⇒ the builder is proven valid.

Mechanical packaging would not prove the builder. The deliverable is specifically an **authoring
surface** so the LLM authors the strategy.

## 2. Decisions (locked in brainstorm 2026-06-27)

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Both kinds.** Strategy is primary (doc + worked example + tests); overlay doc is **migrated from lab** into the SDK so the SDK is the single source for both. | User: strategies *and* hypotheses (overlays) live as artifacts; one source of truth. |
| D2 | Authoring surface lives **inside `./builder`** (no new `./authoring` subpath). | User: `./builder` is being rewritten under the strategy-as-artifact model; a separate subpath would be deleted anyway. Keeps `package.json` exports unchanged. |
| D3 | **Breaking rewrite** of `./builder`. Current consumers are intentionally migrated to the new API. | User: deliberately break the old shape so the builder-agent moves onto the new SDK now that strategies/hypotheses are artifacts. |
| D4 | **R2 — single-source kernel manifest.** Drop the SDK's minimal `ModuleManifest`/`ModuleKind`; re-source the rich kernel types from `@trading-platform/sdk/research-contract` (the path 042 took for contracts). | The sandbox reads `manifest.hooks` and the real bundle manifest carries `hooks/dataNeeds/capabilities/paramsSchema`; one source removes drift. |
| D5 | Consumption API: `getAuthoringDoc(kind)` **plus** raw constants (doc string, example source, typed example bundle). | User choice; typed accessor is forward-compatible, raw constants allow direct import. |
| D6 | Include `scaffoldStrategyBundle` helper (with a dedicated test + DoD bullet). | User overrode the YAGNI-defer recommendation in Q4 and chose to add the helper. |
| D7 | Add `computeBundleHash(rawBytes)` — explicit cross-boundary raw-bytes pin, distinct from the internal structural `computeInlineBundleHash`. | User-approved; names things correctly and prevents "passed a bundle object instead of bytes" at the type level. |

## 3. Authoritative bundle contract (do not change — the surface targets it)

- **Runtime form:** a single **self-contained ESM**, `export default function createStrategyModule(params): StrategyModule`. No `import`/`require` (FR-003). Pre-built JS (TS types erased); V8 executes directly.
- **`StrategyModule`** (kernel research-contract): `{ manifest, init?, onBarClose, onPositionBar?, onPendingIntentBar?, dispose? }`. Decisions are the `StrategyDecision` union (`enter`/`idle`/`exit`/`add_to_position`/`update_protection`/`annotate`).
- **Two distinct hashes, never conflated:**
  - `bundleHash = sha256:<hex>` over the **raw ESM bytes** — the cross-boundary pin (evidence ↔ platform 043 hash-pin). Exposed as `computeBundleHash(rawBytes)`.
  - `computeInlineBundleHash` / `canonicalBundleHash` — **structural** hash over `{manifest, files}`, the backtester-internal sandbox-registry identity. NOT cross-boundary.
- **Entry convention is universal and already cross-checked:** backtester sandbox, platform prod (045 isolated_vm, fixed on `compileModule`, PR #26), and platform 019 fixtures all execute exactly `export default createStrategyModule`.

## 4. Module structure (post-rewrite `src/builder/`)

```
src/builder/
  index.ts            // barrel — re-exports everything below
  manifest.ts         // createModuleManifest(richInput) -> frozen kernel ModuleManifest (versions pinned)
  bundle.ts           // createModuleBundle (logic unchanged; manifest type now kernel)
  preflight.ts        // preflightValidateBundle (structural-only; kind:'strategy' already supported)
  hash.ts             // computeInlineBundleHash (structural, internal) + computeBundleHash(rawBytes) (raw-bytes, cross-boundary)
  authoring/
    doc.ts            // STRATEGY_AUTHORING_DOC, OVERLAY_AUTHORING_DOC, AUTHORING_DOC_VERSION, getAuthoringDoc(kind)
    examples/
      strategy-example.ts  // STRATEGY_EXAMPLE_SOURCE (self-contained ESM), STRATEGY_EXAMPLE_BUNDLE: ModuleBundle
      overlay-example.ts   // OVERLAY_EXAMPLE_SOURCE, OVERLAY_EXAMPLE_BUNDLE: ModuleBundle
    scaffold.ts       // scaffoldStrategyBundle(input) -> { bundle, report }
```

`package.json` `exports` map is unchanged (still `.` / `./contracts` / `./builder` / `./client` /
`./artifacts`). `tsup.config.ts` bundles `authoring/*` into `dist/builder/index.js`; no new entry,
no new `api-extractor.*.json`.

### 4.1 `hash.ts`

```typescript
// Internal structural identity (backtester sandbox-registry only).
export function computeInlineBundleHash(bundle: ModuleBundle): string; // delegates to canonicalBundleHash

// Cross-boundary pin — what goes into evidence.bundleHash and the platform bot_bundle.contentHash.
// Hashes the RAW ESM bytes, returns 'sha256:<hex>'.
export function computeBundleHash(rawBytes: Buffer | Uint8Array): string;
```

`computeBundleHash` reuses the existing `sha256Hex` primitive (`internal/content-hash`) over the raw
bytes and prefixes `sha256:`. It deliberately does **not** accept a `ModuleBundle` — the caller must
pass the raw entry-file bytes, the same bytes lab provides for the cross-boundary pin.

### 4.2 `manifest.ts`

`createModuleManifest(input)` builds a **frozen kernel `ModuleManifest`** with `contractVersion` /
`bundleContractVersion` pinned to the SDK's `internal/versions` constants
(`API_CONTRACT_VERSION='017.2'`, `BUNDLE_CONTRACT_VERSION='019.1'`). Input is the rich shape:
`{ id, version, kind, name, summary?, rationale?, author?, status?, hooks, dataNeeds, capabilities,
paramsSchema, params? }`. Pure: same input ⇒ structurally identical manifest.

> Implementation note to confirm: the exact kernel `ModuleManifest` field list and optionality are
> pinned by reading `@trading-platform/sdk/research-contract` in `node_modules` during
> implementation. The fields above are derived from the worked fixture
> (`apps/backtester/test/fixtures/overlay/bundles/short-after-pump.bundle.json`) and the kernel
> re-export list in `packages/research-contracts/src/research/module.ts`.

### 4.3 `bundle.ts` / `preflight.ts`

`createModuleBundle({ manifest, entry, files })` — unchanged logic (sort keys into a new frozen
record, freeze the bundle); the `manifest` type is now the kernel manifest.

`preflightValidateBundle(input, { engine })` — unchanged structural-only validator. It validates the
manifest **subset** (`id`, `version`, `kind`, `bundleContractVersion`) and ignores extra kernel
fields, so a rich manifest passes. Engine↔kind: `momentum` engine ⇒ `strategy` kind; `overlay`
engine ⇒ `overlay` kind. Issue codes preserved (`schema_invalid`, `unsupported_module_kind`,
`unsupported_contract_version`, `bundle_entrypoint_invalid`).

### 4.4 `authoring/doc.ts`

```typescript
export const AUTHORING_DOC_VERSION: string;          // bumped with contract changes
export const STRATEGY_AUTHORING_DOC: string;          // versioned markdown
export const OVERLAY_AUTHORING_DOC: string;           // migrated from lab builder-sdk-doc.ts
export function getAuthoringDoc(kind: ModuleKind): string;
```

`STRATEGY_AUTHORING_DOC` is the prose fed to the LLM. It covers:

- The canon: `export default function createStrategyModule(params): StrategyModule`.
- `StrategyContext` API: `bar`, `position`, `data.closedCandles(n)`, `market` (openInterest +
  liquidations + funding + taker flow), `indicators.query(...)`, `rng`, `params`, `clock`.
- Decision forms (`StrategyDecision` union) with field shapes.
- **Multi-phase entry + management**: `onBarClose` (flat phase) + `onPositionBar` (in-position
  management).
- Self-contained / no-imports / pre-built-ESM rule (FR-003).
- Manifest fields: `id`, `version`, `kind:'strategy'`, `hooks`, `dataNeeds`, `capabilities`,
  `paramsSchema`, `params`.

`OVERLAY_AUTHORING_DOC` mirrors the structure for overlays (`apply` hook, `OverlayDecision` union:
`pass`/`veto`/`patch`/`annotate`). The lab `BUILDER_SDK_DOC` text is not readable from this repo, so
the overlay doc is synthesized from the kernel contracts (`OverlayLifecycleModule`,
`OverlayDecision`); lab reconciles its copy when it cuts over to the SDK source.

### 4.5 `authoring/examples/strategy-example.ts`

`STRATEGY_EXAMPLE_SOURCE: string` — a full self-contained `export default createStrategyModule`,
pre-built ESM, no imports, deterministic (only `ctx`; no `Date.now`/random). It mirrors `long_oi`:

- **`onBarClose` (flat phase):** entry on a signal computed from `ctx.data.closedCandles(...)` and
  `ctx.indicators.query(...)`; returns `{ kind: 'enter', side, rationale }` or `{ kind: 'idle' }`.
- **`onPositionBar` (management phase):** uses `ctx.position` to manage the open position —
  DCA (`add_to_position`), protection (`update_protection`), or `exit` — returns the matching
  decision or `{ kind: 'idle' }`.

`STRATEGY_EXAMPLE_BUNDLE: ModuleBundle` — the typed bundle built via `createModuleManifest`
(`hooks: ['onBarClose', 'onPositionBar']`, with `dataNeeds`/`capabilities`/`paramsSchema`/`params`)
+ `createModuleBundle` with `entry: 'module/index.js'` and `files: { 'module/index.js':
STRATEGY_EXAMPLE_SOURCE }`.

### 4.6 `authoring/examples/overlay-example.ts`

`OVERLAY_EXAMPLE_SOURCE` / `OVERLAY_EXAMPLE_BUNDLE` — minimal worked overlay (`apply` returning an
`OverlayDecision`), `kind: 'overlay'`, mirroring the strategy example's structure. Kept lean.

### 4.7 `authoring/scaffold.ts`

```typescript
export interface ScaffoldStrategyBundleInput {
  readonly manifest: CreateModuleManifestInput; // rich strategy manifest input
  readonly entry: string;
  readonly files: Readonly<Record<string, string>>;
}
export interface ScaffoldStrategyBundleResult {
  readonly bundle: ModuleBundle;
  readonly report: ValidationReport;            // preflight with engine: 'momentum'
}
export function scaffoldStrategyBundle(input: ScaffoldStrategyBundleInput): ScaffoldStrategyBundleResult;
```

One-call ergonomic path for an author/builder: build the manifest, build the bundle, run preflight
(strategy ⇒ `engine: 'momentum'`), return both. Does not throw on validation errors — the caller
inspects `report.status`.

## 5. Breaking changes & consumer migration (intentional)

| Consumer | Change |
|----------|--------|
| `packages/sdk/src/contracts/module.ts` | Replace minimal `ModuleManifest`/`ModuleKind` with kernel re-source; keep `ModuleBundle`, `BacktestEngine`. |
| `packages/sdk/src/builder/index.ts` | Rewritten barrel (new exports). |
| `scripts/verify-sdk-clean-consumer.ts` | Migrate to the rich `createModuleManifest` input + new exports. |
| `apps/backtester/test/bundle.test.ts` | Byte-parity test updated to the rich manifest (both sides hash the same kernel manifest, so parity holds). |
| `packages/sdk/test/builder.test.ts` | Rewritten for the new API. |
| `packages/sdk/README.md`, `docs/ARCHITECTURE.md` | Update the `/builder` table + examples. |
| `packages/sdk/package.json` | Version bump `0.2.1` → `0.3.0` (breaking). Exports map unchanged. |

`tsc` must stay clean across the package. The `./builder` `exports` entry, `tsup.config.ts` entry,
`api-extractor.builder.json`, and `copy-schemas.mjs` are unchanged (still one `builder/index`
entrypoint).

## 6. Testing strategy (TDD)

**SDK tests (vitest, no Docker):**

1. `createModuleManifest` produces a frozen kernel manifest with versions pinned; pure.
2. `createModuleBundle` deterministic (insertion-order independent, frozen).
3. `computeInlineBundleHash` stable for structurally identical bundles.
4. `computeBundleHash(rawBytes)` returns `sha256:<hex>` and rejects non-byte input at the type level
   (compile-time) — runtime test asserts the prefix + hex shape.
5. `getAuthoringDoc('strategy')` / `getAuthoringDoc('overlay')` return the respective non-empty docs.
6. `STRATEGY_EXAMPLE_BUNDLE` passes `preflightValidateBundle(..., { engine: 'momentum' })` with
   `status: 'accepted'`.
7. **Direct ESM execution:** dynamically import `STRATEGY_EXAMPLE_SOURCE` (self-contained), call
   `createStrategyModule(params).onBarClose(ctx)` and `.onPositionBar(ctx)` with a synthetic
   `StrategyContext`; assert deterministic decisions (same ctx ⇒ same decision).
8. `scaffoldStrategyBundle(...)` returns a bundle + an `accepted` report for the example input.

**App test (`apps/backtester/test`, Docker ⇒ CI-gated, skipped in WSL2):**

9. Feed `STRATEGY_EXAMPLE_BUNDLE` through `SandboxModuleExecutor.executeStrategyHook` to prove
   entry-convention compatibility end-to-end. (Per repo history, Docker tests skip in WSL2, so CI is
   the sandbox-path gate.) The `manifest.hooks` set also drives `createInertStrategyModule` correctly
   (proxy builds `onBarClose` + `onPositionBar`).

## 7. Definition of Done

- [ ] SDK exports a strategy authoring doc + worked `createStrategyModule` strategy example (entry +
      management).
- [ ] Overlay authoring doc migrated into the SDK (single source for both kinds).
- [ ] `getAuthoringDoc(kind)` + raw constants exported.
- [ ] `computeBundleHash(rawBytes)` exported with the explicit `Buffer | Uint8Array → 'sha256:<hex>'`
      signature, distinct from `computeInlineBundleHash`.
- [ ] `scaffoldStrategyBundle` helper exported **with a dedicated test**.
- [ ] Example passes `preflightValidateBundle` with `kind='strategy'` and executes deterministically
      (direct ESM in SDK test; sandbox execution in the CI-gated app test).
- [ ] Canonical bundle contract fixed (forms + `bundleHash`=raw-bytes) as the reference for lab.
- [ ] All breaking consumers migrated; `tsc` clean; SDK version bumped (`0.3.0`).
- [ ] TDD tests green + self-review.
- [ ] Short note documenting what the lab side does next.

## 8. Out of scope (do NOT do here)

- Changing lab (schema/validator/prompt) — separate next task.
- The proof-harness (paper comparison vs curated `long_oi`) — final phase.
- Breaking the bundle **runtime contract** or the entry convention (`export default
  createStrategyModule`).
- Introducing the structural hash as the cross-boundary pin (`bundleHash` = raw-bytes;
  `canonicalBundleHash` stays internal).

## 9. What the lab side does next (documented, not done here)

1. Add `@trading-backtester/sdk` as a lab dependency.
2. Consume `getAuthoringDoc('strategy')` + `STRATEGY_EXAMPLE_*` in the builder prompt/RAG.
3. Converge lab's divergent `module-bundle-v1` (`{ moduleId, moduleKind, appliesTo, ... }`) to the
   SDK canonical contract (`{ id, version, kind, bundleContractVersion }` + `bundleHash`=raw-bytes).
4. Update lab schema/validator/prompt to emit strategy bundles.
5. Build the proof-harness: generate → backtester validate + sign → platform paper-isolated vs
   curated `long_oi` → compare.
