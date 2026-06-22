# trading-backtester

Standalone research-backtesting service for the `trading-*` ecosystem. It accepts strategy/hypothesis
modules from `trading-lab`, runs deterministic research backtests, stores its own async job lifecycle
and result artifacts, and serves status/result/artifacts over HTTP. It holds **no exchange credentials**
and fetches historical data through a platform-owned data port (so real `trading-platform` and a future
`trading-mock-platform` are interchangeable).

See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the full MVP architecture and decisions.
See **[docs/OPERATIONS.md](docs/OPERATIONS.md)** for cross-repo release ordering, CI gates, and local smoke workflow.

## Status

**Slice 1 (thin spine)** — HTTP API + async lifecycle + idempotency + content-addressed artifact store
+ deterministic `result_hash`, on a small fixture. Minimal momentum runner behind the `runBacktest`
seam (not a full engine lift), in-process fixture data port, trusted in-process executor.

**Slice 2 (durable store + outbox/webhook)** — Postgres `JobStore` (`PgJobStore`) behaviorally
equivalent to the in-memory one: atomic conditional `transition` (terminal statuses immutable),
concurrency-safe `claimNextQueued` (`FOR UPDATE SKIP LOCKED`), `resumeToken` idempotency that survives
process restart. Completion outbox + best-effort webhook delivery with retry. The full behavioral suite
runs against **both** stores (parametrized); the golden `result_hash` is identical across backends.

**Slice 3 (sandboxed untrusted bundles)** — a submitted `moduleBundle` is content-addressed (`bundleHash`)
in the backtester's **own** registry (ADR §12.5, variant A) and executed in a locked-down Docker
container: `--network none`, read-only rootfs, `--cap-drop ALL`, no env/secrets, cpu/memory/pids limits.
The runner keeps the same `(request, deps)` seam — an executor produces signals (trusted momentum
in-process, or the sandboxed bundle); sizing/metrics stay trusted. Same bundle → same `result_hash`
(independent of the sandbox environment). Limit violations map to a clean terminal status + code
(`timed_out`/`sandbox_timeout`, `failed`/`sandbox_memory_exceeded`|`sandbox_module_error`), never a
service crash.

**Slice 4 (networked data API)** — `platformDataClient` gains an `HttpDataPort` implementing the same
`BacktesterDataPort`/`HistoricalDatasetReader` seam as the fixture reader; selection is config-driven
(`BACKTESTER_DATA_SOURCE=fixture|http`). The backtester gets historical data **only** through this
networked Research Historical Data API (no direct parquet/snapshot mount), credential-free. Rows stream
by range/symbol with cursor paging (back-pressure; no whole dataset in memory). A reference data-API
server (`createDataApiServer`, what trading-platform / trading-mock-platform implement paritetically) is
included for dev + parity tests. The materialized tape + `dataset_fingerprint` are **identical** across
the in-process and HTTP paths, so the golden `result_hash` is unchanged regardless of transport.

**Slice 5 (trading-lab cutover — client boundary)** — `trading-lab` cut over to `@trading-backtester/sdk`
(the published SDK tarball). `HttpBacktesterAdapter` in `trading-lab` implements `ResearchPlatformPort`
using `BacktesterClient` from `@trading-backtester/sdk/client` — so backtest submit/status/result/artifacts
flow trading-lab → BacktesterClient → trading-backtester, independent of the platform client. The legacy
`packages/client` package was removed from this repo in Phase 3 after the cutover was confirmed.

**Slice 6a (trusted overlay-engine lift)** — the full platform research backtest engine (baseline +
overlay-variant simulation, overlay composition at `onBarClose`/`onPositionBar`, a real
`ComparisonSummary`) is lifted into `apps/backtester/src/engine/**` (a 15-file runner + indicator
engine + ajv 017 validation), running through the **trusted in-process executor**
(`createTrustedRegistry` over the lifted `short_after_pump` strategy + `early_exit_short_after_pump`
overlay). It is a parallel, flag-gated path: a new request discriminator
`engine: 'momentum' | 'overlay'` (default `momentum`) selects it in the worker, and availability is
gated by `BACKTESTER_ENABLE_OVERLAY_ENGINE` (default **off**) — an `engine:'overlay'` submission while
disabled is rejected pre-queue with `validation_error`. Overlay runs return a real
baseline-vs-variant **`comparison`** block (additive/optional on `RunResultSummary`; momentum
summaries omit it; `RunResultSummary` and `ComparisonSummary` from
`@trading-backtester/sdk/contracts` carry it). Determinism is byte-for-byte identical to `trading-platform`'s `runBacktest`: the engine reuses
the verbatim `src/determinism/{canonical-json,rng}`, and the lift's overlay `result_hash` is
**platform-derived** and pinned (`baseline sha256:0be9931c…`, `variant sha256:e381659c…`). Parity is
enforced by the platform's `scripts/verify_018_{baseline,overlay_variant,determinism}.mjs` run in
`VERIFY_018_TARGET=http` mode against the live service — asserting the service `result_hash` equals the
in-process golden — which is the required gate before any cutover. The momentum/signals path and its
golden `sha256:eff10116…` are unchanged. **Slice 6b-A is now landed in this repo: untrusted
sandboxed overlay-module execution (the per-bar-IPC `SandboxModuleExecutor` lift) is implemented,
Docker-gated, and wired into the overlay-engine path. Follow-ups remain in downstream cutover work:
Slice 6b-B (trading-lab switches from `baselineOnlyComparison` to the real `comparison` flow and
submits untrusted overlay bundles through the backtester) and Slice 6b-C (retire `sp4_mock` after the
new path becomes the default).**

## Public SDK

`packages/sdk` is the canonical public package: **`@trading-backtester/sdk`** (Apache-2.0). It
ships five subpath exports — the root `.` (for `SDK_VERSION` / capabilities) plus four named
subpaths (`/contracts`, `/builder`, `/client`, `/artifacts`). Install from a GitHub Release tarball
— no npm registry required:

```sh
pnpm add https://github.com/alexnikolskiy/trading-backtester/releases/download/sdk-v0.1.0/trading-backtester-sdk-0.1.0.tgz
```

A manual GitHub Actions release workflow (`.github/workflows/sdk-release.yml`) exists but **`0.1.0`
has not been published yet** by this plan.

The determinism core (`canonical-json`, content hashing) lives in the SDK; the service consumes it
via thin re-export wrappers in `apps/backtester/src/`. `@trading/research-contracts` remains
**private** for historical/engine-only types (`HistoricalDatasetReader`, canonical rows, engine
context/decisions/indicators/market-tape).

**No live execution or exchange credentials were introduced.** The SDK is a pure authoring and
API-integration library (research-only invariant intact).

## Layout

```
packages/sdk                  # @trading-backtester/sdk — canonical public SDK (contracts/builder/client/artifacts)
packages/research-contracts   # @trading/research-contracts — shared 017/022 types + historical data port (parity anchor; PRIVATE)
apps/backtester               # the service
  src/determinism/            # canonical-json + seeded rng (lifted verbatim from platform 018) + content hashing
  src/runner/                 # minimal deterministic momentum runner (runBacktest seam)
  src/data/                   # BacktesterDataPort: fixture reader + HTTP data-API client + reference data-API server
  src/runner/                 # ModuleExecutor seam: trusted momentum executor + runBacktest
  src/jobs/                   # 8-state lifecycle, JobStore (in-memory + Postgres), fingerprint, submit, worker, completion/outbox
  src/sandbox/                # bundle model + content-addressed registry + Docker driver + SandboxModuleExecutor
  src/artifacts/              # content-addressed artifact store + manifest
  src/db/                     # pg pool + forward-only migration runner
  src/api/                    # Fastify HTTP API
  migrations/                 # 0001_init.sql, 0002_bundle_hash.sql
  sandbox-harness/            # entry.mjs — trusted in-container harness (plain ESM)
  fixtures/candles/           # smoke dataset
  test/                       # determinism, idempotency, e2e, restart, completion, concurrent-claim, bundle, sandbox
```

## Develop

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm start          # serves on 127.0.0.1:8080 (BACKTESTER_AUTH_TOKEN, default "dev-token")
```

### Postgres (Slice 2)

Set `DATABASE_URL` to run the service on `PgJobStore`; without it the service uses the in-memory store.
To run the suite against Postgres as well (otherwise the pg-parametrized tests **skip**, they do not fail):

```bash
docker run -d --name bt-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=backtester_test \
  -p 55432:5432 postgres:16-alpine
BACKTESTER_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/backtester_test pnpm test
```

Each test run isolates itself in a throwaway schema (created + migrated, dropped on teardown).

### Sandbox (Slice 3)

Submitting a `moduleBundle` on `POST /v1/runs` runs untrusted code in a Docker container, so the host
needs a Docker daemon and the `node:24-alpine` image. The sandbox tests are **gated on Docker** — they
**skip** (never fail) when no daemon is reachable. To run them:

```bash
docker pull node:24-alpine
pnpm test   # sandbox tests run when Docker is available
```

The bundle's entry exports `signals(candles, seed): boolean[]`; the trusted runner consumes those
signals (sizing/metrics stay trusted). Tune limits with `BACKTESTER_SANDBOX_*` env vars.

### Data source — in-process vs HTTP (Slice 4)

By default the service reads the local fixture datasets in-process. To fetch historical data over the
networked Research Historical Data API instead (the contract real `trading-platform` /
`trading-mock-platform` serve):

```bash
# terminal 1 — run the reference data API over the local fixtures (stands in for platform/mock)
pnpm --filter @trading-backtester/service start:data-api      # listens on :8081

# terminal 2 — point the backtester at it
BACKTESTER_DATA_SOURCE=http BACKTESTER_DATA_API_URL=http://127.0.0.1:8081 pnpm start
```

The HTTP path is parity-tested against the in-process reader (identical materialized tape +
`dataset_fingerprint`). Tests that target an **external** data API are gated on
`BACKTESTER_TEST_DATA_API_URL` and **skip** (never fail) when it is unset/unreachable.

### Real historical data — cutover (Phase C)

`BACKTESTER_DATA_SOURCE=real` (or `mock`) routes the backtester through the canonical
`/historical/rows` endpoint (historical.2 — full `CanonicalRowV2` rows) via the in-process
`RowsDataPort`. `real` and `mock` share one implementation and **one URL env**: `mock` targets
`trading-mock-platform`, `real` targets the live `start-historical-http` platform. They differ only
semantically.

```bash
# point the backtester at a real (or mock) platform serving /historical/rows
BACKTESTER_DATA_SOURCE=real \
BACKTESTER_MOCK_PLATFORM_URL=http://89.124.86.84:8088 \
BACKTESTER_MOCK_PLATFORM_TOKEN=<token> \
pnpm start
```

| Env | Value | Effect |
|---|---|---|
| `BACKTESTER_DATA_SOURCE` | `real` / `mock` | use `RowsDataPort` (canonical `/historical/rows`) |
| `BACKTESTER_DATA_SOURCE` | `http` | use the legacy Research Historical Data API client |
| `BACKTESTER_DATA_SOURCE` | unset / other | **default** `fixture` (in-process; safe for CI/local) |
| `BACKTESTER_MOCK_PLATFORM_URL` | `http://<host>:8088` | platform base URL for `real`/`mock` |
| `BACKTESTER_MOCK_PLATFORM_TOKEN` | bearer token | optional auth for the platform |

The code default stays `fixture` (CI/local stay hermetic). Demo/prod deployments (VPS
`89.124.86.84`) set the env to flip onto the real path — done only after Phases A/B/C land green
(A, B merged; C is the consuming branch).

### Overlay engine (Slice 6a)

Set `BACKTESTER_ENABLE_OVERLAY_ENGINE=true` to enable the lifted overlay engine — runs submitted with
`engine:'overlay'` then execute the baseline+variant simulation and return a real `comparison` block;
without it, `engine:'overlay'` submissions are rejected pre-queue with `validation_error` (the default
`engine:'momentum'` path is unaffected). Deployments flip the flag on only once their CI runs the
platform `verify_018` HTTP parity gate (`VERIFY_018_TARGET=http`) green against the service.

```bash
BACKTESTER_ENABLE_OVERLAY_ENGINE=true pnpm start
```

## HTTP API (v1, bearer auth)

| Method & path | Purpose |
|---|---|
| `GET  /v1/capabilities` | contract version, supported metrics/modes |
| `GET  /v1/datasets` | list available datasets |
| `POST /v1/modules/validate` | pre-submit validation (never executes) |
| `POST /v1/runs` | submit a run → `202` + `RunJobHandle` (idempotent on `resumeToken`) |
| `GET  /v1/runs/:runId/status` | lifecycle status + timeline |
| `GET  /v1/runs/:runId/result` | compact `RunResultSummary` (metrics, evidence, `resultHash`) |
| `GET  /v1/runs/:runId/artifacts` | artifact manifest |
| `GET  /v1/runs/:runId/artifacts/:artifactId` | paged artifact body |
| `POST /v1/runs/:runId/cancel` | cancel a non-terminal run |

### Example

```bash
curl -sS -XPOST localhost:8080/v1/runs -H 'authorization: Bearer dev-token' \
  -H 'content-type: application/json' -d '{
    "mode":"research","moduleRef":{"id":"smoke","version":"1.0.0"},
    "datasetRef":"smoke-btc-1m","symbols":["BTCUSDT"],"timeframe":"1m",
    "period":{"from":"2023-11-14T00:00:00.000Z","to":"2023-11-15T00:00:00.000Z"},
    "seed":42,"metrics":[]
  }'
```
