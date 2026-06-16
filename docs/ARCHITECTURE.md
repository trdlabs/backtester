# trading-backtester — MVP Architecture

> Status: **design proposal** (2026-06-16). Greenfield service in the `trading-*` ecosystem.
> This document is grounded in a read of the existing `trading-platform` implementation
> (specs 017/018/019/022/030/031/033 and `src/research/**`, `src/contracts/**`) and the
> `trading-lab` consumer (`ResearchPlatformPort` + adapters).

---

## 0. The one-sentence thesis

**This is not a greenfield build — it is an *extraction*.** `trading-platform` already contains a
complete, dependency-injected, deterministic research backtest engine, an 8-state async job
lifecycle (Postgres + outbox + reaper), a Docker sandbox for untrusted modules, a content-addressed
artifact contract, and a typed validation taxonomy. The job is to **lift those modules into a
standalone bounded context, put an HTTP API in front of the job lifecycle, and route historical
data through a platform-owned data contract** so real `trading-platform` and `trading-mock-platform`
are interchangeable. The only genuinely *new* piece is the networked data seam.

---

## 1. Bounded-context boundaries

### 1.1 trading-backtester OWNS

- Async backtest **job lifecycle** (submit / status / result / artifacts / cancel) and its own DB.
- **Deterministic research backtest execution** (the lifted runner — `runBacktest`).
- **Untrusted module execution** via a Docker sandbox (lifted from feature 019).
- **Module + run-request validation** (017/019 taxonomy).
- **Artifact storage** — content-addressed blobs + manifest (022).
- **Completion notification** — durable event outbox + best-effort webhook + polling fallback.
- A **`platformDataClient`** that fetches historical datasets through a platform-owned contract.

### 1.2 trading-backtester MUST NOT

- Run live bots, market ingestion, exchange adapters, or live execution.
- Hold **exchange credentials** of any kind.
- Mount parquet / mock snapshots directly as a primary contract — historical data **only** through
  the platform data contract, so the backtester cannot tell real platform from mock-platform.
- Share `trading-platform`'s canonical DB or own canonical market storage.
- Generate strategies / evaluate hypotheses (that is `trading-lab`) or promote strategies to live
  (that is `trading-platform`).

### 1.3 Relationships

```
trading-lab ──backtesterClient (HTTP)──▶ trading-backtester
                                              │
                                              └─platformDataClient (data contract)──▶ trading-platform
                                                                                 └──▶ trading-mock-platform
trading-lab ──platformClient──────────▶ trading-platform / trading-mock-platform   (results, Ops Read, datasets)
```

- **Consumer:** `trading-lab` calls the backtester via a typed HTTP client. `trading-lab` owns
  `Evaluation` / workflow metadata; the backtester owns job / run / artifact lifecycle.
- **Data provider:** the backtester is a read-only, credential-free consumer of the platform's
  historical data contract. It does **not** share the platform's DB.

---

## 2. Reuse map — what to lift, re-front, or leave behind

| Source (`trading-platform`) | Disposition | Notes |
|---|---|---|
| `src/contracts/research/**` (017/022 types) | **Shared library** | Lingua franca for backtester *and* trading-lab. Extract to `@trading/research-contracts`. |
| `src/contracts/historical/{canonical-row,historical-dataset-reader}.ts` | **Shared library** | Data-contract types for `platformDataClient`. |
| `src/research/backtest/**` (`runBacktest`, rng, canonical-json, execution, portfolio, metrics, registry, module-executor) | **Lift wholesale** | Pure DI core, **zero** DB/network/credential/wall-clock coupling. |
| `src/research/indicators/**` | **Lift** | Pure, candle-streaming. No I/O. |
| `src/research/validation/**` + 017 JSON schemas | **Lift** | ajv (draft-07) + committed schema files. |
| `src/research/artifacts/**` (022) | **Lift** | Content-hash, manifest, evidence bundle. |
| `src/research/sandbox/**` + in-container harness (`entry.mjs`) | **Lift** | Needs Docker daemon at runtime; harness must be built & shipped. |
| `src/research/mcp-gateway/jobs/**` (job-store, lifecycle, worker, reaper, completion) | **Lift + re-front** | Keep the `JobStore` interface + in-memory impl; write a **new** Pg impl against the backtester's own table (drop the platform `canonical` writer dependency). |
| `src/research/mcp-gateway/server.ts` (MCP) | **Re-front as HTTP** | Keep MCP as an *optional* agent-facing facade later. |
| `src/research/backtest/dataset.ts` (fixture loader) | **Replace** | Swap fixture path for `platformDataClient`. |
| `src/storage/historical/**`, `src/market/**`, `src/runtime/**`, live execution, Ops Read API (033) | **Leave in platform** | Out of scope; backtester consumes data via the contract only. |

**Coupling to delete on the consumer side (`trading-lab`):** the legacy `PlatformGatewayPort.submitBacktest`
/ `getBacktestResult` (sp4_mock) pair, the MCP transport adapter, and the direct re-export of
`@trading-platform/sdk/agent` types. Keep the `ResearchPlatformPort` *interface* as the seam.

---

## 3. Component architecture

```
                        ┌─────────────────────────────────────────────────────────┐
                        │                    trading-backtester                    │
                        │                                                          │
   HTTP (bearer auth)   │   ┌────────────┐    ┌──────────────┐    ┌─────────────┐  │
 ──────────────────────▶│   │ HTTP API   │───▶│  JobStore    │◀───│   Worker    │  │
   POST /v1/runs        │   │ (Fastify)  │    │  (Pg + mem)  │    │  (claim →   │  │
   GET  /v1/runs/:id/*  │   └────────────┘    └──────┬───────┘    │   run)      │  │
                        │         │                  │            └──────┬──────┘  │
                        │         ▼                  │                   ▼         │
                        │   ┌────────────┐    ┌──────▼───────┐    ┌─────────────┐  │
                        │   │ Validation │    │  Reaper      │    │  runBacktest│  │
                        │   │ (017/019)  │    │ (deadlines)  │    │  (lifted)   │  │
                        │   └────────────┘    └──────────────┘    └──┬───────┬──┘  │
                        │                                            │       │     │
                        │   ┌────────────┐    ┌──────────────┐  deps.router  deps.dataset
                        │   │ Completion │    │ Artifact     │       │       │     │
                        │   │ (outbox +  │    │ store (CAS)  │       ▼       ▼     │
                        │   │  webhook)  │    └──────────────┘  ┌─────────┐ ┌────────────────┐
                        │   └─────┬──────┘                     │ Sandbox │ │ platformData   │
                        └─────────┼────────────────────────────┤(Docker) │ │ Client (port)  │
                                  │                            └─────────┘ └───────┬────────┘
                                  ▼ webhook                                        │ data contract
                          trading-lab                                             ▼
                                                              trading-platform / trading-mock-platform
```

Two injection seams keep the runner pure and the service swappable:
- **`deps.router`** → trusted in-process executor (registry ref) **or** Docker sandbox (submitted bundle).
- **`deps.dataset` / `deps.marketTape`** → a `MarketTapeDataset` materialized from `platformDataClient`.

---

## 4. Minimal HTTP API (v1)

Direct rendering of the existing MCP-031 gateway tools as REST. Service-to-service, bearer-token auth,
bound to the internal network, **fail-closed on anonymous** (mirrors 031's posture).

| Method & path | Body / params | Returns |
|---|---|---|
| `GET /v1/capabilities` | — | `ResearchCapabilityDescriptor` (contract version, metrics, fill models, sandbox policy ids) |
| `GET /v1/datasets` | `ListDatasetsFilter` | `DatasetDescriptor[]` (proxies `platformDataClient` catalog) |
| `POST /v1/modules/validate` | `ValidateModuleRequest` | `ValidationReport { status, issues[] }` — **pre-submit gate, never executes** |
| `POST /v1/runs` | `RunSubmitRequest` (≈ `ControlledRunRequest`) | `202` + `RunJobHandle { jobId, runId, status:"accepted", effectiveSeed, requestFingerprint, idempotentReplay }` |
| `GET /v1/runs/{runId}/status` | — | `RunStatusView { status, timeline, terminalCode? }` |
| `GET /v1/runs/{runId}/result` | — | `RunResultSummary { metrics, comparison, coverage, artifactRefs[], evidence }` |
| `GET /v1/runs/{runId}/artifacts` | — | `ArtifactManifest` (descriptors, content-hashes, availability) |
| `GET /v1/runs/{runId}/artifacts/{artifactId}` | `offset/limit/cursor` | `ArtifactPage { page[], total, nextCursor? }` |
| `POST /v1/runs/{runId}/cancel` | — | `RunStatusView` |
| `GET /v1/runs` | filter by `correlationId/workflowId/status` | `RunStatusView[]` |

- **Idempotency:** `resumeToken` on the submit body (UNIQUE). Replay with the same token + same
  run-affecting fingerprint returns the existing handle (`idempotentReplay:true`); a different
  fingerprint under the same token → `409 resume_token_conflict`.
- **Async semantics:** submit returns `202` immediately; client polls `status`→`result`, or registers a
  webhook callback for the terminal event. Both are supported (trading-lab uses polling today).
- **Optional MCP facade:** the same operations can be re-exposed as MCP tools for agent-facing use,
  but the **service-to-service contract is HTTP + typed client**.

---

## 5. Async job lifecycle

Lifted verbatim from 031. **8 states, 5 terminal:**

```
accepted ─▶ queued ─▶ running ─▶ completed
              │         │   ├─▶ failed      (runner_failure)
              │         │   ├─▶ timed_out   (run_deadline; reaper)
              │         │   └─▶ canceled
              ├───────────────▶ canceled
              └───────────────▶ expired     (queue_deadline; reaper)
accepted ────────────────────▶ canceled
```

- **Transitions are atomic & conditional** — `transition(runId, from, to, patch)` updates only if the
  current status equals `from`. Terminal states are immutable.
- **Worker:** `claimNextQueued(now)` takes the oldest `queued` row (Pg: `FOR UPDATE SKIP LOCKED`),
  flips it to `running`, and sets `run_deadline = now + run_timeout_ms` **at claim** (queue wait never
  counts against run time). Runs the backtest in-process, writes artifacts, transitions to a terminal
  state, publishes completion. Default concurrency 1 (horizontally scalable by adding workers — the
  queue is the durable Postgres table).
- **Reaper:** SQL-clock detection. `queued` past `queue_deadline` → `expired`; `running` past
  `run_deadline` → `timed_out`. Runs periodically **and** lazily on status/result reads (so a read
  always sees the correct terminal even without a tick).
- **Cancellation:** any non-terminal → `canceled`; terminal → idempotent no-op.
- **Completion (3 layers):** (1) durable — append an event row (source of truth); (2) push —
  best-effort POST of the `CompletionEvent` to the operator-allowlisted `callback_url`; (3) fallback —
  status/result reads. An **outbox** redelivers `pending`/`failed` events with backoff.

```ts
interface CompletionEvent {
  eventType: 'job_completed'|'job_failed'|'job_canceled'|'job_expired'|'job_timed_out';
  jobId: string; runId: string; status: TerminalRunStatus;
  correlationId?: string; workflowId?: string;
  summary: RunResultSummary;   // synthesized minimal summary for non-completed terminals
  emittedAtMs: number;
}
```

---

## 6. Data access — the one new architectural piece

### 6.1 The seam

The runner consumes market data **only** through an injected `MarketTapeDataset` and reads it
point-in-time via `PointInTimeMarketApi` (structurally no-lookahead: `ts ≤ t`, deep-frozen, no
forward methods). The platform's fetch contract is `HistoricalDatasetReader`:

```ts
interface RangeQuery { tsFrom: number; tsTo: number; symbols?: readonly string[] }   // [from, to) ms UTC
interface HistoricalDatasetReader {
  queryRange(q: RangeQuery): AsyncIterable<ReaderRow[]>;            // batched per part-file, memory-bounded
  queryOneSymbolTimeSeries(q: OneSymbolQuery): AsyncIterable<ReaderRow[]>;
  close?(): Promise<void>;
}
// ReaderRow = CanonicalRowV2: OHLCV + oi_total_usd + funding_rate + liq_*_usd + taker_*_volume_usd,
// each with a has_* presence flag (present-zero ≠ missing). Cross-source aggregate; no venue column.
```

### 6.2 `platformDataClient` (the backtester's data port)

```ts
// Backtester defines this port; identical shape to HistoricalDatasetReader.
interface BacktesterDataPort {
  listDatasets(filter?): Promise<DatasetDescriptor[]>;
  queryRange(q: RangeQuery): AsyncIterable<ReaderRow[]>;
  queryOneSymbolTimeSeries(q: OneSymbolQuery): AsyncIterable<ReaderRow[]>;
}
```

- **Real vs mock interchangeability** is achieved at the *interface*. Only the transport/config differs
  (a base URL or, for MVP, a `rootPath`). `trading-mock-platform` implements the same port over
  recorded/sanitized data; `trading-platform` over its canonical store. The backtester cannot tell
  them apart — exactly the required property.
- **Credential-free, confirmed.** `HistoricalDatasetReader` imports no `market/`, `runtime/`, `bots/`,
  `execution/`, or `ccxt` — only `node:*` + a parquet lib. The backtester holds **zero** exchange
  credentials.
- **Pipeline:** stream batches from the port → materialize a `MarketTapeDataset` → inject as
  `deps.marketTape`. (The reader is streaming; the runner consumes a fully materialized tape.)

### 6.3 Cross-repo dependency (new contract to drive)

There is **no network data API today** — the platform seam is in-process. To make the boundary real,
`trading-platform` and `trading-mock-platform` must expose a **"Research Historical Data API"**: a thin
network rendering of `HistoricalDatasetReader` (the same `queryRange`/`queryOneSymbolTimeSeries`
semantics, paged, credential-free). This is a small lift on the platform side (wrap
`createHistoricalDatasetReader({rootPath})` in an HTTP route) but it is a **prerequisite for the
backtester to be filesystem-independent**, and should be specced on the platform side. Until it lands,
MVP uses the in-process reader *behind the same port* (see §10, Slice 1).

---

## 7. Storage model

The backtester owns its **own Postgres**, independent of the platform's `canonical` schema.

### 7.1 `backtest_job` (status of record — metadata & pointers only)

Modeled on `canonical.research_job`, minus the platform-canonical coupling:

```sql
CREATE TABLE backtest_job (
  job_id               TEXT PRIMARY KEY,            -- == run_id (one job per run, v1)
  run_id               TEXT NOT NULL UNIQUE,
  resume_token         TEXT UNIQUE,                 -- PRIMARY idempotency key
  request_fingerprint  TEXT NOT NULL,              -- sha256(canonicalJson(run-affecting fields))
  correlation_id       TEXT,
  workflow_id          TEXT,
  status               TEXT NOT NULL DEFAULT 'accepted'
    CHECK (status IN ('accepted','queued','running','completed','failed','canceled','expired','timed_out')),
  request_json         JSONB NOT NULL,             -- serialized RunSubmitRequest (NO secrets)
  effective_seed       BIGINT NOT NULL,
  dataset_ref          TEXT NOT NULL,
  dataset_fingerprint  TEXT,                       -- NEW: sha256 of materialized tape (drift guard)
  module_ref           TEXT,                       -- registry ref or bundle hash (also in request_json)
  bundle_hash          TEXT,                       -- for submitted bundles
  callback_url         TEXT,
  callback_target_id   TEXT,                       -- operator allowlist id (preferred)
  queue_deadline_ms    BIGINT,
  run_timeout_ms       BIGINT,
  run_deadline_ms      BIGINT,                     -- set at claim
  accepted_at_ms       BIGINT NOT NULL,
  queued_at_ms         BIGINT, started_at_ms BIGINT, terminal_at_ms BIGINT, last_activity_ms BIGINT,
  result_summary_json  JSONB,                      -- compact RunResultSummary
  result_hash          TEXT,                       -- NEW: sha256(canonicalJson(result)) — parity primitive
  terminal_code        TEXT,
  actor_id TEXT, client_id TEXT, auth_subject TEXT
);
CREATE INDEX ix_job_queue_deadline ON backtest_job (status, queue_deadline_ms) WHERE status='queued';
CREATE INDEX ix_job_run_deadline   ON backtest_job (status, run_deadline_ms)   WHERE status='running';
CREATE INDEX ix_job_queue_order    ON backtest_job (accepted_at_ms)            WHERE status='queued';
```

### 7.2 `backtest_job_event` (append-only outbox)

```sql
CREATE TABLE backtest_job_event (
  event_uid        TEXT PRIMARY KEY,
  job_id           TEXT NOT NULL REFERENCES backtest_job(job_id),
  event_type       TEXT NOT NULL,    -- job_accepted|queued|started|completed|failed|canceled|expired|timed_out
  payload_json     JSONB NOT NULL,   -- CompletionEvent for terminals
  delivery_state   TEXT,             -- pending|delivered|failed  (NULL when no callback)
  delivery_attempts INT NOT NULL DEFAULT 0,
  created_at_ms    BIGINT NOT NULL
);
```

### 7.3 Heavy bytes live outside the DB

- **Artifact store (content-addressed):** the 12 artifact kinds (trades, decision-records, simulated
  orders/fills, equity curve, …) are stored as blobs keyed by `sha256:` of `canonicalJson(payload)` —
  local volume for MVP, S3-compatible object store for scale. The DB holds only the **manifest**
  (descriptors + content-hashes + availability), never the bytes.
- **Bundle store (content-addressed):** submitted module bundles stored by `bundleHash`, referenced
  from the job.

This is exactly the "DB = metadata/status/pointers, artifact store = heavy bytes" split.

---

## 8. Determinism & parity

The determinism contract is **byte-identical canonical-JSON output**, not a stored hash:
*same `request + candles + module versions + seed` ⇒ byte-identical artifacts.* It is preserved
**for free** by lifting the runner unchanged (mulberry32 RNG seeded per-symbol, `decimal.js` scale-8
`ROUND_HALF_EVEN`, sim-clock `bar.ts`, the R8 intrabar ordering).

Net-new capabilities the standalone service should add (the seams already exist):

1. **`result_hash = sha256(canonicalJson(result))`** stored on every job — a verifiable parity
   primitive so platform-vs-backtester (or backtester-vs-backtester across machines) can be compared
   without diffing full artifacts.
2. **`dataset_fingerprint = sha256(canonicalJson(tape.toTape()))`** — detects canonical-data drift
   between the fetch at submit time and any later replay, the one place where moving data behind a
   network seam could silently break parity.
3. **Cross-service parity gate (CI):** reuse the platform's `scripts/verify_018_*.mjs` golden-master
   replay scripts against the running backtester service; require `result_hash` equality before any
   `trading-lab` cutover.

**Parity anchor:** `CONTRACT_VERSION` (currently `017.2`) and `ARTIFACT_CONTRACT_VERSION` (`022.1`)
must stay in lockstep across platform + backtester — a bump breaks byte-identity. This is *the*
reason the research contracts must be a **shared, versioned library**, not copied-and-drifted.

---

## 9. Security boundary (untrusted modules)

Modules submitted by an LLM orchestrator are **always untrusted, even our own agent's output**.
Lifted from feature 019:

- **Isolation:** one Docker container per sandbox session — `--network none`, `--read-only` rootfs +
  ephemeral `/tmp` tmpfs (`noexec,nosuid`), `--cap-drop ALL`, `--security-opt no-new-privileges`,
  seccomp, `--pids-limit`, cgroup cpu/mem caps, non-root user, image pinned by digest, **no env
  forwarded** (secrets structurally absent). The kernel boundary is the hard, fail-closed guarantee.
- **IPC:** synchronous NDJSON over the container's stdin/stdout with per-call deadline + byte quotas.
  Only the newly-closed bar `t` is streamed in (forward candles physically absent → no-lookahead is
  structural).
- **Gates:** an **acceptance gate** (bundle integrity = recompute-and-compare `bundleHash`, manifest
  schema, entrypoint path-traversal guard) runs *before any code executes*; **decision revalidation**
  re-checks every returned decision against 017 schemas *before* risk/execution. Any violation →
  forced kill, **0 orders** (fail-closed), bounded + redacted diagnostics.
- **Routing by provenance:** `provenance:'trusted'` (registry ref) → in-process executor;
  `provenance:'bundle'` (submitted) → sandbox. A single run may mix a trusted baseline with a
  sandboxed variant.

**Runtime prerequisites for standalone:** a Docker daemon, the **trusted in-container harness**
(`entry.mjs` — must be built & shipped), the pinned image pre-pulled, and the 017 JSON schemas
bundled. The error taxonomy is the two-tier union (017 ∪ 019), surfaced through the 6-category gateway
error vocabulary (`validation_error`, `missing_dataset`, `unsupported_data_needs`,
`sandbox_module_error`, `runner_failure`, `internal_gateway_error`).

---

## 10. Migration path (strangler-fig, no big-bang)

1. **Extract shared contracts** → `@trading/research-contracts` (017/022) + historical row/reader
   types. Platform keeps its copy until cutover; consumed by backtester from day 1. *Non-breaking.*
2. **Stand up the backtester service** reusing the lifted runner + jobs + artifacts, with its own DB
   and artifact store. Initially it may read the **same data source as the platform** (in-process
   reader, same `rootPath`) to prove parity before the network data API exists.
3. **Parity gate green** — run the platform's 018 golden-master replays against the service; require
   `result_hash` equality. Do not proceed until green.
4. **trading-lab dual-adapter** — keep the `ResearchPlatformPort` interface; add an
   `HttpBacktesterAdapter` next to the existing `LazyMcpResearchPlatformAdapter`; select via the
   existing `selectResearchPlatform('mcp'|'http'|'mock')` flag. Route a fraction of workflows over.
5. **Cut over** trading-lab once parity + load are proven. Retire `PlatformGatewayPort.submitBacktest`
   (sp4_mock).
6. **Platform stops exposing the 031 gateway** — the backtest runner *code* can remain in platform as
   a library (shared package) and be removed from the platform's service surface later. **No code is
   deleted to cut over.**
7. **Network data API** — platform + mock-platform expose the Research Historical Data API; the
   backtester flips `platformDataClient` from in-process reader to HTTP, becoming
   filesystem-independent. This is the last decoupling, and can lag the cutover.

---

## 11. First vertical slice (and the sequence after)

### Slice 1 — "Trusted run, local data behind the port, full lifecycle spine"

The thinnest end-to-end that proves the architecture:

- HTTP server: `POST /v1/runs`, `GET /v1/runs/{id}/status`, `GET /v1/runs/{id}/result`,
  `GET /v1/runs/{id}/artifacts/{artifactId}`.
- **In-memory `JobStore`** + worker + reaper (lifted). Pg store deferred to Slice 2.
- Lifted `runBacktest` executing a **trusted registry-ref module** — `InProcessTrustedModuleExecutor`.
  **No Docker yet.**
- `platformDataClient` **interface defined**, backed for now by the lifted `HistoricalDatasetReader` /
  fixture reader (local) — proves the seam without needing the network API.
- Artifacts to a local content-addressed directory; manifest + summary persisted.
- **Determinism gate:** reuse platform's 018 golden-master to assert byte-identical output through the
  service; record `result_hash`.
- Idempotency via `resumeToken`. Returns `RunJobHandle`. Callable by a `curl`/integration test or an
  early `HttpBacktesterAdapter`.

**Proves:** HTTP API + async lifecycle + runner parity + artifact store + idempotency — the spine.

### Subsequent slices

- **Slice 2:** Pg `JobStore` (own DB) + outbox + webhook completion + persisted deadlines/reaper.
- **Slice 3:** Docker sandbox + in-container harness for **submitted bundles** (untrusted execution).
  Bundles are self-contained, content-addressed (`bundleHash`), and stored in the backtester's own
  registry (decision §12.5, variant A) — no platform registry on the execution path. Same bundle →
  same `result_hash` (determinism independent of the sandbox environment). Limit violations (time /
  memory / crash) map to a clean terminal status (`timed_out` / `failed`) with a precise
  `terminal_code`, never a service crash.
- **Slice 4:** Network Research Historical Data API on platform/mock; switch `platformDataClient` to
  HTTP; mock-platform parity.
- **Slice 5:** trading-lab cutover behind the flag; retire sp4_mock; publish `@trading-backtester/client`.

---

## 12. Decisions (locked 2026-06-16)

1. **Stack: TypeScript / Node.** ✅ Confirmed. The reuse thesis depends on lifting the TS runner,
   sandbox, and contracts unchanged to preserve byte-for-byte parity.
2. **First-slice scope: thin spine.** ✅ Confirmed. Slice 1 = trusted registry-ref module + local data
   behind the `platformDataClient` port + full async lifecycle over HTTP, in-memory `JobStore`, no
   Docker. (See §11.)
3. **Contracts strategy: shared versioned library.** ✅ Confirmed. Extract `@trading/research-contracts`
   (017/022) + historical row/reader types, consumed by platform, backtester, and trading-lab. The
   single version is the parity anchor (`CONTRACT_VERSION` in lockstep).
4. **Data-API sequencing: defer the network API.** ✅ Confirmed. MVP uses the in-process
   `HistoricalDatasetReader` behind the `platformDataClient` port; the networked "Research Historical
   Data API" on platform + mock-platform is a later slice (§11, Slice 4), not a blocker.

5. **Module registry: submitted bundles + own content-addressed registry only (variant A).**
   ✅ Confirmed. The backtester accepts self-contained submitted bundles and stores/addresses them by
   content-hash in its **own** registry. It does **not** share a registry with the platform on the
   execution path. Rationale: (a) isolation — the backtester stays an independent bounded context with
   no read coupling into platform internals to run a backtest; (b) it reinforces the sandbox security
   boundary — every executed module is untrusted and self-contained, never a trusted cross-service
   reference; (c) it falls out naturally from content-addressing (`bundleHash`), which is already the
   determinism/parity primitive. Promotion-parity (resolving *promoted* modules from the platform) is a
   possible later slice and is explicitly **not** in Slice 3.
```
