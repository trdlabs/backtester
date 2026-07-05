# Operations — trading-* research stack

How to verify, release, and roll out changes across `trading-backtester`, `trading-lab`,
`trading-platform`, and `trading-mock-platform` without re-debugging every seam.

## Repo roles

| Repo | Role in the flow |
|------|------------------|
| `trading-platform` | Canonical research engine, historical data writer, contract gates (`gates:017`…`gates:037`) |
| `trading-mock-platform` | Credential-free ops-read + historical replay for local/demo stacks |
| `trading-backtester` | Async research job service; HTTP client boundary for `trading-lab` |
| `trading-lab` | Hypothesis orchestration; submits preset-driven overlay runs via `@trading-backtester/sdk` |

## Release ordering

When a change spans repositories, land in this order:

1. **`trading-platform`** — contract / schema / historical API changes first (`npm run check:035` or your slice gate).
2. **`trading-mock-platform`** — refresh vendored SDK + snapshot parity if platform contracts moved (`pnpm check:ci`).
3. **`trading-backtester`**
   - `packages/research-contracts` (if types changed) — wire types are now re-exported from `packages/sdk`, the single definition source (see `docs/superpowers/specs/2026-06-21-research-contracts-wire-dedup-design.md`)
   - service + tests (`pnpm check`)
   - **publish a new SDK release** if the public contract changed (see *SDK distribution & discovery* below). `packages/client` was removed (PR #22); consumers no longer use a `file:` path dep.
4. **`trading-lab`** — adapter / handler wiring last (`pnpm check`); re-pin `@trading-backtester/sdk` to the new release tarball URL and commit the lockfile **only after** the SDK release is published.

When the public contract changes, **bump and publish `sdk-vX.Y.Z` before** landing the lab cutover — lab pins an exact GitHub Release tarball, not a sibling checkout.

## SDK distribution & discovery

The public `@trading-backtester/sdk` (`packages/sdk`) ships as an **immutable GitHub Release tarball** — no npmjs, no sibling checkouts.

- **Publish:** `gh workflow run sdk-release.yml -f version=X.Y.Z` (manual `workflow_dispatch`). Fail-closed: it refuses to overwrite an existing tag/release. The job runs `pnpm check`, builds + packs + verifies the SDK, attaches `.tgz` + `.sha256` + `manifest.json`, and creates tag `sdk-vX.Y.Z`. `packages/sdk/package.json`'s version MUST equal the input.
- **Consume:** pin the exact asset URL `…/releases/download/sdk-vX.Y.Z/trading-backtester-sdk-X.Y.Z.tgz` in `package.json` and commit the resulting `pnpm-lock.yaml` (URL + integrity). A clean-clone install needs no sibling checkout.
- **Versioning:** `SDK_VERSION` (the package version, e.g. `0.2.0`) is independent of `API_CONTRACT_VERSION` (the wire version, e.g. `017.2`). An additive SDK change bumps `SDK_VERSION` only.

### Registry discovery (`GET /v1/registry`)

The backtester publishes its trusted modules + run presets so a consumer submits a **complete** overlay run without hardcoding internal module ids:

- `GET /v1/registry` (bearer-auth) → `RegistryDescriptor`: baselines, overlays, risk/exec profiles, metric catalogs, and `overlayRunPresets`. SDK method: `client.discoverRegistry()`.
- A consumer picks a preset (a complete baseline + risk + exec + metrics scaffold) and submits its own overlay bundle against it (`SubmitOverlayRunOptions.target = { kind: 'registry_preset' }`). The `default-overlay` preset advertises the full overlay metric catalog (self-sufficient).
- Single source: both `/v1/registry` and the inline overlay-execution registry derive from `TRUSTED_REGISTRY_DEFINITION` (`engine/registry-definition.ts`) — guarded by `registry-execution-consistency.test.ts`.

## Per-repo CI gates (default PR / push)

| Repo | Command | What it proves |
|------|---------|----------------|
| `trading-backtester` | `pnpm check` | `tsc` + full Vitest suite (in-memory + Pg parametrized where applicable) |
| `trading-lab` | `pnpm check` | `tsc` + Vitest (integration tests skip without env) |
| `trading-mock-platform` | `pnpm check:ci` | typecheck, contract isolation, tests, secret/dep guards |
| `trading-platform` | `npm run check:035` (or slice gate) | Research + historical contract gates |

### Cross-repo parity (local or pre-release)

| Gate | Where | Command |
|------|-------|---------|
| Mock historical parity | `trading-backtester` | `pnpm vitest run apps/backtester/test/mock-platform-parity.test.ts` |
| Platform overlay `result_hash` | `trading-platform` | `VERIFY_018_TARGET=http BACKTESTER_URL=… npm run gates:018` (HTTP mode against live service) |
| Lab → backtester → mock (3-system) | `trading-lab` | `make cross-repo-e2e MODE=demo` (requires demo stack) |

## Environment variables (cross-repo seams)

### trading-backtester

| Variable | Purpose |
|----------|---------|
| `BACKTESTER_DATA_SOURCE` | `fixture` (**code default**) or `mock` / `http` / `real` for networked historical API — see *Real platform data source* below |
| `BACKTESTER_MOCK_PLATFORM_URL` | Base URL when `DATA_SOURCE=mock` |
| `BACKTESTER_MOCK_PLATFORM_TOKEN` | Bearer for mock-platform ops/historical routes |
| `BACKTESTER_REAL_PLATFORM_URL` | Base URL when `DATA_SOURCE=real` (own pair, distinct from the mock pair) |
| `BACKTESTER_REAL_PLATFORM_TOKEN` | Bearer when `DATA_SOURCE=real` (own pair, distinct from the mock pair) |
| `BACKTESTER_AUTH_TOKEN` | Bearer for lab → backtester HTTP API |
| `BACKTESTER_ENABLE_OVERLAY_ENGINE` | `true` to allow `engine: overlay` submissions |

### Real platform data source (production posture)

`BACKTESTER_DATA_SOURCE=real` selects the same `RowsDataPort` implementation as `mock`, but points it
at the **live** trading-platform historical API instead of `trading-mock-platform`. It uses its own
env pair — `BACKTESTER_REAL_PLATFORM_URL` + `BACKTESTER_REAL_PLATFORM_TOKEN` — distinct from
`BACKTESTER_MOCK_PLATFORM_URL` / `BACKTESTER_MOCK_PLATFORM_TOKEN`; the two are never shared or
fallen back to one another.

- **Fail-fast validation:** if either var is missing, empty, or whitespace-only while
  `BACKTESTER_DATA_SOURCE=real`, `loadConfig` throws at startup — the service never boots
  half-configured:

  ```
  BACKTESTER_REAL_PLATFORM_URL and BACKTESTER_REAL_PLATFORM_TOKEN are required when BACKTESTER_DATA_SOURCE=real
  ```

- **Production posture, not the code default:** `'real'` is the **recommended production posture**
  for a deployment that must read genuine market history, but it is **not** the code default — the
  code default stays `fixture` (safe, hermetic, no external dependency) so CI/local/dev keep working
  with zero configuration. Selecting `real` is always an explicit operator choice via env, mirroring
  how `dedup`/`coalesce`/`obs` default OFF in code and are enabled only through `deploy/vps/`.

- **Token model:** `BACKTESTER_REAL_PLATFORM_TOKEN` is the **raw bearer** sent on the wire; the
  platform verifies it by checking that `sha256(token)` is present in its `HISTORICAL_HTTP_TOKENS`
  allowlist. The backtester never sees or needs the hash — only the raw token.

- **Failure taxonomy:** any platform-side failure while sourcing real data terminates the run with
  terminal code `missing_dataset` and a fixed-shape `errorDetail`:

  ```
  cause=<cause>; datasetRef=<datasetRef>
  ```

  `<cause>` is one of a finite, normalized set — raw SDK/HTTP text or tokens never surface past this
  boundary:

  | Cause | Meaning |
  |-------|---------|
  | `unauthorized` | Platform rejected the bearer (401/403) |
  | `connection_refused` | Platform unreachable (network/connection failure) |
  | `contract_version_mismatch` | Platform's historical API contract version doesn't match |
  | `rows_resource_unavailable` | `/historical/rows` returned a non-2xx, non-auth failure |
  | `dataset_not_found` | Requested dataset/symbol has no data on the platform |
  | `discover_failed` | `/historical/discover` failed (dataset discovery step) |

### trading-lab (demo overlay)

| Variable | Purpose |
|----------|---------|
| `TRADING_PLATFORM_INTEGRATION` | `backtester` in demo (or `mcp` for the platform path; `sp4_mock` is retired) |
| `BACKTESTER_API_URL` | In compose: `http://backtester:8080`; on host: `http://127.0.0.1:${BACKTESTER_HOST_PORT}` |
| `BACKTESTER_API_TOKEN` | Same as `BACKTESTER_AUTH_TOKEN` in backtester |
| `LAB_OPS_READ_URL` / `LAB_OPS_READ_TOKEN` | Mock-platform ops-read for bot results |
| `TRADING_LAB_CALLBACK_PUBLIC_URL` | Public ingress base URL for backtester completion webhook (demo: `http://ingress:3000`) |
| `TRADING_LAB_CALLBACK_TOKEN` | Bearer/query token for `POST /callbacks/backtest-completed` |
| `BACKTESTER_HOST_PORT` | Host-published backtester port in demo (`8081` default; office web stays on `8080`) |
| `RUN_CROSS_REPO_E2E` | Set `true` to enable `cross-repo-e2e.integration.test.ts` |

See `trading-lab/README.md` and `.env.demo.example` for the full demo matrix.

## Local verification workflow

### 1. Unit gates (no Docker)

```bash
# backtester
cd trading-backtester && pnpm check

# lab (sibling checkout)
cd trading-lab && pnpm check
```

### 2. Demo stack smoke (Docker)

```bash
cd trading-lab
cp .env.demo.example .env.demo   # set TRADING_*_PATH siblings
make demo                        # foreground; or -d for detached
make smoke MODE=demo             # health + mock-platform + backtester probes
```

### 3. Cross-repo E2E (opt-in, demo stack must be up)

```bash
cd trading-lab
make cross-repo-e2e MODE=demo
```

Runs `cross-repo-e2e.integration.test.ts`: dataset discovery uses mock-platform refs,
submit/poll completes, `hypothesis.build` reaches `evaluated`.

### 4. Full research cycle (slow)

```bash
make e2e MODE=demo   # strategy onboard → research.run_cycle.completed
```

## Failure triage

| Symptom | Likely seam |
|---------|-------------|
| `smoke-btc-1m` datasets in lab | Backtester still on `fixture` data source — check `BACKTESTER_DATA_SOURCE=mock` |
| `result_hash` mismatch vs platform | Run platform `verify_018_*` in HTTP mode; compare overlay engine flag + bundle |
| 401 on backtester | Token mismatch: `BACKTESTER_AUTH_TOKEN` ↔ `BACKTESTER_API_TOKEN` |
| Cross-repo test skips | Export `RUN_CROSS_REPO_E2E=true` and reachable `BACKTESTER_API_URL` |

## Definition of operable

Feature 6 is satisfied when:

- Each repo has a documented `check` entrypoint and CI runs it on PR/push.
- Cross-repo parity gates are named, scripted, and listed above.
- Demo stack smoke + cross-repo E2E are one-command (`make smoke`, `make cross-repo-e2e`).
- Release ordering is explicit so agents and humans land contract changes before consumers.

## Horizontal scaling (Phase C foundation)

Split API and workers, share the queue (Postgres) and object store (S3-compatible), and let KEDA
scale workers from queue depth. Reference manifests: [`deploy/k8s/examples/`](../deploy/k8s/examples/).

### Deployment split
- **API node:** `BACKTESTER_AUTO_WORKER=false`; readiness/liveness `GET /health`.
- **Worker nodes:** run `worker-main.ts`; require `DATABASE_URL`; set a unique `WORKER_ID` (pod name),
  low `WORKER_CONCURRENCY` (1–2), and `WORKER_HEALTH_PORT` for `/healthz` (liveness) + `/readyz`
  (readiness; drops to 503 on SIGTERM during graceful drain).

### Object store (S3-compatible — MinIO first-class)
Set `BACKTESTER_STORE_BACKEND=s3` and:

| Env | MinIO (first-class) | AWS S3 |
|---|---|---|
| `BACKTESTER_S3_ENDPOINT` | `http://minio:9000` | regional endpoint |
| `BACKTESTER_S3_BUCKET` | `backtester` | your bucket |
| `BACKTESTER_S3_REGION` | any (e.g. `us-east-1`) | the bucket region |
| `BACKTESTER_S3_ACCESS_KEY` / `_SECRET_KEY` | from `Secret` | from `Secret` |
| `BACKTESTER_S3_FORCE_PATH_STYLE` | `true` | `false` |

First boot: create the bucket before starting the service — the store does not auto-create it, e.g. `mc mb myminio/backtester`.

`S3` here means the S3 **protocol/API**, not the AWS vendor — the same code runs against MinIO, Ceph
RGW, Cloudflare R2, or AWS S3. Default backend is `filesystem` (dev/CI). `@aws-sdk/client-s3` is an
optional dependency imported only on the S3 path.

### KEDA scaling
Scale the worker Deployment with a KEDA `ScaledObject` on queue depth
(`SELECT count(*) FROM backtest_job WHERE status = 'queued'`). DB credentials go through a
`TriggerAuthentication` + `Secret`, never plaintext. Use `ScaledObject` (long-lived worker), **not**
`ScaledJob` — that needs a worker-once mode we have not built.

### Capacity budget
Sandbox sessions are per module+symbol on each node's Docker daemon. Size and cap replicas with:

```
peak sandbox memory ≈ max_pods × WORKER_CONCURRENCY × avg_symbols_per_run × sandbox_memory_mb
peak sandbox CPU    ≈ max_pods × WORKER_CONCURRENCY × avg_symbols_per_run × sandbox_cpus
```

Prefer many modest workers over few large ones, and set KEDA `maxReplicaCount` from these formulas so
you do not exhaust a node's Docker daemon.

`GET /v1/capabilities` reports `maxConcurrency` as the **per-worker-process** concurrency
(`WORKER_CONCURRENCY` of the API process's config). It is NOT fleet-wide capacity: in split
topology the API cannot see how many worker replicas exist. Fleet capacity = `worker_pods ×
WORKER_CONCURRENCY` — see the capacity-budget formula above.

## Bar batching (Phase D 17b — dark launch)

- `BACKTESTER_BAR_BATCHING` (default **false**) + `BACKTESTER_BATCH_BARS` (default 64, clamped ≥2):
  batches flat-stretch `onBarClose` calls into ONE sandbox IPC message with in-harness early-stop
  at the first signal. Attacks the measured ~45–50% IPC-wait share of a sandboxed strategy run.
- **Results are provably unchanged**: batching never alters `result_hash` — enforced by the
  Docker-gated golden suite (`bar-batching-equivalence.test.ts`: lockstep vs N=2/3/64 byte-identity
  + determinism replay). Because of this invariant, batching does NOT (and must never) enter
  `computeIdentity` — dedup/coalescing keys are unaffected by the flag.
- Rollout playbook (same as dedup/coalescing): merge default OFF → enable in the working env →
  quantify on the VPS re-profile (17a). Expected win scales with how rarely the strategy trades;
  every-bar traders degrade gracefully to lockstep cost.
- Scope: sandboxed strategy runs only (`onBarClose`, flat bars). `onPositionBar`, overlays, and
  trusted/momentum executors always run lockstep.

## Backpressure & connection hardening (Phase D Tier 2 lite)

- `BACKTESTER_PG_POOL_MAX` (default 10): per-process pool cap. Fleet math: `worker_pods ×
  pool_max` must stay under Postgres `max_connections` with headroom for the API pod and admin
  sessions; 10–20/process is typical.
- `BACKTESTER_PG_STATEMENT_TIMEOUT_MS` (default 0 = off; recommended 30000): statement_timeout on
  app-pool connections. Migrations always run on a dedicated no-timeout pool.
- `BACKTESTER_QUEUE_MAX_DEPTH` (default 0 = unlimited; recommended ≈ worker_slots ×
  queue_timeout / avg_run_seconds): a NEW submit beyond the cap gets `429 { category: 'rate_limit',
  code: 'queue_full', queueDepth, maxDepth }` + `Retry-After` (`BACKTESTER_QUEUE_RETRY_AFTER_S`,
  default 30). resumeToken replays always pass (crash-recovery contract) and never re-upload
  bundles. The cap is approximate under concurrency — a backstop, not a semaphore.
- SDK (`BacktesterClient`): retries default ON — 429 always (numeric-seconds `Retry-After`
  honored; the HTTP-date form is ignored → backoff), network/502-504 only for GETs or submits
  carrying a `resumeToken`. `retry: { maxAttempts: 1 }` disables.

### Queue-wake (LISTEN/NOTIFY)

`BACKTESTER_QUEUE_NOTIFY=true` (default false; **Postgres only** — no effect on the in-memory store)
makes each worker hold one dedicated `LISTEN backtest_job_queued` connection and wake the instant a
job is enqueued (submit) or requeued (reap), instead of waiting out `WORKER_POLL_MS`. Latency-only:
polling remains the backstop, so a dropped/late notification just costs up to one poll interval —
never a stuck job. Cost: **+1 Postgres connection per worker process**, outside `BACKTESTER_PG_POOL_MAX`
(fleet math: `worker_pods × (pool_max + 1)` + API pods). Kill-switch: set the flag false.

Note: the `pg_notify` **emit** side runs unconditionally on Postgres (on every enqueue/requeue) — the
flag gates only the **LISTEN/waker** side. With the flag off there is no listener, so each emit is a DB
no-op costing one extra lightweight `SELECT pg_notify(...)` round-trip on the enqueue path; worker
claim/drain behavior is byte-for-byte unchanged. This is negligible at single-user scale; if enqueue
throughput ever becomes hot, gate the emit at construction too.

### Bundle-by-ref

`POST /v1/bundles` (body = a ModuleBundle) validates the bundle and stores it in the content-addressed
`BundleStore`, returning `{ hash }`. `HEAD /v1/bundles/:hash` reports presence. `POST /v1/runs` accepts
`bundleRef` (a `sha256:…` content hash) as an alternative to inline `moduleBundle` — exactly one of the
two. A run submitted by-ref that references an unknown hash gets `409 unknown_bundle`; the SDK self-heals
by re-uploading once and retrying with the same `resumeToken`. Fingerprint/dedup identity is
submission-style-invariant (inline X and bundleRef=hash(X) share one identity), so a by-ref submit of an
already-computed bundle is a dedup HIT.

**Multi-node:** `FileBundleStore` is host-local — a bundle uploaded to one node is invisible to another.
Cross-fleet bundle-by-ref requires the shared `S3BundleStore` (`BACKTESTER_STORE_BACKEND=s3`). On a single
node it works as-is; the `409 → re-PUT` self-heal covers a ref that misses on the wrong node (one extra
upload, never a failure). No bundle GC/TTL yet — deferred to the multi-user gate.

## Result dedup (Phase C item 11)

Skips redundant compute (engine + sandbox execution) for a run whose identity was already computed
successfully. Off by default — a pure opt-in.

- **Enable:** `BACKTESTER_DEDUP_ENABLED=true` (default `false`/OFF — the kill switch; when unset or
  `false`, `buildApp` behaves exactly as it did before dedup existed).
- **Cache key (identity):** `requestFingerprint + datasetFingerprint + DEDUP_COMPUTE_VERSION + sandbox
  policy`. Only successful `completed` runs are cached — failed/errored/cancelled runs never populate
  or satisfy a lookup.
- **Backing store:** `PgResultCache` when `DATABASE_URL` is set (same `ownedPool` `buildApp` already
  ran `migrate()` on — the dedup table and `deduped_from` column ship in migration `0004` and are
  guaranteed present before the cache is constructed); `InMemoryResultCache` otherwise (single-process,
  cleared on restart).
- **Invalidation:** bump `DEDUP_COMPUTE_VERSION` whenever engine/scoring/sandbox-policy semantics
  change in a way that would make a cached result stale. There is no automatic invalidation — the
  version bump is the mechanism.
- **Bypass:** a per-request `bypassCache` flag forces fresh compute for that run; the fresh result
  still populates the cache for subsequent identical requests.
- **Evidence runs always compute fresh:** a request with `curatedBaselineRef` set (evidence/admission
  flow) bypasses the cache entirely — no lookup and no populate — because the signed `evidenceRef` is
  produced only on the miss path and is not part of the cache identity, so a HIT would silently drop it.
- **`result_hash` is unchanged:** it is re-stamped per run regardless of cache hit/miss — dedup affects
  compute, not the result-hash contract.
- **Accepted partial (bundle-carrying runs):** a HIT on a run that carries a strategy bundle still
  loads the bundle (needed to serve the response) but skips the expensive engine + sandbox execution.
  Momentum (non-bundle) HITs skip all compute, including bundle load.

### In-flight coalescing (Phase C)

`BACKTESTER_COALESCE_ENABLED=true` (default off; requires `BACKTESTER_DEDUP_ENABLED=true`) coalesces
concurrent identical runs: the first (leader) runs the engine; the rest (followers) defer internally
(`waiting_for_compute`, shown as `running` in the public API) and complete via re-stamp once the leader's
result is cached — or take over if the leader fails/crashes. Postgres-durable only. Tunables:
`BACKTESTER_COMPUTE_LOCK_TTL_MS` (default = worker lease TTL), `BACKTESTER_COMPUTE_WAIT_MAX_ATTEMPTS`
(default 3). Off = byte-identical to the shipped dedup behavior.

### Recommended single-user working-env config (durable)

`deploy/vps/` captures the recommended single-user posture — **dedup + coalescing + obs ON** — as a
version-controlled launch config (`backtester.env.example` + `up.sh`/`down.sh`), so enabling them is
durable, not a fragile one-off env var. Copy the example to `backtester.env`, fill secrets, `./up.sh`.
Both flags default OFF in code; the config, not the default, is what enables them.

**Enablement verified live (2026-07-04, VPS 89.124.86.84, real Docker sandbox + Postgres):** three
identical long_oi runs → the engine ran **exactly once**. Leader `dedup:"miss"` (engineMs 4227);
concurrent follower `dedup:"hit", engineMs:null, queueWaitMs 4948` (coalesced — waited out the leader,
completed via re-stamp, no engine run); a later identical run `dedup:"hit", engineMs:null, queueWaitMs
19` (plain cache hit). `/statsz` `{hit:2, miss:1}`. Pg-durable, so the cache survives `down.sh`/reboot.

### Job observability (Phase C — dedup enablement)

Set `BACKTESTER_JOB_OBS=true` (default off) to turn on minimal per-job observability. Two channels:

- **Per-job terminal log line** — one JSON line per terminal job on stdout, e.g.
  `{"evt":"job_terminal","runId":"…","engine":"momentum","outcome":"completed","dedup":"hit","queueWaitMs":12,"materializeMs":40,"engineMs":null,"totalMs":55,"ts":…}`.
  `dedup` ∈ `off | evidence_bypass | bypass | hit | miss | stale_recompute`. `engineMs` is `null` only on a `hit`.
  **Interpret `dedup`/`engineMs` only for `outcome:"completed"` rows.** On a non-completed job (`failed`/`validation_error`)
  these fields report how far the job got, not a cache decision: a job that throws before the engine emits `engineMs:null`
  with whatever `dedup` class it had reached, and a job that fails before the dedup gate reports `dedup:"off"` even when
  dedup is enabled. Filter to completed rows before computing hit-rate or engine time. `totalMs` is worker wall time from
  claim to emit (includes post-run cleanup + the terminal store read), so it is slightly larger than claim→transition.
  Aggregate with `jq`, e.g. hit-rate over completed jobs:
  `grep job_terminal | jq -s 'map(select(.outcome=="completed"))|group_by(.dedup)|map({(.[0].dedup):length})'`.
- **`/statsz`** — in-process counters (count/sum/max per phase, counts by outcome and dedup class) since process start,
  served by the worker health server on `WORKER_HEALTH_PORT` (split-worker topology). Not aggregated across replicas
  (the log line is the durable, cross-replica source of truth). Combined `AUTO_WORKER=true` mode has no `/statsz` in this
  release — use the log line.

Queue **depth** is not part of `/statsz`; query it directly:

    SELECT status, count(*) FROM backtest_job GROUP BY status;

`BACKTESTER_JOB_OBS=false` (default) emits nothing and adds no runtime overhead.
