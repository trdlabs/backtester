# Overlay-Run Registry Discovery Design

**Status:** approved design

**Date:** 2026-06-19

**Owning repository:** `trading-backtester` (SDK contract + `/v1/registry` endpoint); consumer changes in `trading-lab`.

**Target:** `@trading-backtester/sdk@0.2.0`

## 1. Context & root cause

The cross-repo path `trading-lab → trading-backtester (overlay engine) → trading-mock-platform` fails:
an overlay run reaches a terminal `failed` with `terminalCode: validation_error`. This was diagnosed
end-to-end against the live demo stack:

- The backtester's overlay engine **works**: a *complete* overlay request completes on the demo data
  (verified on both `BTCUSDT:1d` (5 bars) and `BTCUSDT:1h` (72 bars)).
- The failure is an **incomplete request**. The backtester's `validateRunRequest` requires, for an
  overlay run: a baseline `moduleRef`, a non-empty `overlayRefs`, a `riskProfileRef`, an
  `executionProfileRef`, and non-empty `metrics` drawn from the **overlay** metric catalog
  (FR-022/026/027). `trading-lab`'s `HttpBacktesterAdapter.submitOverlayRun` sends `moduleRef`
  pointing at a non-existent `baseline/v1`, **no** `overlayRefs`, **no** `riskProfileRef`, **no**
  `executionProfileRef`, and `metrics: []`.
- The backtester does **not publish** what a consumer needs to build a valid request:
  `capabilities.supportedMetrics` advertises the **momentum** catalog
  (`total_bars`/`return_pct`/`seed_probe`), which the overlay engine rejects (it accepts
  `pnl`/`max_drawdown`/`win_rate`/`sharpe`); and the registered baseline/overlay/risk/exec module
  refs (`short_after_pump`, `early_exit_short_after_pump`, `default_risk`, `default_exec` in the demo
  `buildTrustedRegistry()`) are not discoverable.

This is independent of the SDK cutover (Phases 1–3): the SDK-built bundle is byte-identical to the old
one, the momentum engine completes end-to-end, and `validateModule` accepts the bundle.

## 2. Goal

Make the lab→backtester overlay path produce **valid** run requests by:

1. having the backtester **expose** its registered baselines / overlays / risk profiles / exec
   profiles and per-engine metric catalogs via a discovery endpoint, and
2. having the lab **build a complete overlay request** from that discovery.

No change to the backtester's overlay engine semantics, `validateRunRequest`, determinism, or the
frozen golden hashes.

## 3. Scope

### In scope
- A new `@trading-backtester/sdk@0.2.0` public contract: `RegistryDescriptor` + `OverlayRunPreset`
  DTOs + a `discoverRegistry()` client method (`SDK_VERSION` → `0.2.0`, `API_CONTRACT_VERSION` stays).
- A canonical `TRUSTED_REGISTRY_DEFINITION` (single source for `buildTrustedRegistry()` + discovery)
  with fail-fast validation, and a new `GET /v1/registry` handler.
- Per-engine metric catalogs + named `overlayRunPresets` in the discovery response.
- Fixing `requestFingerprint` to include `engine`/`overlayRefs`/`riskProfileRef`/
  `executionProfileRef`/`robustnessChecks` (+ regression tests) — idempotency key only, result
  goldens unchanged.
- Migrating `SubmitOverlayRunOptions` to a discriminated `target`, updating ALL
  `ResearchPlatformPort` adapters (HTTP/mock/MCP).
- `trading-lab`'s preset-driven `submitOverlayRun` + the cross-repo E2E using discovery.
- Version-dynamic release tooling; publishing SDK `0.2.0` and re-pinning `trading-lab`.

### Out of scope
- Changing the overlay engine, `validateRunRequest`, risk/exec semantics, determinism, or golden
  hashes.
- Defaulting `riskProfileRef`/`executionProfileRef` server-side (the lab supplies discovered refs —
  see Decision 1).
- Phase 3 Part B (the `@trading/research-contracts` public-wire dedup) — still deferred.
- Multi-bundle submission (lab submitting its own baseline strategy bundle).

## 4. Decisions

1. **No server-side defaults for risk/exec.** `validateRunRequest` keeps requiring
   `riskProfileRef`/`executionProfileRef`/`overlayRefs`/`metrics`. The lab supplies them from
   discovery. This avoids touching the backtester's validation/golden surface and keeps the request
   contract explicit.
2. **Baseline comes from the backtester's trusted registry.** The lab discovers available baselines
   and picks one (the lab's value is the overlay hypothesis; the baseline is hosted). For an inline
   overlay-bundle run, the worker registers `strategies:[short_after_pump]`,
   `overlays:[early_exit_short_after_pump] + the submitted bundle`, so the discoverable baseline for
   the demo is `short_after_pump`.
3. **`overlayRefs` references the submitted overlay bundle.** `createModuleRegistry` keys overlay
   bundles by `id@version` of their manifest; the lab sets
   `overlayRefs = [{ id, version } of its createModuleManifest output]`. The lab knows this ref
   because it built the manifest.
4. **Dedicated discovery endpoint.** `GET /v1/registry` (not an extension of `capabilities`) keeps
   "capabilities" small and separates "what the engine can do" from "what is registered".
5. **Per-engine metric catalogs in discovery.** The registry response carries
   `metricCatalogs: { momentum, overlay }`. `capabilities.supportedMetrics` is left as the momentum
   catalog (optionally annotated) — the lab uses the registry's `overlay` catalog for overlay runs.
6. **Public contract bump — package version only, NOT the API contract version.** The discovery DTO
   + client method are a new public surface → bump `SDK_VERSION` and `packages/sdk/package.json`
   `version` to `0.2.0`. **Do NOT bump `API_CONTRACT_VERSION`** — it stays `017.2`. The run/evidence
   API contract is unchanged (the registry endpoint is purely additive); `API_CONTRACT_VERSION` is
   tied to the private `CONTRACT_VERSION === '017.2'`, run evidence, 017 manifests and the existing
   parity tests, and bumping it would require a separate, out-of-scope API-contract migration.
7. **Single source of truth for the registry.** The trusted registry's contents (the *arrays* of
   strategies / overlays / risk / exec) live in ONE immutable definition. Both the resolve-only
   lookup registry (`buildTrustedRegistry()`) and the `/v1/registry` discovery DTO are derived from
   that same definition, so discovery can never drift from what the worker executes against.
8. **Presets, not array-position selection.** Discovery exposes named `overlayRunPresets` — each a
   complete, compatible `{ baseline, riskProfile, execProfile, metrics }` bundle — and the lab
   selects by `presetId`. Picking the "first" element of a list is forbidden (hidden array-order
   coupling; silent incompatible pick). With several modules and no explicit `presetId`, the lab
   fails with a clear error rather than guessing.
9. **Version-dynamic release tooling (prerequisite).** The current `sdk:verify` script
   (`package.json`) and `verify-sdk-clean-consumer.ts`'s `SDK_VERSION === '0.1.0'` smoke assertion
   are hardcoded to `0.1.0` and would break the `0.2.0` release. Both must derive the version
   dynamically (from `packages/sdk/package.json` / the workflow `version` input) before `0.2.0` is
   cut.

## 5. SDK contract (`@trading-backtester/sdk@0.2.0`, `/contracts` + `/client`)

New DTO (in `contracts`):

```ts
export interface RegisteredModuleRef {
  readonly id: string;
  readonly version: string;
  readonly name?: string;
  readonly summary?: string;
}

/**
 * A complete, internally-consistent overlay-run recipe. Selected by `id`; the lab applies its own
 * submitted overlay bundle on top of `baseline`. Removes the need to pick compatible refs by hand.
 */
export interface OverlayRunPreset {
  readonly id: string;
  readonly name?: string;
  // Pure wire `Ref` ({ id, version }) — these go STRAIGHT into the run request, so they must NOT
  // carry name/summary (those would leak into the request body and shift its fingerprint).
  readonly baselineRef: Ref;            // = the existing @trading-backtester/sdk/contracts `Ref`
  readonly riskProfileRef: Ref;
  readonly executionProfileRef: Ref;
  readonly metrics: readonly string[];   // non-empty subset of the overlay metric catalog
}

export interface RegistryDescriptor {
  readonly contractVersion: string;       // = API_CONTRACT_VERSION ('017.2'); the registry shape is additive
  readonly baselines: readonly RegisteredModuleRef[];     // trusted baseline strategies
  readonly overlays: readonly RegisteredModuleRef[];      // trusted overlays
  readonly riskProfiles: readonly RegisteredModuleRef[];
  readonly execProfiles: readonly RegisteredModuleRef[];
  readonly metricCatalogs: {
    readonly momentum: readonly string[];
    readonly overlay: readonly string[];
  };
  readonly overlayRunPresets: readonly OverlayRunPreset[];  // safe, named selection (Decision 8)
}
```

New client method (in `client`):

```ts
discoverRegistry(): Promise<RegistryDescriptor>;   // GET /v1/registry
```

Bump `SDK_VERSION` (and `packages/sdk/package.json` `version`) to `0.2.0`; **keep
`API_CONTRACT_VERSION` at `017.2`** (Decision 6). Add a contract test pinning the new DTO shape. The
HTTP client follows the existing bearer-auth/error mapping. No change to the four existing subpaths'
other exports.

## 6. Backtester service (`trading-backtester`)

**Canonical registry definition (source of truth).** Today `buildTrustedRegistry()` returns a
resolve-only `TrustedModuleRegistry` (only `resolve*` methods — not enumerable). Introduce one
immutable definition — e.g. `TRUSTED_REGISTRY_DEFINITION` — holding the *arrays*
`{ strategies, overlays, riskProfiles, execProfiles, overlayRunPresets, overlayMetricCatalog }`.
Refactor `buildTrustedRegistry()` to build its lookup maps FROM this definition (behavior-preserving;
the resolve results stay identical, so the worker's overlay path and goldens are unchanged). The
`/v1/registry` handler builds the `RegistryDescriptor` FROM the same definition. Because both derive
from one source, discovery can never drift from what the worker executes against (Decision 7).

**Route.** Add a `GET /v1/registry` route (bearer-authed like the others) returning a
`RegistryDescriptor`: `baselines` = the definition's strategy manifests' refs, `overlays`,
`riskProfiles`, `execProfiles` likewise, `metricCatalogs = { momentum: METRIC_CATALOG, overlay:
<overlay catalog> }`, and `overlayRunPresets` from the definition. The demo definition ships one
preset (e.g. `default-overlay` → baseline `short_after_pump`, risk `default_risk`, exec
`default_exec`, the overlay metrics). Import the `RegistryDescriptor`/`OverlayRunPreset` types from
`@trading-backtester/sdk/contracts`. No engine / `validateRunRequest` / determinism / golden changes.

**Request fingerprint completeness (bug surfaced by presets).** Today `requestFingerprint`
(`src/jobs/fingerprint.ts`) hashes only a subset of the run-affecting fields and omits `engine`,
`overlayRefs`, `riskProfileRef`, `executionProfileRef` and `robustnessChecks`. Two overlay runs that
differ ONLY in those (e.g. two different presets) would collide on the same fingerprint and be
treated as idempotent replays — wrong. Extend `requestFingerprint` to include those run-affecting
fields, with regression tests proving distinct fingerprints for runs differing only in
engine/overlayRefs/risk/exec/robustness. This changes the fingerprint VALUES (the idempotency key)
but NOT the `result_hash`/result goldens (the fingerprint is not part of the hashed `RunOutcome`);
update any idempotency tests that pin a literal fingerprint accordingly.

**Registry definition validation (fail-fast).** `TRUSTED_REGISTRY_DEFINITION` is validated at module
load (or a dedicated test) and rejects, with a clear error: duplicate preset `id`s; a preset whose
`baselineRef`/`riskProfileRef`/`executionProfileRef` does not resolve to a registered
strategy/risk/exec module; an empty `metrics`; or a metric not in the overlay catalog. This prevents
shipping a registry whose presets can't actually run.

## 7. Lab consumer (`trading-lab`)

`HttpBacktesterAdapter`:

**Port contract migration.** `SubmitOverlayRunOptions.baselineModuleRef` is currently a required
`Ref` (`src/ports/research-platform.port.ts`). Replace it with a discriminated `target` so the
registry-preset path and an explicit-baseline path are both first-class and unambiguous:

```ts
target:
  | { kind: 'registry_preset'; presetId?: string }   // discover + select a preset
  | { kind: 'baseline_ref'; moduleRef: Ref };        // caller supplies the baseline directly
```

All `ResearchPlatformPort` implementers must handle the new shape:
- **`HttpBacktesterAdapter`** (this design): see below.
- **Mock adapter**: accepts both `kind`s deterministically (no network); its synthetic result is
  unaffected by the selection.
- **MCP/platform adapter**: maps `baseline_ref` to its existing behavior; `registry_preset` is
  backtester-specific — it rejects it with a clear "presets are only supported on the backtester
  integration" error (no silent fallback).

**`HttpBacktesterAdapter`**:
- Gains a cached `discoverRegistry()` call (lazy, memoized per adapter instance).
- `submitOverlayRun` resolves `target` to a complete request:
  - `registry_preset`: look up `presetId` in the discovered `overlayRunPresets`. If `presetId` is
    omitted AND there is exactly one preset, use it; if omitted with multiple presets (or an unknown
    `presetId`), **throw a clear error** — never pick by array position (Decision 8). Then
    `moduleRef = preset.baselineRef`, `riskProfileRef = preset.riskProfileRef`,
    `executionProfileRef = preset.executionProfileRef`, `metrics = preset.metrics`.
  - `baseline_ref`: `moduleRef = target.moduleRef`; risk/exec/metrics from a configured default
    preset or explicit options (caller's responsibility).
  - In both: `overlayRefs = [{ id, version }]` of the submitted overlay bundle's manifest (the lab
    built it). The refs that enter the request are pure `Ref`s — no `name`/`summary` leak.
- `discover()` may also surface the overlay metric catalog / available presets so callers can choose.

The `cross-repo-e2e.integration.test.ts` uses the discovered refs instead of the hardcoded
`baseline/v1` and `metrics:[]`, and asserts the run reaches `completed` with a `comparison` block.

## 8. Release & cutover sequence

0. **Make the release tooling version-dynamic (Decision 9, prerequisite).** Change the root
   `sdk:verify` script to resolve the tarball name from `packages/sdk/package.json` `version` (not a
   literal `0.1.0`), and change `verify-sdk-clean-consumer.ts` to read the expected `SDK_VERSION`
   from the installed package's `package.json` instead of asserting `=== '0.1.0'`. Confirm the
   existing `0.1.0` gates still pass after the change.
1. Land the SDK `0.2.0` contract (`SDK_VERSION`/`package.json` = `0.2.0`, `API_CONTRACT_VERSION`
   stays `017.2`), the canonical registry definition + `/v1/registry` endpoint in
   `trading-backtester`; service tests green (incl. a registry-endpoint integration test + a
   `buildTrustedRegistry`-parity test proving the refactor changed no resolution); goldens unchanged.
2. Publish GitHub Release `sdk-v0.2.0` (manual `workflow_dispatch`, fail-closed — as for 0.1.0).
3. In `trading-lab`: re-pin `@trading-backtester/sdk` to the `0.2.0` tarball URL; implement the
   preset-driven `submitOverlayRun`; make the cross-repo E2E green against the demo stack.

Each repo is its own PR. The lab PR depends on `sdk-v0.2.0` being published.

## 9. Verification

- **Backtester:** unit/integration test for `GET /v1/registry` (shape + trusted refs + per-engine
  catalogs + presets); a `buildTrustedRegistry`-parity test (resolution unchanged after the
  refactor); a `TRUSTED_REGISTRY_DEFINITION` validation test (dup preset ids / dangling refs / empty
  or non-overlay metrics all rejected); `requestFingerprint` regression tests (runs differing only in
  engine/overlayRefs/risk/exec/robustness get DISTINCT fingerprints); existing
  overlay/momentum/sandbox/**result-hash golden** suites unchanged and green; the SDK contract test
  pins `RegistryDescriptor`/`OverlayRunPreset`; clean-consumer + package gates pass at `0.2.0`.
- **Adapters:** all `ResearchPlatformPort` implementers (HTTP/mock/MCP) compile and pass against the
  new discriminated `target`; MCP rejects `registry_preset` with a clear error.
- **Cross-repo (manual, demo stack):** with the demo up,
  `RUN_CROSS_REPO_E2E=true … cross-repo-e2e` reaches `completed` and returns a real overlay
  `comparison` (baseline vs baseline+overlay).
- **Direct proof (already captured):** a complete overlay request
  (`moduleRef:short_after_pump`, `overlayRefs:[early_exit_short_after_pump]`,
  `riskProfileRef:default_risk`, `executionProfileRef:default_exec`,
  `metrics:[pnl,max_drawdown,win_rate,sharpe]`) completes on the demo data — discovery just lets the
  lab build this automatically.

## 10. Acceptance criteria

1. `@trading-backtester/sdk@0.2.0` (`SDK_VERSION`/`package.json` = `0.2.0`; `API_CONTRACT_VERSION`
   unchanged at `017.2`) exposes `RegistryDescriptor`, `OverlayRunPreset` and `discoverRegistry()`.
2. `GET /v1/registry` returns the trusted baselines/overlays/risk/exec refs, per-engine metric
   catalogs, and `overlayRunPresets`, ALL derived from one immutable registry definition that also
   builds `buildTrustedRegistry()` — proven by a parity test that the refactor changed no resolution.
3. No backtester engine / `validateRunRequest` / determinism / golden change; all existing suites
   green.
4. `trading-lab`'s `submitOverlayRun` builds a complete overlay request by `presetId` (never by array
   position); no hardcoded `baseline/v1` or `metrics:[]`; an ambiguous/unknown preset fails loudly.
5. The cross-repo E2E reaches `completed` with a real `comparison` against the demo stack.
6. The release tooling is version-dynamic (`sdk:verify` + clean-consumer derive the version, not a
   literal `0.1.0`); `sdk-v0.2.0` is published and `trading-lab` installs it from the release URL.
7. `OverlayRunPreset` carries pure `Ref`s (`baselineRef`/`riskProfileRef`/`executionProfileRef`) — no
   `name`/`summary` reaches the run request; `TRUSTED_REGISTRY_DEFINITION` validation rejects dup
   preset ids, dangling refs, and empty/non-overlay-catalog metrics.
8. `requestFingerprint` includes `engine`/`overlayRefs`/`riskProfileRef`/`executionProfileRef`/
   `robustnessChecks`; runs differing only in those get distinct fingerprints; `result_hash` goldens
   are unchanged.
9. `SubmitOverlayRunOptions` uses the discriminated `target`; all `ResearchPlatformPort` adapters
   (HTTP/mock/MCP) handle both `kind`s; MCP rejects `registry_preset` with a clear error.
