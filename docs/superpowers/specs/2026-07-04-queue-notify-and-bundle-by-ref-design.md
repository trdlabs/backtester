# Queue-Wake (LISTEN/NOTIFY) + Bundle-by-Ref — Design

**Date:** 2026-07-04
**Roadmap:** Phase D item 16 remaining tails ("cheap pre-load tails"). One combined spec + one PR.
**Status:** design, pending user review.

## Goal

Two independent, low-risk throughput tails that pay off at hundreds of runs:

1. **LISTEN/NOTIFY queue-wake** — cut worker idle→claim latency from "up to `pollMs`" to
   near-zero on a fresh submit, and shed Postgres poll load as the fleet grows. Latency-only:
   polling stays as the correctness backstop.
2. **Bundle-by-ref** — stop the lab re-uploading the same ~1 MiB `moduleBundle` bytes on every
   grid point. Expose the already content-addressed `BundleStore` over HTTP; submit by hash.

Both are additive and preserve every determinism invariant.

## Non-goals

- Bundle GC / retention / TTL — deferred to Tier 4 (item 18), consistent with the roadmap.
- LISTEN/NOTIFY as a correctness mechanism — it is a latency optimization only; the queue is
  never *drained* by NOTIFY, only *woken*. A dropped notification costs latency, never a stuck job.
- Lab adoption of bundle-by-ref — a separate follow-up PR (SDK release → lab re-pin), mirroring the
  backpressure rollout. This PR ships the backtester surface + SDK client method.
- Coalescing-follower wake via NOTIFY — the existing `wakeComputeWaiters` loop stays; out of scope.

## Global Constraints (invariants every task inherits)

- **Determinism untouched.** `result_hash` and `computeIdentity` are unchanged. Bundle-by-ref MUST
  be *fingerprint-invariant*: an inline submit of bundle X and a by-ref submit of `hash(X)` produce
  the **same** `requestFingerprint` (so dedup/coalescing treat them as one identity).
- **NOTIFY is latency-only.** `pollMs` remains the guaranteed backstop. With the flag OFF or an
  InMemory store, worker behavior is byte-for-byte today's. A lost/late notification is bounded by
  `pollMs` — the exact current worst case.
- **Flag posture.** `BACKTESTER_QUEUE_NOTIFY` defaults **false** (dark-launch, like dedup/coalesce/
  batching). Bundle-by-ref is additive and backward-compatible — **no flag**.
- **Pg-only wake.** The waker is created/used **only for `PgJobStore`**. For `InMemoryJobStore` the
  worker uses a plain timeout even if the flag is accidentally on.
- **SDK hygiene.** Public `.d.ts` stays free of Node globals (e.g. `Buffer`). An SDK version bump
  touches 4 sites (`package.json`, `src/internal/versions.ts` `SDK_VERSION`, `package-shape.test`,
  `registry-contract.test`); the release workflow asserts `package.json` == input version.
- **Idempotency preserved.** Any SDK retry (including bundle self-healing) reuses the **same
  `resumeToken`** — a retry must never create a duplicate run.

---

## Part 1 — LISTEN/NOTIFY queue-wake

### Architecture

When the queue is empty, `runWorkerLoop` currently sleeps `pollMs` via `setTimeout`
(`worker.ts:759`). We replace that single idle wait with a race: **NOTIFY, or `pollMs` timeout, or
abort — whichever first.** Postgres `pg_notify` fires transactionally on commit whenever a job
becomes claimable; a dedicated per-process `LISTEN` connection resolves the idle wait.

### Components

**`src/jobs/queue-notify.ts` (NEW) — `QueueWaker`.** Single responsibility: own the wake signal.
- Holds ONE dedicated `pg` `Client` (its own connection, NOT from the app pool — a `LISTEN`
  connection is monopolized). One `QueueWaker` **per worker process**.
- On construct: connect, `LISTEN backtest_job_queued`, register a `notification` handler that sets
  an internal `pendingWake = true` and resolves any in-flight waiter.
- `waitForWake(pollMs, signal): Promise<void>` — resolves on the first of: a notification, the
  `pollMs` timeout, or `signal` abort. **Lost-wakeup guard:** if `pendingWake` is already set on
  entry, it clears the flag and returns immediately (a notification that arrived during the prior
  drain is not missed).
- Reconnect: on connection `error`/`end`, log once and reconnect with bounded backoff. While
  disconnected, `waitForWake` degrades to a plain `pollMs` timeout — polling still drains, so no
  correctness loss.
- `dispose()`: remove listeners, `end()` the client. Called on worker shutdown.
- **Degraded waker:** a trivial timeout-only implementation used when the flag is off or the store
  is InMemory, so `runWorkerLoop` always calls the same `waitForWake` shape.

**`src/jobs/pg-job-store.ts` (MODIFY) — the notify helper.** A single private
`private async notifyQueued(client): Promise<void>` running `SELECT pg_notify($1, '')` with the
channel constant. It is invoked from **every write path that sets a row's status to `queued`**:
- the submit enqueue — the `transition(_, 'queued', …)` write (reached only by a created=true
  submit; replays return before it in `submitRun`), and
- the requeue path (reap returns an orphaned/expired-lease job to `queued`).

Centralizing the SQL in one helper is deliberate: it makes "forgot an enqueue path" a
single-call-site concern rather than scattered SQL. **Anchoring note:** the notify fires when the
job becomes **queued (claimable)**, NOT at the `accepted` insert in `insertOrGet` — notifying at
`accepted` would wake the worker before `claimNextQueued` can see the job (a racy lost-wakeup, then
a full `pollMs` sleep before the queued transition). Payload is empty: the signal means "re-drain,"
and the worker reads the queue itself.

**`src/jobs/worker.ts` (MODIFY `runWorkerLoop`).** Replace the inline `setTimeout` idle wait with
`await waker.waitForWake(opts.pollMs, opts.signal)`. The `WorkerDeps`/loop opts carry the waker
(or the degraded waker). No other loop change — drain, reap, and `wakeComputeWaiters` are untouched.

**`src/worker-main.ts` + `src/app.ts` (MODIFY).** Construct exactly one `QueueWaker` per worker
process when `config.queueNotify === true` AND the store is `PgJobStore`; otherwise construct the
degraded timeout waker. Wire it into the loop opts; `dispose()` it in the shutdown path alongside
`app.dispose()`.

**`src/config.ts` (MODIFY).** `queueNotify: boolean` from `BACKTESTER_QUEUE_NOTIFY` (default false).
Channel name is a shared exported constant `QUEUE_NOTIFY_CHANNEL = 'backtest_job_queued'` so the
NOTIFY and LISTEN sides can never drift.

### Connection budget

+1 Postgres connection per worker process (the listener), OUTSIDE `BACKTESTER_PG_POOL_MAX`. Fleet
math becomes `worker_pods × (pool_max + 1)` + API pods — document in OPERATIONS.

### Error handling & degradation

- Listener connect fails / drops → log once, reconnect with backoff; polling backstops meanwhile.
- Flag off OR InMemory store → no listener; plain `pollMs` timeout (today's behavior).
- Abort (shutdown) → `waitForWake` resolves immediately; `dispose()` ends the client.

---

## Part 2 — Bundle-by-ref

### Endpoints (additive, `/v1`, same bearer auth)

- **`POST /v1/bundles`** — body = `ModuleBundle` JSON. **Validate the body is a well-formed
  `ModuleBundle` BEFORE `put`** — a structural check (the manifest/shape `loadBundle` /
  `materializeBundle` require), so the store never holds arbitrary JSON; if the inline submit path
  has a reusable bundle-structural validator, reuse it, else add a minimal one. On invalid → `400`,
  nothing stored. On valid → `bundleStore.put()` → `200 { hash }`. Idempotent: identical bytes →
  same hash, put is a no-op overwrite of identical content.
- **`HEAD /v1/bundles/:hash`** — `:hash` validated as a `ContentHash` (`sha256:<hex>`); malformed →
  `400`. Present (`bundleStore.has`) → `200`; absent → `404`. Lets the client check before upload.

**`src/api/bundles.ts` (NEW)** hosts both handlers; mounted from `server.ts`.

### Submit changes

`src/jobs/submit.ts` (MODIFY `submitRun`) accepts an optional `bundleRef: ContentHash`, an
alternative to `moduleBundle`:
- **Exactly one bundle source.** `moduleBundle` and `bundleRef` are mutually exclusive → both set
  is `400`. (A trusted/momentum run supplies neither — unchanged.)
- `bundleRef` set: validate it is a well-formed `ContentHash` (else `400`); `bundleStore.has(ref)` →
  found → set `bundleHash = ref`, **skip `put`**; not found → `409 { code: 'unknown_bundle' }`.
- `moduleBundle` set: current path unchanged (`bundleStore.put` → hash).
- The stored `request` strips **both** `moduleBundle` and `bundleRef` (as it already strips
  `moduleBundle` today) — the job carries only `bundleHash`, so `storedRequestFingerprint(job.request,
  job.bundleHash)` stays bundle-source-agnostic and replay/dedup identity is unaffected by which
  source was used.

### Fingerprint invariance (the critical dedup gate)

`src/jobs/fingerprint.ts` (MODIFY). The machinery already folds the bundle to its content hash
(`normalize(…).moduleBundle = bundleHashValue`). Extend `requestFingerprint` to resolve the hash
from **either** source:
`req.moduleBundle ? bundleHash(req.moduleBundle) : (req.bundleRef ?? null)`. Then an inline submit
of X and a by-ref submit of `hash(X)` yield an identical fingerprint → dedup/coalescing see one
identity. Pinned by a dedicated golden test (below).

### SDK client

`packages/sdk/src/contracts/run.ts` (MODIFY): add `bundleRef?: ContentHash` to `RunSubmitRequest`.

`packages/sdk/src/client/client.ts` (MODIFY):
- `putBundle(bundle: ModuleBundle): Promise<ContentHash>` — `POST /v1/bundles`.
- `hasBundle(hash: ContentHash): Promise<boolean>` — `HEAD /v1/bundles/:hash`.
- `submitRun` accepts `bundleRef`.
- **By-ref optimization + self-healing (ordering):**
  - `submitRun({ moduleBundle, … })` MAY submit by-ref **only if** the SDK already uploaded that
    bundle or holds a known hash for it (e.g. a prior `putBundle`); otherwise it submits inline as
    today. The SDK never silently strips bytes it hasn't confirmed are stored.
  - On `409 unknown_bundle`: if the SDK **has the bundle bytes in hand**, it does one `putBundle` +
    retries — **reusing the same `resumeToken`** (retry must not create a duplicate run). If the
    call was `{ bundleRef }` only (no bytes), it **surfaces** `unknown_bundle` (nothing to re-PUT).
- Intended lab pattern (follow-up repo): `putBundle` once per bundle, then `submitRun({ bundleRef })`
  for each grid point — one upload instead of N.

### Multi-node caveat

`FileBundleStore` is host-local: a bundle PUT to node A is invisible to node B. True cross-fleet
by-ref requires the shared `S3BundleStore` (`BACKTESTER_STORE_BACKEND=s3`, already implemented). On
a single node (VPS, FileStore) it works as-is; the `409 unknown_bundle` → re-PUT self-heal also
covers a ref that misses on the "wrong" node — at most one extra upload, never a failure. Document.

---

## Testing

### LISTEN/NOTIFY

- **Pg-gated integration (mandatory falsifiable gate).** A prior lesson: the coalesce wake path
  shipped InMemory-only and the Pg path had zero coverage — not repeated here. Against a real
  Postgres: set `pollMs` high (e.g. 10 s), submit a job, assert it is claimed in < 1 s ⇒ NOTIFY
  woke the worker, not the poll.
- **Unit — `waitForWake`:** resolves on notification; on timeout; on abort; and a `pendingWake` set
  before entry returns immediately (lost-wakeup guard).
- **Backstop invariant:** with the listener disabled/broken, polling still drains (correctness is
  independent of NOTIFY). InMemory store / flag off → no listener created; existing worker tests
  stay green (behavior unchanged).

### Bundle-by-ref

- **`POST /v1/bundles`:** valid → `200 { hash }`, hash equals `bundleStore.put`; idempotent (twice →
  same hash); invalid bundle → `400` and nothing stored (assert `has` is false after).
- **`HEAD /v1/bundles/:hash`:** present → `200`; absent → `404`; malformed hash → `400`.
- **Submit by-ref:** known ref → run proceeds, `bundleHash` set, no re-upload; unknown ref → `409
  unknown_bundle`; both sources → `400`; malformed ref → `400`.
- **Fingerprint-invariance golden:** `requestFingerprint(inline X) === requestFingerprint(bundleRef
  = hash(X))`. Plus an end-to-end Pg-gated dedup check: inline submit, then by-ref submit of the
  same bundle → **dedup HIT** (same `result_hash`, `engineMs: null` on the second). This is the gate
  binding by-ref to dedup.
- **SDK:** `putBundle` returns the hash; `hasBundle` true/false; submit by-ref; self-healing on
  `409` does one re-PUT + retry **with the same resumeToken** when bytes are available, and does NOT
  retry (surfaces) when only a `bundleRef` was given.

## Rollout

- **LISTEN/NOTIFY:** merge default OFF → enable in `deploy/vps/backtester.env`
  (`BACKTESTER_QUEUE_NOTIFY=true`) → observe `queueWaitMs` on fresh submits drop toward zero.
  Kill-switch = set the flag false.
- **Bundle-by-ref:** additive, no flag, backward-compatible. Backtester ships endpoints + submit
  `bundleRef` + the fingerprint fold + SDK client methods. **Lab adoption is a separate follow-up**
  (SDK release → lab re-pin, like backpressure). Until then the inline path is unchanged.
- **OPERATIONS.md:** a NOTIFY section (flag, +1 connection/worker, degradation, channel) and a
  bundle-by-ref section (endpoints, by-ref submit, multi-node/S3 caveat, self-healing).
- **SDK version bump** (new methods): the 4-site bump + public `.d.ts` free of Node globals.

## File structure

**LISTEN/NOTIFY**
- `src/jobs/queue-notify.ts` — NEW: `QueueWaker` (LISTEN client, reconnect, `pendingWake`,
  `waitForWake`) + degraded timeout waker + `QUEUE_NOTIFY_CHANNEL` (or re-export from config).
- `src/jobs/pg-job-store.ts` — MODIFY: private `notifyQueued()`, called from the queued-transition
  and requeue write paths.
- `src/jobs/worker.ts` — MODIFY `runWorkerLoop`: idle `setTimeout` → `waker.waitForWake`.
- `src/worker-main.ts`, `src/app.ts` — MODIFY: construct one waker/process (Pg + flag), dispose on
  shutdown.
- `src/config.ts` — MODIFY: `queueNotify` flag + channel constant.
- `test/queue-notify.test.ts` (unit), `test/queue-notify-pg.test.ts` (Pg-gated).

**Bundle-by-ref**
- `src/api/bundles.ts` — NEW: `POST /v1/bundles` + `HEAD /v1/bundles/:hash`; mounted in `server.ts`.
- `src/jobs/submit.ts` — MODIFY: `bundleRef`, XOR guard, `has` → 409, set `bundleHash`.
- `src/jobs/fingerprint.ts` — MODIFY: resolve hash from `moduleBundle` OR `bundleRef`.
- `packages/sdk/src/contracts/run.ts` — MODIFY: `bundleRef?: ContentHash`.
- `packages/sdk/src/client/client.ts` — MODIFY: `putBundle`, `hasBundle`, by-ref + self-healing.
- `test/bundles-api.test.ts`, `test/submit-bundle-ref.test.ts`, `test/fingerprint-bundle-ref.test.ts`.

## Risks & open points

- **Listener connection lifecycle** is the only real risk surface (reconnect, no leaked client on
  shutdown). Contained in `QueueWaker` and covered by the backstop invariant — polling makes it
  fail-safe, not fail-stuck.
- **`bundleRef` on a fleet with FileStore** misses cross-node; self-heal + the S3 store cover it,
  documented rather than enforced.
- **`pg` client dependency** already present (PgJobStore uses it); the listener uses the same driver.
