# Slice 6a — Lift the platform BacktestRunner (trusted overlay engine + real comparison)

> Status: **approved design** (2026-06-17). Additive, flag-gated. Follows Slice 5
> (`@trading-backtester/client` + trading-lab `HttpBacktesterAdapter`). Grounded in a read of
> trading-platform `src/research/backtest/**`, `src/research/validation/**`, `contracts/research/**`,
> `scripts/verify_018_*.mjs`; the backtester's current signals/momentum runner, sandbox, and
> determinism utilities; and trading-lab's `HttpBacktesterAdapter` / `baselineOnlyComparison` / `sp4_mock`.

---

## 0. One-sentence thesis

Lift trading-platform's full, deterministic `runBacktest` engine (baseline + overlay-variant
simulation, overlay composition, real comparison) into trading-backtester as a **parallel,
flag-gated run path** that executes through the **trusted in-process executor** — making real
baseline-vs-variant comparison flow over HTTP and the platform's `verify_018_*` golden-masters pass
against the running service — **without touching** the existing signals/momentum path or its golden
`result_hash`. Untrusted, sandboxed overlay execution is deferred to Slice 6b.

---

## 1. Background & problem

The backtester today runs a **signals-only momentum** engine: `runBacktest(request, {dataset,
executor?, bundleHash?}) → BacktestResult`, where `ModuleExecutor.computeSignals(series, seed) →
Map<string, boolean[]>` and the runner owns a fixed simulation loop emitting `runKind:
'baseline-only'`. Its determinism is locked by the golden hash
`sha256:eff10116147933c96d92ae50071ef66339467fb69545c38855dcd50c2c0b43ba` across four vitest tests
(`determinism`, `api.e2e`, `client`, `data-api`).

This blocks final integration on three concrete gaps:

1. **No overlay execution.** The platform's real engine runs strategy + overlay modules with
   composition at `onBarClose` / `onPositionBar`; the backtester's momentum engine cannot.
2. **No real comparison on the wire.** `RunResultSummary` carries one `metrics` map and an optional
   `resultHash`, with **no comparison block**. This is exactly why trading-lab's
   `HttpBacktesterAdapter` fakes `baselineOnlyComparison` (`baseline = metrics`, `variant = {}`,
   `deltas = {}`) and why `verify_018_overlay_variant` cannot target the service.
3. **`sp4_mock` cannot retire.** The legacy `BACKTEST_BACKEND='sp4_mock'` default in trading-lab
   stays until the HTTP backtester executes real overlay modules and returns a real comparison.

ARCHITECTURE.md §2 marks `src/research/backtest/**` as **"lift wholesale"** (pure DI, zero I/O
coupling); §8 mandates the research contracts as a **shared, versioned library** (the parity anchor);
§10 step 5 is the trading-lab cutover + `sp4_mock` retire. This slice is the engine lift those depend
on.

### 1.1 What the platform engine is (recon summary)

- **Entry:** `runBacktest(request, deps): RunOutcome` (synchronous). `RunOutcome` =
  `{status:'rejected', validation}` | `{status:'completed', baseline, variant?, comparison?}`.
  Baseline is always simulated; a variant is simulated when overlays resolve; then
  `comparison = computeComparison(baseline, variant)`.
- **Overlay composition** at two interception points inside the per-symbol bar loop: `onBarClose`
  (entry overlays) and `onPositionBar` (post overlays). `OverlayComposer` implements the verbs
  **pass / annotate / patch / veto**; `patch` shallow-merges then **re-validates** the patched
  decision against the 017 strategy-decision JSON schema (via `schema-registry`); `veto` terminates
  composition lazily (later overlays' `apply` never runs).
- **Executor seam:** `ModuleExecutor` (`executeStrategyHook`, `executeOverlayApply`, optional
  `initStrategy` / `disposeStrategy` / `close`) reached **only** through an `ExecutorRouter`
  (`forStrategy`, `forOverlay`, `closeAll`). `runBacktest` uses `deps.router ??
  createTrustedRouter(deps.executor)`. A sandbox executor implements `ModuleExecutor` and is wrapped
  by a custom router passed as `deps.router` — **zero runner changes** (this is the 6b seam).
- **Hashing is downstream.** The runner returns a plain `RunOutcome`; no hash code lives in
  `backtest/**`. Determinism (seeded mulberry32 rng + canonical accumulation) is what makes the
  downstream hash stable.
- **External deps:** `contracts/research/{decision,module,context,run,catalogs,indicators,
  market-tape,validation}.js`, plus `src/research/validation/{index,schema-registry}.js` (ajv,
  draft-07, committed 017 schemas), plus `platformContractContext` from the SDK catalogs. The only
  filesystem touch is `dataset.ts` (`loadCandleDataset` / `findRepoRoot` /
  `defaultCandleFixturesDir`), bypassable via `deps.dataset` / `deps.marketTape`.

---

## 2. Goals / non-goals

### Goals (Slice 6a)

- Lift the 15-file engine + 017 contracts + ajv validation into the backtester as a parallel path.
- Run it through the **trusted in-process executor** (`createTrustedRegistry`) only.
- Add an **additive, optional `comparison` block** to `RunResultSummary` (research-contracts) and the
  client wire types, so real comparison flows over HTTP.
- Produce overlay-path output **byte-identical to platform `runBacktest`**; pin a platform-derived
  golden `result_hash` in vitest.
- Make platform `verify_018_{baseline,overlay_variant,determinism}` runnable against the live service
  (HTTP-target mode) and assert `result_hash` equality.
- Be **flag-gated** (`enableOverlayEngine`, default off) and **byte-for-byte preserve** the momentum
  path and its golden hash.

### Non-goals (deferred)

- **Slice 6b:** lift the stateful per-bar-IPC `SandboxModuleExecutor` + session-capable Docker driver
  + new in-container harness so **untrusted submitted** overlay/strategy bundles run sandboxed.
- **trading-lab edits:** dropping `baselineOnlyComparison`, switching `selectResearchPlatform`
  defaults. (trading-lab submits untrusted bundles ⇒ needs 6b.)
- **Retiring `sp4_mock`** (the `BACKTEST_BACKEND` default). Follows 6b.
- Promotion-parity / resolving promoted platform modules; market ingestion; live execution.

---

## 3. Architecture

```
@trading/research-contracts            EXTEND: 017 TYPE modules + committed JSON-schema assets
  (packages/research-contracts)        (parity anchor; NO ajv runtime)
        ▲ types + schema assets
apps/backtester/src/engine/  ........  NEW: 15 lifted runner files + ajv validation runtime
        │ runOverlayBacktest(request, { registry, dataset|marketTape }) → RunOutcome
apps/backtester/src/jobs/worker.ts ..  selector: legacy momentum runBacktest | runOverlayBacktest
        │ contentRef(result)               (reused verbatim — hashes whichever RunOutcome/BacktestResult)
apps/backtester/src/determinism/{canonical-json,rng,hash}   REUSED VERBATIM — the parity guarantee
apps/backtester/src/data/    ........  materialize CanonicalRowV2 → marketTapeFromCanonicalRows → deps.marketTape
apps/backtester/src/api + packages/client   additive optional `comparison` on RunResultSummary + wire.ts
```

Two run paths coexist behind a worker selector (**Approach A**, chosen): the legacy momentum
`runBacktest` stays untouched; a sibling `runOverlayBacktest` (the lifted engine) is added. Rejected
alternatives: **B** — one unified function branching internally (edits the existing function, risks
the golden hash for no benefit); **C** — make the new engine the only runner and reimplement momentum
as a trusted strategy module (changes the momentum output shape ⇒ breaks `eff10116…`).

---

## 4. Component design

### 4.1 `@trading/research-contracts` — extend (types + schema assets only)

Lift, as **pure types**: `decision.ts`, `module.ts`, `context.ts`, `run.ts`
(`BacktestRunRequest`/`Ref`/`RunInfo`), `catalogs.ts` (`platformContractContext`, schema IDs,
`CONTRACT_VERSION`), `indicators.ts`, `market-tape.ts` (`PointInTimeMarketApi`), and the
validation-code types. Commit the **017 JSON schema files** as package assets. No ajv here (keeps it
out of trading-lab's dependency surface).

- **Reconcile name collisions** with the package's existing 017/022 types. The existing signals-path
  `BacktestRunRequest` and the platform 017 request must converge into one additive shape: the 017
  request fields are added as **optional**, the existing signals fields stay, so old requests still
  typecheck and submit unchanged. (Guardrail test in §7.)
- **`CONTRACT_VERSION` lockstep guard:** a compile-time/test assertion that the contracts package
  `CONTRACT_VERSION` matches the platform's (currently `017.x`) — a bump breaks byte-identity.
- **`comparison` is optional** here (and in wire.ts) — momentum runs leave it `undefined`.

### 4.2 `apps/backtester/src/engine/` — lift wholesale (runner + validation runtime)

Lift verbatim: `runner.ts`, `overlay.ts`, `module-executor.ts`, `artifacts.ts` (the `RunOutcome` /
`BacktestRunResult` / `ComparisonSummary` data model — **lift intact**, it defines hash parity),
`context.ts`, `execution.ts`, `market-tape.ts`, `metrics.ts`, `portfolio.ts`, `profiles.ts`,
`protection.ts`, `registry.ts`, `risk.ts`. From `dataset.ts` lift only the **pure** helpers
(`indicatorAsOf`, `smaAsOf`, `pointInTimeDataApi`, `indicatorApiFor`) — **not** `loadCandleDataset` /
`findRepoRoot` / `defaultCandleFixturesDir` (filesystem). Lift the validation runtime
(`src/research/validation/{index,schema-registry}.ts`) into `src/engine/validation/`, importing the
017 schema assets from the contracts package.

**Reused, NOT re-lifted (this is where parity lives):** `src/determinism/{canonical-json, rng,
hash}`. Drop the engine's own `rng.ts` / canonical-json; point `context.ts` at `src/determinism/rng`.
The lift step **must verify** the platform's per-symbol seeding scheme (mulberry32, seeded per
symbol) is reproduced exactly — any divergence breaks hash parity.

Public surface: `runOverlayBacktest(request: BacktestRunRequest, deps: { registry:
TrustedModuleRegistry; dataset?: CandleDataset; marketTape?: MarketTapeDataset }): RunOutcome`. For
6a, `deps.router` / `deps.executor` resolve to the trusted in-process router (`createTrustedRouter`);
the sandbox-policy / sandbox-router fields are omitted (6b).

### 4.3 Data adapter

The data port already yields `CanonicalRowV2` rows (OHLCV + oi/funding/liq/taker + `has_*` flags),
materialized by `src/data` with a `dataset_fingerprint`. Feed those rows straight into the engine's
`marketTapeFromCanonicalRows` (same `CanonicalRowV2` contract) to build the injected
`deps.marketTape` (a `CandleDataset` superset). No new filesystem path; the existing
fixture/HTTP data sources both work unchanged.

### 4.4 Trusted registry & parity fixtures

Lift the platform's example modules `shortAfterPump` (strategy) and `earlyExitShortAfterPump`
(overlay) plus `DEFAULT_RISK` / `DEFAULT_EXEC`, and the 018 request fixtures `baseline.json` /
`variant.json`, into backtester test/parity fixtures. The overlay-path registry is built via
`createTrustedRegistry` from these trusted modules. (Untrusted submitted bundles via the registry =
6b.)

### 4.5 Worker selector & gating

- **Engine discriminator (explicit, not inferred):** a new optional request field `engine?:
  'momentum' | 'overlay'`, default `'momentum'`. Chosen over inferring from the presence of overlay
  refs because it (a) keeps `enableOverlayEngine` gating clean — reject overlay requests with a clear
  `validation_error` **before queueing**; (b) is orthogonal to the existing `bundleHash`
  trusted/sandbox axis; (c) allows a baseline-only overlay-engine run to exist.
- **Availability flag:** `AppConfig.enableOverlayEngine` (default **off**) gates the path until the
  HTTP parity gate is green, then flips on. When off, an `engine:'overlay'` request is rejected at
  validation with `validation_error` (never queued).
- **Selector:** `worker.processNextQueued` routes on `engine`. Momentum → existing `runBacktest`
  (untouched). Overlay → `runOverlayBacktest`. The worker computes `resultHash = contentRef(result)`
  for whichever (overlay path hashes the full `RunOutcome` — the parity primitive).

### 4.6 Wire contract — additive `comparison`

`RunResultSummary` gains optional `comparison?: ComparisonSummary` (baseline metrics, variant
metrics, `metricDeltas`, `overlayEffectsSummary`, `tradeOutcomeChanged`), populated **only** for
overlay runs; headline `metrics` = variant when present, else baseline. Mirror into
`packages/client/src/wire.ts` (additive; the existing compile-time client↔contracts parity guard
catches drift). Persist in `result_summary_json`. **Required by 6a's own gate**, which reads the
result via the client/HTTP and must see `comparison` to assert overlay parity. Does **not** obligate
trading-lab — the lab keeps ignoring the field until 6b.

---

## 5. Determinism & parity (make-or-break)

- **Two regimes.** Momentum keeps `eff10116…` (four tests unchanged). Overlay gets a **new,
  platform-derived golden** `result_hash`, pinned in vitest for `baseline.json` + `variant.json`.
- **Byte-identity to platform** for the overlay path is guaranteed by: (1) reusing the
  already-lifted-verbatim `canonical-json`; (2) lifting `artifacts.ts` (the `RunOutcome` shape)
  intact; (3) exact rng / per-symbol-seeding parity; (4) injecting data through the same
  `CanonicalRowV2` materialization. `result_hash = contentRef(RunOutcome)`.
- **`dataset_fingerprint`** continues to guard canonical-data drift between submit-time fetch and
  replay (unchanged mechanism).

### 5.1 Parity gate (CI, required green before any cutover)

Add an **HTTP-target mode** to platform `scripts/verify_018_{baseline,overlay_variant,determinism}.mjs`
behind an env flag (e.g. `VERIFY_018_TARGET=inprocess|http` + `BACKTESTER_BASE_URL`). In HTTP mode the
single seam (dynamic `import(dist/.../index.js)` → `runBacktest(request,{registry})`) is replaced by an
HTTP submit→poll→result against the backtester's `RunSubmitRequest` / `RunResultSummary` contract; the
gate computes the expected hash via the shared canonical-json lineage (`contentRef`) and asserts
equality with the service's `resultHash`. `verify_018_overlay_variant` additionally reads the
`comparison` block from the result to assert populated `metricDeltas` / `tradeOutcomeChanged`. The
in-process assertions stay the source of truth for the golden-master values; `boundary.mjs` (static
import scan) remains in-process only.

---

## 6. Error handling

The engine emits the 017 (∪ 019, when 6b lands) validation taxonomy. A `RunOutcome` with
`status:'rejected'` maps to a `failed` terminal with `terminal_code: validation_error`.
`OverlayComposer` patch-invalid / veto produce structured `validationIssues` carried in the result
(not thrown). `runBacktest`'s `finally { router.closeAll() }` is a no-op for the trusted router
(load-bearing in 6b). API-layer mapping to the existing 6-category gateway error vocabulary is
reused; an `engine:'overlay'` request while `enableOverlayEngine=off` is rejected pre-queue with
`validation_error`.

---

## 7. Testing & guardrails

**Preserve (regression):** the four momentum golden-hash tests, verbatim. Plus an explicit guardrail
asserting the momentum `metrics` object is **byte-identical post-merge** (the additive 017 contract
merge must not perturb momentum output → `eff10116…` unchanged), and a guardrail asserting the legacy
signals `BacktestRunRequest` **still typechecks and submits unchanged** after the additive merge.

**New (overlay path):**
- Run-vs-replay **byte-identity** for the overlay engine (`canonicalJson(out1) === canonicalJson(out2)`).
- **Platform-derived golden** `result_hash` pin for `baseline.json` + `variant.json`.
- Comparison-structure assertions (ported subset of `verify_018_overlay_variant`): populated
  `metricDeltas`, `tradeOutcomeChanged`, ≥1 overlay effect, ≥1 `overlay_early_exit` close.
- Spot-checks ported from `verify_018_{lookahead,execution,risk,validation}`.
- **Client round-trip WITH and WITHOUT `comparison`** (momentum result → `comparison` undefined;
  overlay result → populated) — both must serialize/deserialize cleanly through the client.
- `enableOverlayEngine` on/off gating: overlay request rejected pre-queue when off.

**Cross-repo gate:** platform `verify_018_{baseline,overlay_variant,determinism}` in HTTP-target mode
against the live service — `result_hash` equality required green.

---

## 8. Rollout (strangler-fig, no big-bang)

1. Extend `@trading/research-contracts` (additive types + schema assets + lockstep guard).
2. Lift the engine + validation runtime into `src/engine/`; wire to `src/determinism` + `src/data`.
3. Add the `comparison` wire block (contracts + client) — optional everywhere.
4. Add the worker selector + `engine` discriminator + `enableOverlayEngine` (default off).
5. Land all of the above behind the flag (momentum path proven untouched by the regression guards).
6. Add the HTTP-target mode to the platform `verify_018_*` scripts; run the cross-repo gate.
7. Flip `enableOverlayEngine=on` once the gate is green. Document as a README "Slice 6a" section.
8. **Follow-ups (out of scope):** Slice 6b (sandbox); then trading-lab drops `baselineOnlyComparison`
   and `sp4_mock` retires.

---

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Overlay output not byte-identical to platform ⇒ hash mismatch | Reuse canonical-json/rng verbatim; lift `artifacts.ts` intact; verify per-symbol seeding; gate on `result_hash` equality. |
| Additive 017 merge perturbs the momentum path ⇒ `eff10116…` breaks | Default `engine:'momentum'`; byte-identical-metrics guardrail; legacy-request typecheck+submit guardrail; four golden tests preserved. |
| `CONTRACT_VERSION` / schema drift vs platform | Lockstep compile-time/test guard; schemas committed as shared assets in research-contracts. |
| `comparison` block breaks existing consumers | Optional in **both** research-contracts and wire.ts; client round-trip tested with and without; trading-lab keeps ignoring it. |
| Validation runtime (ajv) coupling leaks to trading-lab | ajv + runner live in `src/engine`; only types + schema assets are shared. |
| Engine accidentally runs untrusted bundles in-process | Trusted-only in 6a; `bundleHash`/sandbox routing stays the 6b axis; overlay path uses `createTrustedRegistry` only. |

---

## 10. Open items to resolve during implementation

- Exact additive reconciliation of `BacktestRunRequest` (signals fields ∪ 017 fields) and any other
  name collisions between the existing research-contracts 017/022 types and the lifted type modules.
- Confirm the platform's per-symbol rng seeding scheme reproduces byte-identically on
  `src/determinism/rng`.
- Confirm `platformContractContext` / catalogs lift cleanly (used by the runner's three `validate()`
  calls) with no SDK-only coupling.
- Final names: `engine` field values, `enableOverlayEngine` config key, `src/engine/` path.
