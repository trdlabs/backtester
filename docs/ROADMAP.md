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

## Remaining Work

The core product flow is closed. What's left:

### Phase A — real platform data path

1. `trading-platform`: harden the production historical-data path (today the proven E2E runs against `trading-mock-platform`)
2. run the cross-repo E2E against the **real** `trading-platform`, then make it the default backend

### Phase B — internal hygiene (no consumer impact) — mostly done

3. ✅ **DONE** (PR #26) — SDK Phase 3 Part B: `research-contracts/src/{run.ts,comparison.ts}` are now thin type-only re-exports from `@trading-backtester/sdk` (the single definition source); 18 import sites + `/research` subpath unchanged.
4. **(open, gated)** once legacy `sp4_mock`-backed rows are migrated/aged out, drop `'sp4_mock'` from `BacktestRun.backend` (kept today only for read back-compat) and remove the residual test fixtures.
5. ✅ **DONE** (PR #27) — operational docs (`OPERATIONS.md`: SDK distribution + `/v1/registry`) refreshed; CI actions bumped to Node-24 (`checkout`/`setup-node` v5).

### Phase C — throughput and multi-tenant scaling

Detailed analysis and decision context: [`2026-07-01-backtester-throughput-scaling-analysis.md`](superpowers/specs/2026-07-01-backtester-throughput-scaling-analysis.md).

**Foundation (items 6–9) — design + plan landed:** see
[`specs/2026-07-01-backtester-throughput-scaling-foundation-design.md`](superpowers/specs/2026-07-01-backtester-throughput-scaling-foundation-design.md)
and [`plans/2026-07-01-backtester-throughput-scaling-foundation.md`](superpowers/plans/2026-07-01-backtester-throughput-scaling-foundation.md):
S3-compatible shared store (MinIO first-class), first-class API/worker split with worker health
probes, and K8s/KEDA reference manifests. Items 10–13 (quotas, dedup, stronger sandbox, Temporal)
remain follow-up specs.

6. **Horizontal workers first:** split API and workers in deployment. Run API with `BACKTESTER_AUTO_WORKER=false`; run many `worker-main.ts` replicas against the same `DATABASE_URL`. The current Pg queue (`claimNextQueued` with `FOR UPDATE SKIP LOCKED`) already supports this; keep in-memory store for tests/dev only.
7. **Kubernetes scaling model:** start with long-lived worker `Deployment` + KEDA `ScaledObject` driven by queued-job depth. Use `ScaledJob` only after adding a worker-once mode that drains a bounded batch and exits; the current worker loop is intentionally long-lived.
8. **Shared state before extra replicas:** move bundles/artifacts from host-local file stores to a cluster-visible store (S3/MinIO/NFS/CSI volume) before spreading workers across nodes. Keep content-addressed artifact semantics and deterministic `result_hash` intact.
9. **Capacity controls:** prefer low per-Pod `WORKER_CONCURRENCY` (often 1-2) and scale Pod count. Budget actual pressure as `worker_concurrency * symbols_per_run * sandbox_cpus/memory`, because sandbox sessions are per module+symbol and Docker daemon contention can become the node bottleneck.
10. **Tenant fairness and quotas:** add per-tenant/user queue limits, concurrency caps, and cancellation/expiry policy before opening this as a shared SaaS surface. The global Pg queue can stay shared, but admission and scheduling must prevent one tenant from monopolizing worker capacity.
11. 🚧 **IN PROGRESS — Fingerprint-based dedup:** add result/in-flight coalescing keyed by request fingerprint + bundle hash + dataset fingerprint + engine/runtime version. Existing `requestFingerprint` is suitable as the run-affecting input key, but cached materialization must account for `runId` being part of current outcomes/result hashes. Design spec:
    [`specs/2026-07-01-backtester-result-dedup-design.md`](superpowers/specs/2026-07-01-backtester-result-dedup-design.md);
    plan: [`plans/2026-07-01-backtester-result-dedup.md`](superpowers/plans/2026-07-01-backtester-result-dedup.md).
    `ResultCache` (in-memory + Pg) wired into `buildApp`/`WorkerDeps` behind `BACKTESTER_DEDUP_ENABLED`
    (default off); see `OPERATIONS.md` § "Result dedup (Phase C item 11)".
12. **Stronger sandbox isolation later:** evaluate gVisor/Kata/Firecracker only after the horizontal Docker worker path is proven. Preserve the current sandbox contract: no network/secrets, read-only mounts, resource-limit error taxonomy, deterministic cleanup, and stable IPC behavior.
13. **Temporal later, for workflows not raw speed:** introduce Temporal only when the product becomes multi-step durable orchestration (generate strategy -> backtest -> evaluate -> re-prompt -> evidence), not as a replacement for the current Pg job queue.

## Definition of Done

The system is “working” when (✅ except the real-platform data path):

- `trading-lab` submits hypothesis backtests to `trading-backtester` by default ✅
- `trading-backtester` executes the overlay path with sandboxing ✅
- results and artifacts come back correctly ✅
- historical data comes through the **real** platform contract (mock proven; real-platform hardening pending)
- `sp4_mock` is no longer written (✅; type member retained for legacy read back-compat)
