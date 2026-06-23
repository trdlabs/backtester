# trading-backtester Roadmap

## Done

- `trading-backtester`
  - Slice 1–5
  - Slice `6a`, `6b-A` (sandboxed overlay execution — live)
  - Feature 1: Client Contract Alignment (`ModuleKind` expanded to `'strategy' | 'overlay'`, `BacktestEngine` exported, `BacktestRunRequest` aligned with research-contracts)
  - Public standalone `@trading-backtester/sdk`: `sdk-v0.1.0` (Phase 1) and `sdk-v0.2.0` (registry discovery) published; legacy `packages/client` removed
  - Overlay-Run Registry Discovery: `GET /v1/registry` + canonical `TRUSTED_REGISTRY_DEFINITION` (single source for discovery **and** inline overlay execution) + self-sufficient `default-overlay` preset + request-fingerprint completeness
- `trading-lab`
  - backtester adapter introduced; `research_platform` is the default path (`sp4_mock` retired on the write/submit path; still readable for legacy rows)
  - SDK cutover to `@trading-backtester/sdk@0.2.0`
  - `6b-B` finished: consumes the real `comparison`; preset-driven `submitOverlayRun` with a discriminated `target` (`registry_preset | baseline_ref`)
  - submitted overlay bundles execute on the backtester (overlay metadata projected through `toBacktesterBundle`)
- `trading-platform` / `trading-mock-platform`
  - mock-platform historical-data path proven end-to-end; the real `trading-platform` production data path + final cutover from mock still need hardening

## Current State

The backtester supports the trusted **and** sandboxed overlay engine, async run lifecycle, `status` / `result` / `artifacts`, deterministic parity gates, and registry discovery.

The full user flow

`trading-lab -> trading-backtester -> trading-mock-platform`

is now closed end-to-end — proven green by `cross-repo-e2e.integration.test.ts` (hypothesis → preset-driven overlay run → `completed` with a real comparison → `evaluated`). The remaining gap is the **real `trading-platform`** production data path; today's E2E runs against `trading-mock-platform`.

## Feature 1: Client Contract Alignment ✅ DONE

**Goal:** remove the contract gap between `trading-backtester` and `trading-lab`.

### Completed

- `ModuleKind` and `BacktestEngine` include `'overlay'` and are exported
- `ModuleValidateRequest` interface added (`moduleBundle?` + `engine?`) — typed POST /v1/modules/validate contract
- `BacktesterClient.validateModule` accepts `ModuleValidateRequest` instead of `unknown`
- client-parity tests: explicit `Equal<>` guards for `BacktestEngine` and `ModuleKind` parity, compile-time @ts-expect-error guard on `validateModule`

### Done when

`trading-lab` can type-safely submit a real overlay bundle to `trading-backtester`. ✅

## Feature 2: Trading-Lab 6b-B Cutover ✅ DONE

**Goal:** finish the real overlay backtest flow through `trading-backtester`.

### Completed

- `submitOverlayRun` sends `engine: 'overlay'` in `RunSubmitRequest`
- `toSdkComparison()` maps `BtComparisonSummary` (`variants[].metricDeltas`) → `ComparisonSummaryDTO` flat `{baseline, variant, deltas}` records
- `toSdkSummary` detects `comparison` presence and sets `runKind: 'baseline-vs-variant'`
- `BacktesterClientLike.validateModule` typed to `BtModuleValidateRequest` (was `unknown`)
- `runPlatformBacktest` orchestration fully covered: validate → submit → persist → poll → resolve
- 141 test files / 1439 tests green, typecheck clean

### Done when

`trading-lab` can submit a hypothesis to `trading-backtester` and persist a valid backtest result. ✅

## Feature 3: sp4_mock Retirement (6b-C)

**Goal:** remove the legacy path.

### Completed

- `BACKTEST_BACKEND` defaults to `research_platform`; `sp4_mock` value no longer accepted
- `computeParamsHash` simplified — `backend` param removed, always uses research_platform hash
- sp4_mock branch removed from `hypothesis-build.handler.ts`
- `AppServices.defaultPlatformRun` added; `research-run-cycle` enqueues hypothesis.build tasks with it
- 141 test files / 1422 tests green, typecheck clean

### Done when

Only the real backtester path remains for hypothesis backtests. ✅

## Feature 4: Historical Data API Hardening

**Goal:** make the real platform data path mandatory and reliable.

### Completed

- `mock-platform-parity.test.ts` — parity gate: proves `MockPlatformDataPort` produces byte-identical
  materialized rows (`datasetFingerprint`) compared to `FixtureDataPort` when fed the same underlying data
- `createHistoricalHttpApp` added to `trading-platform` — Hono adapter exposing `GET /historical/coverage`,
  `/historical/discover`, `/historical/bars`, `/historical/funding`, `/historical/open-interest`,
  mirroring the `trading-mock-platform` contract so `MockPlatformDataPort` works against both backends
- `verify_historical_http_app.mjs` added to `gates:historical` in `trading-platform`

### Done when

The backtester reads historical data through the platform contract, not through temporary local modes. ✅

## Feature 5: End-to-End Product Flow

**Goal:** close the full user scenario.

### Scenario

1. `trading-lab` assembles a hypothesis overlay bundle
2. `trading-lab` validates or submits a run to `trading-backtester`
3. `trading-backtester` fetches historical data from `trading-platform` or `trading-mock-platform`
4. `trading-backtester` executes baseline plus sandboxed overlay
5. `trading-lab` receives `status`, `result`, and `artifacts`
6. `trading-lab` persists comparison and evaluation
7. UI / read models expose the outcome to the user

### Completed

- `cross-repo-e2e.integration.test.ts` in `trading-lab` — opt-in gate (`RUN_CROSS_REPO_E2E=true`) proving
  lab → backtester → mock-platform: mock-platform dataset refs (`SYMBOL:timeframe`), adapter submit+poll,
  and full `hypothesis.build` handler flow to `evaluated` + evaluation decision
- `docker-compose.demo.yml` wires mock-platform + backtester + lab worker/ingress (demo stack)
- failure-mode coverage:
  - validation reject ✅ (`validation-reject.test.ts`)
  - sandbox failure ✅ (`sandbox-failure.test.ts`)
  - timeout ✅ (`deadline-reaping.test.ts`)
  - missing dataset ✅ (`deadline-reaping.test.ts`)
  - queue expiry ✅ (`deadline-reaping.test.ts`)
  - non-completed terminal runs ✅ (`terminal-result-api.test.ts`)
- artifact access verification ✅ (`api.e2e.test.ts`)

### Done when

The “hypothesis to backtest result” user flow works end-to-end. ✅

## Feature 6: Operationalization

**Goal:** make the whole system operable.

### Completed

- `docs/OPERATIONS.md` — release ordering, env matrix, per-repo `check` gates, local verification workflow
- GitHub Actions CI (`pnpm check`) in `trading-backtester` and `trading-lab`
- `make cross-repo-e2e` in trading-lab (host gate against demo stack; publishes backtester on loopback)
- Cross-repo parity inventory: `mock-platform-parity.test.ts`, platform `gates:018` HTTP mode, `cross-repo-e2e.integration.test.ts`

### Done when

Cross-repo changes can be rolled out predictably without manual re-debugging of every seam. ✅

## Feature 7: Overlay-Run Registry Discovery ✅ DONE

**Goal:** let `trading-lab` discover and submit a *complete* overlay run without hardcoding the backtester's internal trusted modules — closing the “incomplete request → engine rejects” gap.

### Completed

- `GET /v1/registry` discovery endpoint + `RegistryDescriptor` / `OverlayRunPreset` DTOs in `@trading-backtester/sdk@0.2.0` (`discoverRegistry()` client method)
- canonical `TRUSTED_REGISTRY_DEFINITION` — single source feeding **both** discovery and the inline overlay-execution registry (no discovery/execution drift; guarded by `registry-execution-consistency.test.ts`)
- self-sufficient `default-overlay` preset (advertises the full overlay metric catalog)
- `requestFingerprint` completeness + stored-fingerprint recompute (no false 409 on pre-deploy replay; catches changed run-affecting fields)
- `trading-lab`: discriminated `SubmitOverlayRunOptions.target`; per-adapter support (HTTP = preset only, MCP = baseline_ref only, mock = both); `toBacktesterBundle` projects the rich 017 overlay manifest so submitted overlays execute

### Done when

`trading-lab` discovers a preset, submits its own overlay bundle against it, and the run reaches `completed` with a real comparison. ✅

## Feature 8: Sandbox Execution Performance (proposed — not started)

**Goal:** keep the per-run Docker isolation for **untrusted** overlay bundles, but stop paying its full
cost on every analysis as strategy/analysis volume grows. Performance was an explicit **non-goal** of the
sandbox-topology work (`2026-06-22-sandbox-execution-topology-*.md`); this is the follow-up that picks it up.

**Why now:** evaluated against `tripolskypetr/backtest-kit` (Habr 1037822). Its headline throughput (one
Node process, in-process, no isolation) is a *consequence of running the author's own trusted code* — not a
trick we are missing. We run untrusted LLM-generated overlays, so the sandbox is the point. The adoptable
ideas are caching + parallelism, **not** dropping isolation.

### Cost model (grounded in code, 2026-06-23)

- Docker+IPC is paid **only when a run carries a `bundleHash`** (untrusted bundle). First-party/trusted
  strategies already run fully in-process (`InProcessTrustedModuleExecutor` / `TrustedMomentumExecutor`
  via the `ModuleExecutor` seam) — no container, no IPC.
- For untrusted runs: **one container per symbol per run** (cold start = `SandboxSession.open()` →
  `docker run` + node boot + bundle import + `init` ack) **+ synchronous per-bar IPC** (`onBarClose` /
  overlay `apply` every bar → one `SyncIpcChannel` round-trip; blocking `readSync` + 1 ms busy-wait).
- Per-run container lifecycle, **no cross-run reuse**. Session compute budget `wallTimeMsPerSession` = 30 s.

### Proposed changes (ladder: cheap → invasive)

1. **Cross-run dataset/tape cache.** `buildOverlayDataset` / `materialize` rebuild the `MarketTapeDataset`
   from the data port on every run; cache by `(datasetRef, window, symbols)` (in-mem LRU or Redis) and
   reuse across analyses. Orthogonal to the sandbox; lowest risk. (This is backtest-kit's Redis-O(1)
   insight, applied at the right layer.)
2. **Parallel run execution.** `claimNextQueued` is already concurrency-safe (`FOR UPDATE SKIP LOCKED`);
   only the single-worker `drainQueue` loop is serial. Run **N workers / concurrent claims** → scales the
   "many analyses × many strategies" case directly (the natural axis — don't speed up one run, run many).
3. **Warm/pooled sandbox.** Pool of pre-spawned locked-down containers; per run = **warm container +
   fresh process + tmpfs reset** (never reuse a process across untrusted strategies — leaks state).
   Removes cold-start; preserves every lockdown flag. Already flagged as future work in the topology spec.
4. **Amortize per-bar IPC.** Highest leverage, most design. Options: move the bar loop **into** the
   sandbox (stream decisions out; host keeps data/PnL/risk/metrics + `DecisionRevalidator`); or chunk K
   bars per round-trip; or replace the `sleepMs(1)` busy-wait with a blocking read + length-framing.
   Care: point-in-time discipline (no future bars) currently relies on the host dripping one bar at a time.

### Non-goals / guardrails

- **Never** drop the sandbox for untrusted overlays — non-negotiable per the topology spec.
- Redis-row-id O(1) candle lookup specifically is premature (< 10 symbols / 1 m); our wins are pool +
  batch + parallelism, not candle-lookup complexity.

### Recommended order

**1 + 2 first** (cheap, cover the "many analyses" scenario), then **3**, then **4** only if long
fine-grained untrusted runs become the dominant cost.

### Baseline measurements

Repeatable harness: `apps/backtester/test/bench-sandbox-perf.test.ts`
(`RUN_BENCH=1 pnpm exec vitest run …`) — real pinned image + built harness, Docker-gated, **network-free**
(hand-built host ctx; no data port → no `@trading-platform/sdk`). CI: `.github/workflows/bench-sandbox.yml`
(push a `bench/**` branch). Both runs are host-process → docker daemon, **bind mode** (NOT DooD).

_Measured 2026-06-23 (`node:24-bookworm-slim`, cpus 1 / mem 128 MiB):_

| Cost (p50) | WSL2 dev stand (Docker 29.5.3) | **Native Linux** (GH Actions `ubuntu-latest`) | gap |
|---|---|---|---|
| **cold-start** `open()` (docker run + node boot + bundle init) | 4.14 s (max 6.0) | **135 ms** (mean 140, max 191) | ~30× |
| **per-bar round-trip** (`callHook`; incl. harness 4-indicator recompute) | 8.5 ms (mean 13, p99 95) | **1.17 ms** (mean 1.22, p99 1.5) | ~7× |

The WSL2 figures are dominated by its VM/9p-filesystem container-start + pipe overhead (**not** networking — the
sandbox is `--network none`); native Linux is the real structural cost.

**Revised read (native Linux = the prod-relevant number):**
- cold-start **135 ms**, paid once per symbol per run → modest (e.g. 150 containers ≈ 20 s total). Warm-pool (#3)
  becomes a dev-ergonomics win (WSL2's 4 s) + an extreme-scale optimization, not urgent for prod volumes.
- per-bar **1.17 ms** ⇒ a 30-day 1 m run ≈ **~51 s/symbol** (vs 366 s on WSL2); the 30 s `wallTimeMsPerSession`
  budget now covers ~25 k bars (~18 days @ 1 m). IPC batching (#4) matters only for very long 1 m runs / higher cadence.
- ⇒ for "many analyses × many strategies" on native Linux the cheap levers **#1 (dataset cache) + #2 (parallel
  runs)** carry the load; #3/#4 are reserved for extreme scale. The WSL2 dev stand overstates the cost ~7–30×.

### Done when

The untrusted-overlay path scales to many concurrent analyses without per-run cold-start and redundant
data re-materialization dominating wall-clock — while every sandbox lockdown flag and the per-run
isolation boundary stay intact.

## Remaining Work

The core product flow is closed. What's left:

### Phase A — real platform data path

1. `trading-platform`: harden the production historical-data path (today the proven E2E runs against `trading-mock-platform`)
2. run the cross-repo E2E against the **real** `trading-platform`, then make it the default backend

### Phase B — internal hygiene (no consumer impact) — mostly done

3. ✅ **DONE** (PR #26) — SDK Phase 3 Part B: `research-contracts/src/{run.ts,comparison.ts}` are now thin type-only re-exports from `@trading-backtester/sdk` (the single definition source); 18 import sites + `/research` subpath unchanged.
4. **(open, gated)** once legacy `sp4_mock`-backed rows are migrated/aged out, drop `'sp4_mock'` from `BacktestRun.backend` (kept today only for read back-compat) and remove the residual test fixtures.
5. ✅ **DONE** (PR #27) — operational docs (`OPERATIONS.md`: SDK distribution + `/v1/registry`) refreshed; CI actions bumped to Node-24 (`checkout`/`setup-node` v5).

## Definition of Done

The system is “working” when (✅ except the real-platform data path):

- `trading-lab` submits hypothesis backtests to `trading-backtester` by default ✅
- `trading-backtester` executes the overlay path with sandboxing ✅
- results and artifacts come back correctly ✅
- historical data comes through the **real** platform contract (mock proven; real-platform hardening pending)
- `sp4_mock` is no longer written (✅; type member retained for legacy read back-compat)
