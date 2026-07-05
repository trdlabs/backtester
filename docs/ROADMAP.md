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

**Verify-spike DONE (2026-07-05).** The backtester's live `RowsDataPort` (historical.2 contract)
was proven against the **real** `trading-platform` historical HTTP API on the VPS (`:8088`,
`network_mode: host`): `discover`→`historicalContractVersion: 'historical.2'` + `rows` resource
`available`, 526 real symbols, ~3-week coverage window (the `HISTORICAL_CACHE_DAYS=4` cache is
LRU-only; the corpus spans weeks). Auth = `Authorization: Bearer <raw>` where
`HISTORICAL_HTTP_TOKENS` holds sha256-hex hashes; a dedicated backtester token was provisioned
(appended hash, `historical` container recreated). A real `long_oi` single-symbol run completed
end-to-end; the multi-symbol path surfaced + fixed a code gap (**`RowsReader` was single-symbol**;
`queryRange` now honours `q.symbols`, **PR #89** squash `bb1269a`) — real 3-symbol universe runs now
complete (OFF and ON, byte-identical). "Point at the real platform" is otherwise config-only.

Remaining to CLOSE Phase A:

1. `trading-platform`: harden the production historical-data path — decide the `'real'` config posture
   (distinct `BACKTESTER_REAL_PLATFORM_URL/_TOKEN` vs today's shared `mock`/`real` pair), error
   taxonomy / retries / contract-gate behaviour, and a determinism check (same window twice → same
   `result_hash`).
2. run the cross-repo E2E against the **real** `trading-platform` (opt-in gate, sibling of
   `cross-repo-historical-e2e.integration.test.ts`), then make it the default backend.

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
probes, and K8s/KEDA reference manifests. Item 11 (dedup) shipped dark-launched (PR #73). Item 10
(per-tenant quotas/fairness) is deferred to the multi-user gate. Items 12–13 (stronger sandbox,
Temporal) remain follow-up specs.

6. **Horizontal workers first:** split API and workers in deployment. Run API with `BACKTESTER_AUTO_WORKER=false`; run many `worker-main.ts` replicas against the same `DATABASE_URL`. The current Pg queue (`claimNextQueued` with `FOR UPDATE SKIP LOCKED`) already supports this; keep in-memory store for tests/dev only.
7. **Kubernetes scaling model:** start with long-lived worker `Deployment` + KEDA `ScaledObject` driven by queued-job depth. Use `ScaledJob` only after adding a worker-once mode that drains a bounded batch and exits; the current worker loop is intentionally long-lived.
8. **Shared state before extra replicas:** move bundles/artifacts from host-local file stores to a cluster-visible store (S3/MinIO/NFS/CSI volume) before spreading workers across nodes. Keep content-addressed artifact semantics and deterministic `result_hash` intact.
9. **Capacity controls:** prefer low per-Pod `WORKER_CONCURRENCY` (often 1-2) and scale Pod count. Budget actual pressure as `worker_concurrency * symbols_per_run * sandbox_cpus/memory`, because sandbox sessions are per module+symbol and Docker daemon contention can become the node bottleneck.
10. **Tenant fairness and quotas — ⏸️ DEFERRED (multi-user gate).** Not built now: today is single-user, so per-tenant quotas are **not** a foundation invariant and their absence blocks nothing. Explicitly deferred until *before public multi-user / paid SaaS*. Deliberately NOT doing now: tenant tables, fair scheduler, weighted queues, per-user admission control, queued/running caps. **Forward-compatibility hook (already in place, costs nothing):** the Pg queue is tenant-agnostic — global FIFO + `FOR UPDATE SKIP LOCKED` — so a future `tenantId` slots in as a `WHERE tenant = …` predicate without reworking ordering or claiming; do not couple admission/ordering to anything that would block that. When re-opened: add per-tenant/user queue limits, concurrency caps, and cancellation/expiry policy so one tenant can't monopolize worker capacity; the global Pg queue can stay shared.
11. ✅ **SHIPPED (dark launch) — Fingerprint-based dedup:** worker-time completed-result cache keyed by request fingerprint + dataset fingerprint + `DEDUP_COMPUTE_VERSION` + sandbox policy version; a HIT re-stamps the cached outcome under the new `runId` (preserves the deterministic `result_hash` contract, proven by per-engine byte-equivalence goldens) and skips the engine/sandbox. Merged in PR #73 (`main` squash `5ab8a1f`), **`BACKTESTER_DEDUP_ENABLED` default off**. Design spec:
    [`specs/2026-07-01-backtester-result-dedup-design.md`](superpowers/specs/2026-07-01-backtester-result-dedup-design.md);
    plan: [`plans/2026-07-01-backtester-result-dedup.md`](superpowers/plans/2026-07-01-backtester-result-dedup.md).
    `ResultCache` (in-memory + Pg) wired into `buildApp`/`WorkerDeps`; see `OPERATIONS.md` § "Result dedup (Phase C item 11)".
    Follow-ups: ✅ **in-flight coalescing SHIPPED** (PR #76 + Pg fix #77, `BACKTESTER_COALESCE_ENABLED` default off, Postgres-durable — see item 11b below); ✅ **operational enablement VALIDATED** (2026-07-02, controlled small-sweep, see below). Remaining: submit-time fast-path, TTL/LRU pruning, split bundle-load so a bundle-HIT stops materializing the bundle.

11a. ✅ **CONTROLLED ENABLEMENT — PASS.** `BACKTESTER_DEDUP_ENABLED` + `BACKTESTER_COALESCE_ENABLED` + `BACKTESTER_JOB_OBS` enabled together on a real small sweep (split topology, mock-platform 1m historical, SDK client): a 6-job identical BEATUSDT set (5 concurrent + 1 post-repeat) ran the engine **exactly once** — 4 coalesced followers (`compute_wait_attempts=1`, `wake=cache_ready`) + 1 completed-cache dedup HIT (`engineMs:null`); hit-rate 5/7. `/statsz` `engineMs.count=2` (only the genuine misses). **Bottleneck = engine/sandbox ~23 s avg per miss (~85–95 % wall)** ≫ materialize ~1.6 s ≫ genuine queue sub-second; dedup+coalescing remove nearly all of it on repeats/bursts with **no measured downside**. **Recommended for single-user: enable dedup+coalescing in the working env; keep `BACKTESTER_JOB_OBS` on during observation.** Code defaults stay OFF (dark-launch); this is an operational env recommendation, not a default flip.

11b. ✅ **SHIPPED (dark launch) — In-flight request coalescing:** concurrent identical jobs (same `computeIdentity`) coalesce onto ONE engine run — a leader runs, followers defer to an internal `waiting_for_compute` status (releasing the worker slot) and complete via re-stamp once the leader's cache template appears, or take over on leader fail/crash. Separate expiry-based `backtest_compute_lock` (migrations 0005/0006); wake/reap release-policy; attempts charged at engine-commit + `compute_wait_attempts`. `waiting_for_compute` is internal-only (public API projects it to `running`). Postgres-durable only; `BACKTESTER_COALESCE_ENABLED` default off, requires dedup. PR #76 (`main` squash `48e97a5`) + Pg-fix #77 (`2ebabd0`, `releaseAllComputeWaiters` unbound-param + Pg-gated wake regression test — the coalesce-* suites were InMemory-only, so the Pg wake path shipped with zero coverage). Design: `specs/2026-07-02-inflight-coalescing-design.md`; plan: `plans/2026-07-02-inflight-coalescing.md`. Follow-up (perf): the remaining fresh-miss engine cost is a warm-pool candidate (item 12, security-sensitive) — do NOT start until dedup+coalescing are actually enabled and misses still hurt.
12. **Stronger sandbox isolation later:** evaluate gVisor/Kata/Firecracker only after the horizontal Docker worker path is proven. Preserve the current sandbox contract: no network/secrets, read-only mounts, resource-limit error taxonomy, deterministic cleanup, and stable IPC behavior.
13. **Temporal later, for workflows not raw speed:** introduce Temporal only when the product becomes multi-step durable orchestration (generate strategy -> backtest -> evaluate -> re-prompt -> evidence), not as a replacement for the current Pg job queue.

### Phase D — concurrent-burst readiness (analysis 2026-07-02)

Context: with the Phase C foundation shipped (items 6–9) and dedup+coalescing validated (11a),
the dominant cost is the **fresh-miss engine/sandbox run (~23 s, 85–95 % of wall time)**, which
scales only with `worker_pods × WORKER_CONCURRENCY`. A whole-system review (backtester runtime +
docs + trading-lab interaction) found that for "hundreds of concurrent backtests" the cheapest,
highest-leverage work is **lab-side parallelism** and **ingress protection** — not new engine
work. Capacity math: unique-run throughput ≈ `pods × WORKER_CONCURRENCY / 23 s`; "hundreds
in flight" needs ~25–30 worker slots across several nodes (Docker daemon is a per-node choke,
~1.8× at 4 workers/host). No architectural redesign required. Lab-side items live in
`trading-lab` but are tracked here to keep one scaling picture.

14. ✅ **SHIPPED (PR #79, squash `d62ac85`, 2026-07-04) — Tier 0 obs hygiene.** All code parts landed:
    `/statsz` queue block (depth + oldest-queued age — the KEDA metric), unconditional bounded
    `job_error` + `errorDetail` in `job_terminal`, honest per-process `capabilities.maxConcurrency`
    + OPERATIONS note, async chained container teardown (`dispose`), IPC-profile flag merged
    (default OFF proven by full-suite output). Env enablement of dedup/coalesce/obs remains an
    operational step. **NEXT UP: Tier 2 lite** (subset of item 16): `BACKTESTER_PG_POOL_MAX` +
    statement timeout + queue-depth cap → 429/Retry-After + SDK retry/backoff — the guard before
    any load growth; specs 17b/17c in parallel or after, no perf refactor before backpressure.
    Original item text (env + stale surfaces):
    - ✅ **DONE (2026-07-04) — dedup + coalescing + obs enabled in the working env, durably.**
      `deploy/vps/` (env template + `up.sh`/`down.sh`, dedup+coalesce+obs ON) is the version-controlled
      single-user launch config; code defaults stay OFF. Verified live on the VPS: three identical
      long_oi runs → engine ran EXACTLY ONCE (leader `miss` engineMs 4227; concurrent follower coalesced
      `hit`/engineMs null/queueWait 4948; later `hit`/engineMs null/queueWait 19). `/statsz` `{hit:2,miss:1}`,
      Pg-durable. See OPERATIONS.md § "Recommended single-user working-env config".
    - `/statsz`: add queue depth + oldest-queued age (`countByStatus()` follow-up) — today a backlog is invisible; this is also the KEDA scaling metric.
    - Fix `/v1/capabilities` advertising a stale hardcoded `maxConcurrency: 1`.
    - **Worker error visibility:** `processNextQueued`'s catch maps `err` to a terminal code and DROPS the
      error itself — nothing is logged (2026-07-03 measurement session had to patch a debug line in to see
      `buildOverlayDataset: unknown dataset`). Log a bounded error line (and consider a bounded
      `failureDetail` on the job) at terminal time.
    - **Async docker teardown:** `DockerDriver.kill/remove/inspectState` use `spawnSync` — every session
      teardown blocks the worker event loop for a docker CLI round trip; convert to async spawn.
    - **Merge the IPC-profile instrumentation** (branch `perf/ipc-profile`, flag-gated
      `BACKTESTER_IPC_PROFILE`, zero default cost) — needed to re-profile on the VPS.
15. ✅ **SHIPPED + MEASURED — Tier 1 — lab-side parallelism (`trading-lab`; biggest ROI, no engine changes).**
    Merged as trading-lab PR #126 (squash `b82d0ea`, 2026-07-03): bounded-parallel `ParamGridRunner`
    (`RESEARCH_GRID_CONCURRENCY`, default 4), BullMQ `LAB_QUEUE_CONCURRENCY` knob (default 1),
    train ∥ holdout overlap, `run_pending` resume deferred to the webhook/resume spec.
    **Measured** (2026-07-03, real long_oi bundle × 8-point grid via the shipped
    executor path, local split stack: fresh mock-platform w/ discover-1m #21 + Pg + Docker sandbox,
    dedup/coalesce/obs ON, disjoint params so 16/16 fresh engine runs):
    - 1 worker process (`WORKER_CONCURRENCY=4`): 1.51× — in-process slots do NOT overlap the
      strategy engine (sync-IPC serialization, the known #2-pool result); `queueWait` ramps while
      jobs chain one-by-one.
    - 4 worker processes × concurrency 1 (the OPERATIONS-recommended shape): **82.8 s → 46.5 s
      = 1.78×**, engine-time in flight ≈ 3.4×, per-run engine inflates 9.3 s → 19.8 s from
      single-host Docker/CPU contention — matches the known ~1.8×/host ceiling (item 9).
    **Conclusion:** lab-side serialization is gone (submission saturates all worker slots);
    the next wall-clock win is Tier 3 scale-out (more worker nodes), not more lab concurrency.
    Operational note: for strategy workloads prefer process-per-slot workers; in-process
    `WORKER_CONCURRENCY>1` only helps the async overlay engine.

15b. **(was 15) Original Tier 1 item text for reference:**
    - `ParamGridRunner.runGrid` submits strictly sequentially (`for … await`, up to 8 points/round) — parallel submit-all-then-poll (bounded) turns "8 × ~30 s serial" into "~30 s parallel"; grid points differ by params so server-side coalescing can NOT collapse them.
    - BullMQ worker created without `concurrency` option (default 1) — one experiment in flight per lab process; add a knob.
    - Executors poll (`PLATFORM_RUN_MAX_POLLS`=30 × `PLATFORM_RUN_POLL_DELAY_MS`=2000 ≈ 60 s hard budget) and fail the experiment `INCONCLUSIVE 'run_pending'` on expiry, even though `callbackUrl` + outbox webhooks are plumbed end-to-end — switch to webhook-driven completion with poll fallback; `run_pending` should resume, not fail.
    - Baseline lane is serial (sanity → train → holdout); train ∥ holdout is free parallelism once the sanity boundary resolves.
16. ✅ **Tier 2 lite SHIPPED + cross-repo loop CLOSED (2026-07-04).** Backtester PR #80 (squash
    `570e667`): `BACKTESTER_PG_POOL_MAX` + `BACKTESTER_PG_STATEMENT_TIMEOUT_MS` (migrations on a
    dedicated no-opts pool), `JobStore.findByResumeToken` + anchored submit flow (replay pre-lookup
    BEFORE bundle write), `BACKTESTER_QUEUE_MAX_DEPTH` → 429 `rate_limit`/`queue_full` +
    `Retry-After`, SDK safe retry. Regression fix PR #81 (async dispose leaked containers — one
    detached `sh -c kill;rm` now). **sdk-v0.7.0 RELEASED** (PR #82: Retry-After clamp 60s +
    `retryAfterS` on `BacktesterRateLimitError`). **Lab re-pin + `rate_limited` mapping MERGED**
    (trading-lab#131, squash `e716fab`). **Controlled backpressure test PASS** (cap 2, burst 6):
    live 429 `{status:429, code:queue_full, category:rate_limit, retryAfterS:5}` → lab maps
    `rate_limited`; resumeToken replay 202-bypasses a constrained queue; 6/6 drained, no backlog.
    Known semantics (documented): a SIMULTANEOUS submit wave passes the racy cap check — the cap
    guards standing backlog, not one wave. ✅ **REMAINING item-16 tails SHIPPED (PR #84, squash
    `842a557`, 2026-07-05): bundle-by-ref (`PUT`/submit-by-hash, fingerprint-invariant → dedup HIT,
    SDK 0.8.0) + LISTEN/NOTIFY worker wake (`BACKTESTER_QUEUE_NOTIFY`, both default OFF, Pg-only).**
    Original note (both were): bundle-by-ref,
    LISTEN/NOTIFY — **2026-07-03 review: these two are the recommended cheap pre-load tails**
    (bundle-by-ref kills the ~1 MiB × grid-points re-upload; LISTEN/NOTIFY kills worker/lab poll
    latency + Pg load at hundreds of runs); do them before Tier 3 scale-out. Original item text:
    - `POST /v1/runs` has NO backpressure: no rate limit, no queue-depth cap, no 429 — a 500-submit burst is silently accepted and expires after 6 h. Add queue-depth cap → `429` + `Retry-After`; add SDK retry/backoff and a `rate_limited` mapping in lab's `toGatewayError` (currently absent).
    - `db/pool.ts` passes only `connectionString` — pg default `max=10` connections, no knob, no statement timeout; submit ≈ 4–5 sequential Pg round trips, so bursts + worker claim/heartbeat traffic contend invisibly. Add `BACKTESTER_PG_POOL_MAX` + timeouts.
    - Bundle-by-ref: `BundleStore` is already content-addressed — expose `PUT /v1/bundles` + submit by hash. Lifts the ~1 MiB inline-bundle body pressure and stops lab re-uploading identical bytes per grid point.
    - LISTEN/NOTIFY queue wake instead of polling (existing coalescing-design follow-up).
17. **Tier 3 — fresh-miss cost (GATED: only after Tiers 0–2 are live and misses still hurt — the item-11b/12 warm-pool gate).**
    - Warm container pool (security-sensitive, deliberately deferred).
    - Tape cache: `TAPE_CACHE_MAX_ENTRIES` default 16/process collapses under many distinct symbol/period keys across M workers — raise it, verify single-flight in `getOrBuild`, consider worker-start warm-up.
    - Streamed (not buffered) S3 artifact writes; move bundle `put` off the submit hot path.
    - Scale-out: more worker nodes + KEDA on the (new) queue-depth metric.
    - **Cluster proving run (2026-07-03 review):** the K8s/KEDA reference manifests (items 6–9)
      have never executed on a real multi-node cluster — a 2-node proving run is part of Tier 3,
      before "hundreds in flight" can be promised.
17a. **IPC profile — MEASURED (2026-07-04, WSL2, long_oi, instrumentation on branch `perf/ipc-profile`).**
    Sandboxed strategy-run engine time splits ≈ **45–50% IPC-wait** (~3 ms/hook, pipe RTT + in-sandbox
    compute) / **~20% container open** (~1.5–2 s warm, 4 s cold, PER SYMBOL) / **~30% host CPU**
    (context serialize + sim + risk/exec). Corrects an earlier wrong assumption: there is NO
    strategy-vs-overlay async split — one engine (`runner.ts::runBacktest`), one
    `SandboxSession`/`AsyncIpcChannel` (`SyncIpcChannel` deleted in PR #45). The in-process
    serialization at `WORKER_CONCURRENCY=4` is explained by host CPU sharing one JS thread +
    `spawnSync` teardown — process-per-slot stays the right worker shape until 17b/17c land.
    First action after the VPS move: re-profile there (WSL2 inflates pipe RTT and docker spawn).

17b. ✅ **IMPLEMENTED, default OFF (PR #83, squash `a08c4d5`, 2026-07-05) — Speculative bar batching.**
    Refactor-first (`runSymbol` → `preBarStages`/`processBar`, golden-proven before feature code);
    `hookBatch` protocol with in-harness early-stop (no rollback exists), eager-build +
    snapshot-rewind tail boundary, hostile-line fail-closed; engine gate
    (flag+method+flat+no-overlays); batch prefix reuses lockstep per-bar helpers. **Golden gate:
    lockstep vs N=2/3/64 `result_hash` byte-identical FIRST RUN + determinism replay.** Flags:
    `BACKTESTER_BAR_BATCHING` (default false) / `BACKTESTER_BATCH_BARS` (64, clamp ≥2).
    **⛔ VPS-MEASURED 2026-07-04 — KEEP OFF for long_oi (and any signal-dense strategy).** Clean
    A/B on the VPS (89.124.86.84, 2c/4GB, real Docker sandbox, mock 1m, long_oi BEATUSDT half-day,
    warm container), lockstep control run BOTH before and after the batched series to rule out load
    drift:
    - lockstep: **867 hookCalls, ipcWait 561–624 ms, engineMs 1287–1818**
    - batched N=64: **867 hookCalls (UNCHANGED), ipcWait 1251–1302 ms, engineMs 3609–3956**
    Batching made the run **~2.2× SLOWER on engine, ~2.1× more IPC-wait, with ZERO hookCall
    collapse.** Root cause: long_oi returns a non-empty decision (or is in-position) on essentially
    every bar, so the speculative batch **always early-stops at offset 0** — each flat bar pays the
    full eager-build of up to 64 contexts + serialize + ship, the harness runs bar 0, and the host
    rewinds/discards the other 63 and rebuilds. The designed graceful-degradation (`trades every
    bar ⇒ batch size 1`) is **not free** — it is a ~2× speculative-build tax whenever the batch
    never lands a multi-bar hit. **17b only pays off for strategies that emit EMPTY decisions across
    long genuinely-flat stretches** (the batch collapses N→1 message only then). long_oi is a
    worst-case, not a beneficiary. **Decision: flag stays default-OFF AND stays OFF in the working
    env for the current strategy set. Do NOT enable per-strategy without a per-strategy A/B showing
    a hookCall collapse first.** The correctness work is not wasted (golden gate proves byte-identity
    and the mechanism is sound) but the perf lever is workload-gated. Reframes 17c: the universe
    session (one container, one message/bar for ALL symbols) is the transport win that does NOT
    depend on strategy signal density — prioritize 17c over any 17b tuning. Original design text:
    Protocol before this change was strict lockstep
    NDJSON, 1 message per hook per bar. Batch FLAT stretches (no position, no pending decisions —
    snapshots are then a pure function of the tape): send N bars in one message, harness replays them
    in order against the live instance, host rolls back to the FIRST bar with a non-empty decision and
    resumes lockstep while in-position. Degrades gracefully: a strategy that trades every bar ⇒ batch
    size 1 ⇒ today's behavior. Flag-gated default OFF; merge gate = golden byte-identical
    `result_hash` lockstep-vs-batched on real bundles (INV-6 / twin-equivalence pattern).

17c. ✅ **SHIPPED (PR #85, squash `993c497`, 2026-07-05) — Universe session** (container-collapse
    ONLY, byte-identical; `BACKTESTER_UNIVERSE_SESSION` default OFF, strategy+overlay symmetric
    2N→2). **Measured on REAL data 2026-07-05** (long_oi × 3-symbol, VPS `:8088`): container-open
    1036ms→7ms (spawn collapsed), engineMs 3447→2086 (1.65×), byte-identical. **bar-major/message-
    collapse VERDICT: JUSTIFIED for large N** — faithful OFF profile ipcWait ~44% of engine at N=3,
    scales ~linearly (universe-collapse cuts spawn, NOT round-trips — that's bar-major's job); it
    stays a deferred own slice (changes portfolio-apply order → result_hash). Follow-up: universe-
    mode `ipc_profile` under-counts hookCalls (1281 vs 2157). Original design text: Today: one
    container per (module, symbol) — a 300-symbol run means 300 spawns (~8–10 min), ~38 GB of
    container memory caps, and ~300 messages per bar (~864k round trips per 2-day run). Redesign:
    ONE container per bundle hosting N per-symbol strategy instances (same isolation semantics —
    the security boundary is bundle↔host, not symbol↔symbol), ONE message per bar carrying all
    symbols' increments, decisions returned as a batch and applied through the portfolio in the
    SAME fixed order as today (determinism / `result_hash` preserved). Container memory cap becomes
    a function of N (`base + k×N`). Per-symbol failures fail-closed inside the harness (one symbol
    dies, the rest live); only a real process crash kills the run. Scaling top-300 → top-400 = +33%
    payload/memory/host-CPU, zero architectural change. EXPLICITLY OUT OF SCOPE: portfolio
    semantics for concurrent signals (sequential shared-portfolio pass per bar stays as-is — a
    product decision, not a transport one). Composes with 17b (multipliers stack).
    Adjacent candidate (2026-07-03 review, Nautilus-inspired): **binary IPC framing** (msgpack
    instead of NDJSON) if IPC-wait still dominates after 17b — measure first, don't pre-build.

    **Recommended order (2026-07-04):** Tier 0 hygiene slice (item 14) → Tier 2 lite (Pg pool knob +
    429 backpressure + SDK retry from item 16) → specs for 17b + 17c (writable now, perf-validated on
    the VPS after re-profiling per 17a). Warm-pool (item 12 tie-in) is largely subsumed by 17c for
    the universe case; keep it gated as before for single-symbol misses.

18. **Tier 4 — B2C / multi-user gate (extends item 10; open BEFORE public multi-user).**
    - Per-tenant queued/running quotas + admission control + priority tiers (`tenantId` WHERE-predicate hook already in place).
    - Real per-client authn (today: one static bearer token compared with `===`) + per-token rate limits.
    - Sandbox isolation upgrade (gVisor/Kata/Firecracker, item 12) becomes **mandatory**, not optional, once arbitrary third-party strategies run at scale.
    - Artifact GC/TTL + dedup-cache TTL/LRU pruning (existing item-11 follow-up); cost metering per tenant (attempt-charging seam exists).
    - Obs: p50/p95 percentiles, cross-replica `/statsz` aggregation, queue-wait by tenant.
    - Sandbox isolation note (2026-07-03 review): **gVisor runs WITHOUT KVM** (systrap platform) —
      unlike Firecracker it is viable on cheap KVM-less VPSes, making it the realistic item-12
      upgrade path when this gate opens.

19. **Streamed progress / partial results (LEAN-inspired; product-facing, low priority).**
    Today a run exposes only terminal `status`/`result`; long universe runs (17c) and B2C UX want
    incremental progress (bars processed, partial equity curve, per-symbol completion). Candidate
    transport: server-sent events or periodic progress rows next to `job_terminal`. Do NOT start
    before 17c lands — the useful granularity depends on the universe-session shape.

### Phase D addendum — 2026-07-03 architecture review (competitive scan)

Whole-system review (readiness under load + lab/platform integration + competitor comparison:
QuantConnect LEAN, Nautilus Trader, VectorBT, Freqtrade, cloud multi-tenant platforms). Verdict:
**no architectural redesign required** — capacity is linear in worker slots; the one real
architectural evolution ahead is 17c (per-bundle universe session), which mirrors LEAN's
node-per-algorithm model and is already designed.

- **Competitive strength to preserve as an invariant:** deterministic `result_hash` + byte-identity
  golden gates on every perf mechanism + Ed25519-signed evidence + content-addressed artifacts.
  No open-source competitor (LEAN/Nautilus/VectorBT/Freqtrade) offers provable run reproducibility;
  every future slice keeps the golden-gate merge bar.
- **Gap ranking (2026-07-03):** (1) enable validated dark-launched flags in the working env
  (dedup+coalesce+obs; batching after VPS re-profile); (2) cheap item-16 tails (LISTEN/NOTIFY,
  bundle-by-ref) before load grows; (3) 17c per residual profile split; (4) Tier 3 cluster proving
  run; (5) item-18 B2C gate as one package (auth is the #1 B2C blocker: static bearer `===`,
  no per-token limits; plus artifact/dedup-cache GC/TTL and Prometheus-style metrics export).
- Borrow list: LEAN → 17c shape + streamed progress (item 19) + per-plan node pools (item 18);
  Nautilus → binary IPC framing (17c note); VectorBT → trusted-side vectorized precompute (tape
  cache already covers most); gVisor → item-18 note above.

## Definition of Done

The system is “working” when (✅ except the real-platform data path):

- `trading-lab` submits hypothesis backtests to `trading-backtester` by default ✅
- `trading-backtester` executes the overlay path with sandboxing ✅
- results and artifacts come back correctly ✅
- historical data comes through the **real** platform contract (mock proven; real-platform path VERIFIED live 2026-07-05 — contract + auth + single/multi-symbol runs; default-flip + hardening + real-platform E2E gate pending — Phase A)
- `sp4_mock` is no longer written (✅; type member retained for legacy read back-compat)
