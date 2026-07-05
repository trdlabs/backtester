# Phase C Foundation — horizontal workers + shared object store (design)

**Status:** Approved design (2026-07-01). Backs `docs/ROADMAP.md` Phase C, items 6–9.
**Decision context:** [`2026-07-01-backtester-throughput-scaling-analysis.md`](2026-07-01-backtester-throughput-scaling-analysis.md).
**Scope discipline:** This is the *foundation only*. Per-tenant quotas and fingerprint-based dedup are explicitly **out of scope** and get their own specs — including them here would let the foundation sprawl.

---

## 1. Goal

Make `trading-backtester` horizontally scalable across nodes without weakening any existing invariant. Concretely:

1. **Shared object store (S3-compatible)** — bundles and artifacts become cluster-visible behind the existing `ArtifactStore` / `BundleStore` interfaces via a single **S3-compatible** adapter, so any worker on any node can read a claimed job's bundle and write its artifacts. Self-hosted **MinIO is a first-class supported target** (no paid AWS dependency); AWS S3 is just one of several interchangeable backends.
2. **Deployment split, first-class** — one API Deployment (`BACKTESTER_AUTO_WORKER=false`) and N worker Deployments (`worker-main.ts`) against one shared `DATABASE_URL`, with a minimal worker health endpoint for Kubernetes probes.
3. **Kubernetes/KEDA reference model** — copyable reference manifests (API Deployment + worker Deployment + KEDA `ScaledObject` driven by queue depth) plus operator docs.

## 2. Non-goals (separate follow-up specs)

- **Per-tenant quotas / fairness / admission** — needs a tenant-key DB schema and scheduling policy.
- **Fingerprint-based dedup / in-flight coalescing** — needs a decision on `runId` inside `result_hash` plus golden-test updates.
- **`ScaledJob` + worker-once mode** — the worker loop is intentionally long-lived; `ScaledObject` is the correct first shape.
- **gVisor / Kata / Firecracker**, **Temporal**, **intra-backtest symbol parallelism** — later, behind their own decisions.

## 3. Invariants preserved (must not regress)

- **Sandbox isolation** — no change to `--network none`, `--read-only`, tmpfs, memory/cpu/pids limits, `--cap-drop ALL`, `no-new-privileges`, non-root user, no inherited env, `--disallow-code-generation-from-strings`.
- **Deterministic `result_hash`** — the shared store keeps the *same* content-addressing (`contentRef` / `bundleHash`) and the *same* `canonicalJson` encoding, so hashes are byte-identical to the filesystem path. No golden fixtures move.
- **Queue semantics** — `PgJobStore.claimNextQueued` (`FOR UPDATE SKIP LOCKED`), leases, heartbeats, and `reapAndPublish` are untouched. Multi-process safety already exists.

## 4. Verified current-state assumptions (checked against source, 2026-07-01)

| Assumption | Evidence |
|---|---|
| Stores sit behind interfaces with File + InMemory impls | `artifacts/store.ts` (`ArtifactStore.{write,read,has}`, `FileArtifactStore`, `InMemoryArtifactStore`); `sandbox/bundle-store.ts` (`BundleStore.{put,get,has}`, `FileBundleStore`, `InMemoryBundleStore`). Both files' comments already name "object-store adapter … behind the same interface later". |
| `buildApp` constructs stores and accepts `overrides.{artifactStore,bundleStore}` | `app.ts::buildApp` — `overrides.artifactStore ?? new FileArtifactStore(config.artifactsDir)`, same for bundles. |
| Deployment split already wired | `config.ts` `autoWorker = (env.BACKTESTER_AUTO_WORKER ?? 'true') !== 'false'`; `app.ts` gates the in-process worker tick on `config.autoWorker`. |
| Standalone worker requires Postgres | `worker-main.ts::assertWorkerConfig` throws without `DATABASE_URL`; loop is `runWorkerLoop` (long-lived, heartbeat + reap + graceful SIGINT/SIGTERM drain). |
| API exposes a health endpoint | `api/server.ts::buildServer` line 59: `app.get('/health', async () => ({ status: 'ok' }))`. **Plain liveness — returns `{status:'ok'}`, no DB/readiness probe.** |
| The org already uses S3/MinIO for object storage | `trading-platform/src/storage/artifact_store/minio_adapter.ts` (`createMinioArtifactStore`, `@aws-sdk/client-s3` dynamic import, `forcePathStyle:true`) + `factory.ts` (`ARTIFACT_STORE=local|minio`). This design mirrors that pattern. |

Implementation MUST re-confirm the `/health` route name/behavior; if it turns out to be liveness-only where readiness is needed, add `/readyz` rather than overloading `/health`.

## 5. Architecture

```
                    ┌─────────────────────┐
   clients ───────▶ │  API Deployment      │  BACKTESTER_AUTO_WORKER=false
                    │  Hono, GET /health   │  behind a Service
                    └──────────┬───────────┘
                               │ enqueue (PgJobStore)
                               ▼
                    ┌──────────────────────┐        ┌──────────────────────┐
                    │  Postgres (shared)    │◀──────│  KEDA ScaledObject     │
                    │  backtest_job queue   │ depth  │  postgresql trigger    │
                    └──────────┬───────────┘        │  + TriggerAuthentication│
                               │ claimNextQueued     └─────────┬────────────┘
                               │ (FOR UPDATE SKIP LOCKED)       │ scales worker Deployment
                               ▼                                ▼
                    ┌──────────────────────────────────────────────────────┐
                    │  Worker Deployment (worker-main.ts, runWorkerLoop)      │
                    │  WORKER_CONCURRENCY=1..2, unique WORKER_ID (pod name)   │
                    │  optional WORKER_HEALTH_PORT (/healthz + /readyz)       │
                    │  node-local Docker daemon (DooD sibling sandbox)        │
                    └──────────┬───────────────────────────────────────────┘
                               │ get bundle / write artifacts
                               ▼
                    ┌──────────────────────┐
                    │  S3 / MinIO (shared)  │  content-addressed, one bucket
                    │  bundles/<hex>.json   │  artifacts/<hex>.json
                    └──────────────────────┘
```

### Two distinct "shared" layers (do not conflate)

- **Cluster-wide, mandatory for multi-node:** Postgres (queue) and S3/MinIO (canonical bundle + artifact bytes). Every worker on every node reads/writes these.
- **Node-local, NOT required to be cluster-RWX:** the overlay DooD volume (`BACKTESTER_SANDBOX_OVERLAY_VOLUME`) that delivers a *materialized* bundle to the sibling sandbox container on the same node. The bundle is re-materialized from the object store on each node per run, so this volume never needs to be a cluster-wide RWX PV. This deliberately avoids an expensive/fragile RWX filesystem requirement.

## 6. Component 1 — Shared object store (S3-compatible)

**No interface changes.** `ArtifactStore` and `BundleStore` keep their exact shapes. We add one **S3-compatible** adapter per interface, a small S3 client port, and an env factory.

**Positioning (no vendor lock-in):**
- The adapter is an *S3-compatible object store adapter*, not AWS-specific. It talks the S3 API/protocol over a configurable `endpoint`, so any S3-compatible server works with the **same code, no changes**.
- **MinIO is a first-class supported deployment target**, not a fallback. Self-hosted MinIO is the reference config in manifests/docs; AWS S3 is one interchangeable option among others (MinIO, Ceph RGW, Cloudflare R2, …).
- `@aws-sdk/client-s3` is used only as the *client library* — the standard, widely-used way to speak S3 to **any** compatible endpoint (via `endpoint` + `forcePathStyle`). It does **not** imply AWS as the backend.
- The env prefix stays `BACKTESTER_S3_*`, where **`S3` denotes protocol/API compatibility, not the AWS vendor**. `endpoint`, `bucket`, `region`, credentials, and `forcePathStyle` are all configurable via env/Secret.

### 6.1 Minimal S3 client port (typing without a hard dependency)

New `src/storage/s3-client.ts`:

```ts
/** Minimal object-store port. The real @aws-sdk/client-s3 is adapted onto this at runtime. */
export interface S3ObjectClient {
  put(key: string, body: string): Promise<void>;      // idempotent — key is a content hash
  get(key: string): Promise<string | undefined>;      // undefined when the object is absent
  head(key: string): Promise<boolean>;
}

export interface S3Settings {
  readonly endpoint: string;
  readonly bucket: string;
  readonly region?: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean; // MinIO / most self-hosted S3-compatible servers ⇒ true
}

/** Builds an S3-compatible client by DYNAMICALLY importing @aws-sdk/client-s3 (widened specifier).
 *  Vendor-agnostic: the SDK talks S3 to ANY compatible endpoint (MinIO, Ceph, R2, AWS S3). */
export async function createS3ObjectClient(cfg: S3Settings): Promise<S3ObjectClient> { /* … */ }
```

- The adapters depend only on `S3ObjectClient`, never on the AWS SDK types. This solves the TypeScript module-resolution problem: the package is not a compile-time dependency, and it is imported at runtime only on the S3 path (widened specifier `const S3_SPECIFIER: string = '@aws-sdk/client-s3'`, mirroring the platform).
- **Vendor-agnostic by construction:** the same client speaks to MinIO or AWS S3 purely by config. For **MinIO** (the first-class target): `endpoint: 'http://minio:9000'`, `forcePathStyle: true`, `region` any value (e.g. `us-east-1`), bucket + access/secret keys from a `Secret`. For AWS S3: the AWS regional endpoint with `forcePathStyle: false`. No code path differs.
- **Fail-fast:** if `storeBackend==='s3'` and the SDK cannot be imported (not installed) or required settings are missing, `createS3ObjectClient` / the factory throws a clear, actionable error (`store backend 's3' requires @aws-sdk/client-s3 and BACKTESTER_S3_{ENDPOINT,BUCKET,ACCESS_KEY,SECRET_KEY}`). No silent fallback to filesystem.

### 6.2 Adapters

New `src/artifacts/s3-store.ts` — `S3ArtifactStore implements ArtifactStore`:
- `write(payload)`: `ref = contentRef(payload)`; `key = 'artifacts/' + hexOf(ref) + '.json'`; `put(key, canonicalJson(payload))`; return `ref`.
- `read(ref)`: `get(key)` → `JSON.parse`; throw on absent (matches `InMemoryArtifactStore`).
- `has(ref)`: `head(key)`.

New `src/sandbox/s3-bundle-store.ts` — `S3BundleStore implements BundleStore`:
- `put(bundle)`: `hash = bundleHash(bundle)`; `key = 'bundles/' + hexOf(hash) + '.json'`; `put(key, canonicalJson(bundle))`; return `hash`.
- `get(hash)`: `get(key)` → `JSON.parse` or `undefined` (matches `FileBundleStore`).
- `has(hash)`: `head(key)`.

Fixed rules:
- **Key layout:** one bucket, two prefixes — `artifacts/<hex>.json` and `bundles/<hex>.json` (`<hex>` = the `sha256:`-stripped hash).
- **Idempotent overwrite:** `PutObject` may overwrite because the key *is* the content hash — identical bytes ⇒ identical key ⇒ safe. No temp+rename dance (S3 `PutObject` is atomic; there is no torn-read window).
- **Hash equality:** `write`/`put` MUST return the exact same `ContentHash` the File/InMemory stores return for the same payload/bytes. This is guaranteed by reusing `contentRef` / `bundleHash` + `canonicalJson` unchanged, and is pinned by a test (§9).

### 6.3 Factory + config

New `src/storage/stores.ts`:

```ts
export async function createArtifactStore(config: AppConfig, injected?: S3ObjectClient): Promise<ArtifactStore>;
export async function createBundleStore(config: AppConfig, injected?: S3ObjectClient): Promise<BundleStore>;
```

- `config.storeBackend === 's3'` → build (or accept an injected) `S3ObjectClient`, return the S3-compatible adapter. Otherwise return `File*Store`.
- The optional `injected` client is the test seam (see §9) — production passes nothing and the factory builds a real client via `createS3ObjectClient`.

`app.ts::buildApp` change (surgical):
```ts
const artifactStore = overrides.artifactStore ?? await createArtifactStore(config);
const bundleStore   = overrides.bundleStore   ?? await createBundleStore(config);
```
`buildApp` is already `async`; `overrides.*Store` retain top priority (tests never touch the factory).

`config.ts` additions to `AppConfig`:
```ts
readonly storeBackend: 'filesystem' | 's3'; // BACKTESTER_STORE_BACKEND, default 'filesystem'
readonly s3?: S3Settings;                    // populated only when storeBackend === 's3'
```
Env: `BACKTESTER_STORE_BACKEND`, `BACKTESTER_S3_ENDPOINT`, `BACKTESTER_S3_BUCKET`, `BACKTESTER_S3_REGION`, `BACKTESTER_S3_ACCESS_KEY`, `BACKTESTER_S3_SECRET_KEY`, `BACKTESTER_S3_FORCE_PATH_STYLE`. The `S3` in these names means the S3 **protocol/API**, not the AWS vendor. Default backend `filesystem` keeps CI/local/dev byte-identical to today.

Example (MinIO — the first-class self-hosted target):
```
BACKTESTER_STORE_BACKEND=s3
BACKTESTER_S3_ENDPOINT=http://minio:9000
BACKTESTER_S3_BUCKET=backtester
BACKTESTER_S3_REGION=us-east-1
BACKTESTER_S3_ACCESS_KEY=<from Secret>
BACKTESTER_S3_SECRET_KEY=<from Secret>
BACKTESTER_S3_FORCE_PATH_STYLE=true
```
For AWS S3 instead: a regional endpoint and `BACKTESTER_S3_FORCE_PATH_STYLE=false` — no other change.

## 7. Component 2 — Deployment split, first-class

The split already works; foundation adds only what a production Kubernetes worker Deployment needs.

### 7.1 Optional worker health endpoint

`worker-main.ts` gains an optional tiny `http.createServer` (only when `WORKER_HEALTH_PORT` is set; ~15 isolated lines). Behavior:

- **`GET /healthz` (liveness):** returns `200` while the worker process is alive and the drain loop has not fully resolved. Stays `200` throughout graceful drain so Kubernetes does not SIGKILL a still-draining worker.
- **`GET /readyz` (readiness):** returns `200` normally; flips to `503` **immediately on SIGTERM** (a `draining` flag) so the orchestrator stops considering the pod ready while the in-flight job drains.
- **SIGTERM sequence:** set `draining = true` (→ `/readyz` 503) → `ac.abort()` → `await loop` (graceful drain of the in-flight claim) → `dispose()` → close health server → exit.
- **If `WORKER_HEALTH_PORT` is unset:** no server starts; behavior is exactly as today. This keeps the change zero-risk for existing dev/test/demo paths.

`WORKER_ID` continues to come from env; in Kubernetes it is set from the pod name via the downward API (`valueFrom.fieldRef.fieldPath: metadata.name`) so each replica is a unique lease owner.

### 7.2 No engine/queue changes

Nothing in `worker.ts`, `pg-job-store.ts`, or the sandbox path changes for this component.

## 8. Component 3 — Kubernetes/KEDA reference model

Reference manifests live in **`deploy/k8s/examples/`** (copyable, reviewable-by-eye deploy artifacts — explicitly *not* a production Helm chart). `docs/OPERATIONS.md` gains a "Horizontal scaling" section that explains them and links to `deploy/k8s/examples/*`. The store config in the examples and docs uses the **MinIO-compatible path as the primary shown config** (self-hosted `endpoint: http://minio:9000`, `forcePathStyle: true`), with a short note on the AWS S3 variant — never AWS-only.

Files:
- `deploy/k8s/examples/api-deployment.yaml` — `BACKTESTER_AUTO_WORKER=false`; readiness/liveness probe `GET /health`; behind a `Service`.
- `deploy/k8s/examples/worker-deployment.yaml` — runs `worker-main.ts`; `WORKER_CONCURRENCY=1..2`; `WORKER_ID` from pod name; S3-compatible store env (MinIO by default) + `DATABASE_URL` (from `Secret`); liveness `/healthz` + readiness `/readyz` on `WORKER_HEALTH_PORT`; `terminationGracePeriodSeconds` long enough for a job to drain; resource requests/limits set from the capacity budget (§8.1). A companion `deploy/k8s/examples/minio.yaml` (or documented external MinIO) shows the self-hosted object-store target.
- `deploy/k8s/examples/keda-scaledobject.yaml` — KEDA `ScaledObject` on the worker Deployment, `postgresql` trigger:
  - query: `SELECT count(*) FROM backtest_job WHERE status = 'queued'`
  - `targetQueryValue` = desired queued jobs per replica; `activationThreshold: 0`.
  - **Zero application code** — KEDA queries Postgres directly.
  - **Security (required in the example):** DB credentials go through a `Secret` referenced by a KEDA `TriggerAuthentication`, **never** plaintext in the `ScaledObject`. The example ships the `Secret` + `TriggerAuthentication` + `ScaledObject` together.

### 8.1 Capacity budget (documented in OPERATIONS.md)

Sandbox sessions are per module+symbol and each worker uses its node-local Docker daemon, so total node pressure — not per-hook cold start — is the ceiling. Operators size with:

```
peak sandbox memory ≈ max_pods × WORKER_CONCURRENCY × avg_symbols_per_run × sandbox_memory_mb
peak sandbox CPU    ≈ max_pods × WORKER_CONCURRENCY × avg_symbols_per_run × sandbox_cpus
```

Guidance: prefer many modest workers (low `WORKER_CONCURRENCY`, more pods) over few large ones, and cap `maxReplicaCount` from these formulas so KEDA cannot scale to (e.g.) 200 replicas and exhaust the Docker daemon / node.

## 9. Testing strategy

- **Store conformance suite** — one shared describe-block asserting the interface contract (`put/write` returns a hash; `get/read` round-trips; `has` true after write / false for an absent key; `get` of an absent bundle returns `undefined`; `read` of an absent artifact throws). Run it against `InMemory*`, `File*` (tmpdir), and the S3-compatible adapters backed by an **in-memory fake `S3ObjectClient`** (a `Map<string,string>`). We inject the minimal client port — we do **not** mock the AWS SDK and do **not** require AWS or a running MinIO. This verifies S3-compatible *behavior* (put/get/head, absent-key semantics) independent of any vendor.
- **Hash-equality / determinism cross-check** — the same payload written through `FileArtifactStore` and `S3ArtifactStore` yields the identical `ContentHash`; same for `bundleHash` across `FileBundleStore` / `S3BundleStore`. This is the guard that the shared store cannot move `result_hash`.
- **Store factory config tests** — `createArtifactStore`/`createBundleStore`:
  - default (`storeBackend` unset) → filesystem store;
  - `storeBackend='s3'` with a complete `S3Settings` → S3 adapter (built on the injected fake client);
  - `storeBackend='s3'` with missing `bucket`/`endpoint`/credentials → fail-fast with a clear error;
  - `overrides.{artifactStore,bundleStore}` in `buildApp` take priority and short-circuit the factory entirely.
- **Optional MinIO integration smoke** — behind an env gate (mirrors the platform's gated MinIO smoke); not required in CI.
- **Worker health endpoint unit** — `/healthz` 200 while the loop runs; on simulated SIGTERM, `/readyz` flips to 503 immediately while `/healthz` stays 200 until the loop resolves; with `WORKER_HEALTH_PORT` unset, no server binds.
- **`assertWorkerConfig`** — confirm the existing test that it throws without `DATABASE_URL` still holds.

## 10. Deliverables checklist

- `src/storage/s3-client.ts` — `S3ObjectClient` port, `S3Settings`, `createS3ObjectClient` (S3-compatible, dynamic import, fail-fast; MinIO + AWS both via config).
- `src/artifacts/s3-store.ts` — `S3ArtifactStore` (S3-compatible).
- `src/sandbox/s3-bundle-store.ts` — `S3BundleStore` (S3-compatible).
- `src/storage/stores.ts` — `createArtifactStore` / `createBundleStore` factories.
- `config.ts` — `storeBackend` + `s3` settings and env parsing (default filesystem).
- `app.ts` — `buildApp` uses the factories (overrides still win).
- `worker-main.ts` — optional `WORKER_HEALTH_PORT` health server (`/healthz` + `/readyz`, SIGTERM readiness flip).
- `deploy/k8s/examples/{api-deployment,worker-deployment,keda-scaledobject}.yaml` (+ `Secret` / `TriggerAuthentication`, + MinIO example/config).
- `docs/OPERATIONS.md` — horizontal scaling section, capacity formulas, env matrix (with the MinIO-compatible S3 config as the primary example + AWS variant note), "ScaledObject not ScaledJob (until worker-once)" note; links to `deploy/k8s/examples/*`.
- Tests per §9.
- `docs/ROADMAP.md` — mark Phase C items 6–9 as in-progress/covered by this foundation; leave 10–13 as the follow-up specs.

## 11. Out-of-scope guardrail

Quotas (item 10) and fingerprint dedup (item 11) are **not** in this PR. If either starts creeping in during implementation, stop and split it into its own spec — the foundation's value is that it lands small, review-clean, and invariant-preserving.
