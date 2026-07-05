# Fingerprint-based result dedup — completed-result cache (design)

**Status:** Approved design (2026-07-01). Backs `docs/ROADMAP.md` Phase C item 11.
**Decision context:** [`2026-07-01-backtester-throughput-scaling-analysis.md`](2026-07-01-backtester-throughput-scaling-analysis.md) §5.
**Depends on:** the S3-compatible artifact store from the Phase C foundation (PR #72) — the dedup template is stored content-addressed in that same store.

## 1. Goal

LLM agents fan out near-identical or identical strategy/overlay runs (same bundle + data + params). Today every one runs the full engine/sandbox. Add a **completed-result cache**: when a run's compute identity matches an already-completed run, reconstruct its terminal result by **re-stamping** the cached run's normalized output instead of executing the engine — skipping the dominant cost (data-materialization is cheap and already tape-cached; the engine + per-symbol Docker sandbox is the expensive part).

## 2. Settled decisions (from brainstorming)

- **Worker-time, validated by `datasetFingerprint`.** Dedup resolves inside `processNextQueued`, AFTER materialization + `datasetFingerprint`, BEFORE any sandbox/bundle/engine work. Keying on the materialized `datasetFingerprint` (not the `datasetRef` string) makes it correct against a mutable `datasetRef` (late-arriving data / corrections).
- **Preserve the `result_hash` contract + re-stamp.** `result_hash` stays `contentRef(runId-stamped outcome)` — the platform golden (`eff10116…`) and the evidence contract are untouched. A duplicate's `result_hash` is re-derived for its own `runId` via a verified `restamp` transform whose correctness is pinned by a byte-equivalence golden.
- **Completed-result cache only.** In-flight coalescing (burst case) and a submit-time fast-path are follow-ups on the same core.
- **Default OFF (dark launch).** Ship code + tests; operators enable after soak.

## 3. Non-goals (follow-ups / separate specs)

In-flight coalescing; submit-time fast-path for immutable dataset backends; TTL/LRU cache pruning + cross-run artifact GC; per-tenant cache policy; **any change to the `result_hash` contract** (explicitly preserved here).

## 4. Invariants preserved

- **Deterministic `result_hash` unchanged** — `restamp(normalize(freshRun(X)), Y)` is byte-identical to `freshRun(Y)`, so `contentRef` (the `result_hash`) matches what a fresh run would produce. Existing goldens stay green; no golden moves.
- **Sandbox untouched** — dedup adds a branch that *skips* sandbox work on a hit; it never changes sandbox behavior.
- **Queue untouched** — no change to `claimNextQueued` / leases / reaping. Dedup lives entirely inside the claimed-job execution.
- **Off = today.** With `BACKTESTER_DEDUP_ENABLED=false` the execution path is byte-identical to current behavior.

## 5. Worker restructuring (the hook point) — REQUIRED

`processNextQueued` today loads the sandbox bundle EARLY, before the engine branches:

```ts
if (claimed.bundleHash !== undefined) {
  sandboxBundle = await sandboxBundleFor(deps, claimed.bundleHash);   // <-- runs even for a would-be HIT
}
// ... then per-engine: materialize tape, compute dsFingerprint, build registry, run engine
```

That early load must move so a HIT skips it. Target shape:

```
1. materialize (tape, via existing tape-cache) + compute datasetFingerprint   [hoisted before the gate]
2. DEDUP GATE (only when BACKTESTER_DEDUP_ENABLED && !request.bypassCache):
     key = computeIdentity(claimed.request, datasetFingerprint)
     hit = resultCache.lookup(key)              // completed-only
     if hit:
        template = artifactStore.read(hit.templateRef)  →  DedupTemplate
        // defensive: engine AND templateVersion must match the current code; else treat as a MISS
        // (a bump of DEDUP_COMPUTE_VERSION already re-keys, so this is belt-and-braces)
        if template.engine !== requestEngine || template.templateVersion !== CURRENT_TEMPLATE_VERSION: treat as miss
        payload = restamp(template, runId = claimed.runId)         // NO sandboxBundleFor / executor / router / engine
        resultHash = contentRef(payload)
        { summary, manifest } = persistFromPayload(template.engine, payload, datasetFingerprint, claimed)
                                 // reuses runId-independent artifacts by hash; writes runId-dependent ones
        record dedupedFrom (see §9) and go to terminal transition
3. MISS-PATH (unchanged compute):
     sandboxBundle = bundleHash ? await sandboxBundleFor(...) : undefined   // <-- moved here
     build registry / executor / router, run the engine as today
     normalized = normalize(engine payload)
     templateRef = artifactStore.write(DedupTemplate{ engine, payloadKind, templateVersion, normalizedPayload: normalized })
     resultCache.put(key, { templateRef, versions })     // only on `completed`
4. terminal transition running→completed + publishCompletion   [shared by hit and miss]
```

Because materialization + `datasetFingerprint` differ per engine kind (overlay/strategy: `buildOverlayDataset` + `contentRef(symbols.map(candles))`; momentum: `materialize` + `datasetFingerprint(dataset)`), extract a small per-kind **`materializeFor(claimed) → { tape/dataset, datasetFingerprint }`** step and a per-kind **`executeEngine(claimed, materialized, sandboxBundle) → payload`** step so the dedup gate sits cleanly between them. This is a targeted refactor of a large function, justified by the feature; the momentum golden must stay byte-identical (guarded by existing tests + the new equivalence golden).

## 6. Compute identity (cache key)

```
computeIdentity = sha256(canonicalJson({
  requestFingerprint,        // existing: all run-affecting fields + bundle hash (fingerprint.ts)
  datasetFingerprint,        // content hash of the materialized bars — true data identity
  computeVersion,            // DEDUP_COMPUTE_VERSION (see §7)
  sandboxPolicyVersion,      // config.overlaySandbox.policy.{id, version}
}))
```

- `bypassCache` is **not** part of `requestFingerprint` or `computeIdentity` (it is an execution directive, not a run-affecting input).
- Only **successful `completed`** runs populate the cache. `failed` / `timeout` / `validation_error` are never cached and never served.

## 7. `DEDUP_COMPUTE_VERSION`

A dedicated explicit constant (`src/jobs/dedup/version.ts`) — **not** tied to `API_CONTRACT_VERSION` or any package version. It is the operator/cache-invalidation lever for *deterministic compute semantics*.

**Bump rule (documented at the constant):** bump `DEDUP_COMPUTE_VERSION` whenever a change could alter cached-vs-fresh equivalence — engine output, the `normalize`/`restamp` shape, artifact-persistence semantics, or a sandbox-policy change that affects the deterministic output. A bump invalidates every prior cache entry (new key space) — safe by construction.

## 8. The re-stamp core (risky heart — TDD)

New module `src/jobs/dedup/restamp.ts`. Operates on a **typed template**, never a bare "outcome":

```ts
export type DedupPayloadKind = 'RunOutcome' | 'BacktestResult';

export interface DedupTemplate {
  readonly engine: 'momentum' | 'overlay' | 'strategy';
  readonly payloadKind: DedupPayloadKind;   // 'BacktestResult' for momentum, 'RunOutcome' for overlay/strategy
  readonly templateVersion: string;          // shape version of THIS envelope (bump if the envelope shape changes)
  readonly normalizedPayload: unknown;       // the runId-normalized RunOutcome | BacktestResult
}

export function normalize(engine, payload): DedupTemplate;   // runId → SENTINEL everywhere, incl. derived forms
export function restamp(template: DedupTemplate, runId: string): RunOutcome | BacktestResult;
```

- `normalize` replaces `runId` with a fixed `SENTINEL` at every occurrence, including derived identifiers (`${runId}::variant` → `${SENTINEL}::variant`, seen in `runner.ts`). `restamp` reverses it, dispatching on `engine`/`payloadKind` so the momentum (`BacktestResult`) and overlay/strategy (`RunOutcome`) shapes are never mixed.
- **Byte-equivalence golden (per engine path — the safety net):** for fresh runs with distinct `runId`s X, Y:
  - `normalize(freshRun(X))` deep-equals `normalize(freshRun(Y))` (normalization erases runId), AND
  - `restamp(normalize(freshRun(X)), Y)` is **byte-identical** to `freshRun(Y)` → `contentRef` (the `result_hash`) matches.
  If `runId` is woven somewhere the transform misses, `restamp !== freshRun` and this test fails — forcing the transform to be completed. This is how "не ломаем детерминизм" is enforced mechanically.

## 9. `dedupedFrom` provenance (never in the hashed payload)

A deduped run records that it was served from cache — but **never** inside the object `contentRef` hashes. `dedupedFrom: <cachedComputeIdentity>` is written to:
- the run's `result_summary_json` (a summary-level field; the summary is NOT the hashed object — `result_hash = contentRef(payload)`, distinct from the summary), and
- an outbox/job event (`run_deduped`) for observability.

It is explicitly excluded from the `RunOutcome`/`BacktestResult` payload, so `result_hash` is identical to a fresh run's.

## 10. Storage

- **New table `backtest_result_cache`** (migration `0004_result_cache.sql`): `compute_identity TEXT PRIMARY KEY, request_fingerprint TEXT NOT NULL, dataset_fingerprint TEXT NOT NULL, compute_version TEXT NOT NULL, sandbox_policy_version TEXT NOT NULL, template_ref TEXT NOT NULL, created_at_ms BIGINT NOT NULL`. Metadata + a pointer only; the heavy template lives in the artifact store. (`request_fingerprint`/`dataset_fingerprint` columns are for observability/debugging, not the key.)
- **Template bytes** — the `DedupTemplate` in the existing content-addressed artifact store (S3/file from the foundation), keyed `templateRef = contentRef(template)`. Naturally deduplicated across cache rows.
- **`ResultCache` interface** — `{ lookup(computeIdentity): Promise<CacheEntry | undefined>; put(computeIdentity, entry): Promise<void> }`, with `PgResultCache` (prod) + `InMemoryResultCache` (dev/tests), mirroring the `JobStore` pattern. `put` is idempotent (`ON CONFLICT (compute_identity) DO NOTHING` — first writer wins; identical content anyway).

## 11. Config / flags

- `BACKTESTER_DEDUP_ENABLED` — default **false** (dark launch). Added to `AppConfig` (`dedupEnabled: boolean`) with fail-safe parsing.
- `RunSubmitRequest.bypassCache?: boolean` — per-request force-fresh (debug/benchmarks). Not in `requestFingerprint`/`computeIdentity`; a bypassed run still POPULATES the cache on completion (so later runs benefit).
- Invalidation = bump `DEDUP_COMPUTE_VERSION`. TTL/LRU pruning is a follow-up.

## 12. Testing strategy

- **Equivalence golden (core, per engine path):** `restamp(normalize(freshRun(X)), Y)` byte-identical to `freshRun(Y)` for momentum / overlay / strategy, against fixed fixtures. Plus `normalize` erases runId (X and Y normalize equal) and is idempotent.
- **HIT skips ALL compute — not just the engine:** a worker HIT must NOT call `sandboxBundleFor`, `executorFor`, the executor router, OR the engine. Assert via injected spies that none are invoked on a hit (this is the test that catches the current early-bundle-load bug if the restructuring is incomplete).
- **MISS populates the cache** with a `completed`; a subsequent identical claim HITs.
- **`computeIdentity` sensitivity:** changes when `datasetFingerprint`, `computeVersion`, or `sandboxPolicyVersion` change; stable otherwise. `bypassCache` does not change it.
- **Never-cache negatives:** `failed`/`timeout`/`validation_error` runs do not write a cache row and are never served.
- **`dedupedFrom` isolation:** a deduped run's `result_hash` equals a fresh run's; `dedupedFrom` appears in the summary/outbox but not in the payload.
- **`ResultCache` conformance** (InMemory + Pg): lookup/put/miss, completed-only, idempotent put.
- **Kill-switch off** → execution byte-identical to today (no cache reads/writes, early bundle load unchanged in effect).

## 13. Deliverables

- `src/jobs/dedup/version.ts` — `DEDUP_COMPUTE_VERSION` + bump-rule doc.
- `src/jobs/dedup/restamp.ts` — `DedupTemplate`, `normalize`, `restamp`.
- `src/jobs/dedup/compute-identity.ts` — `computeIdentity(...)`.
- `src/jobs/dedup/result-cache.ts` — `ResultCache` interface + `InMemoryResultCache`.
- `src/jobs/dedup/pg-result-cache.ts` — `PgResultCache`.
- `apps/backtester/migrations/0004_result_cache.sql` — the cache table.
- `src/jobs/worker.ts` — restructured `processNextQueued` (hoist materialize+fingerprint, dedup gate, move `sandboxBundleFor` to miss-path, populate on miss); extracted `materializeFor` / `executeEngine` per-kind helpers.
- `src/config.ts` — `dedupEnabled` (env `BACKTESTER_DEDUP_ENABLED`, default false).
- `RunSubmitRequest.bypassCache?` (SDK contract) + submit passthrough (not in fingerprint).
- `buildApp` wiring: construct the `ResultCache` (Pg when `databaseUrl`, else in-memory) and pass into `WorkerDeps`.
- Tests per §12; `docs/OPERATIONS.md` note (enable flag + invalidation via version bump); `docs/ROADMAP.md` item 11 → in-progress.

## 14. Open risk & mitigation

The `normalize`/`restamp` transform over a woven/derived `runId` footprint is the one real risk. Mitigation: the per-path byte-equivalence golden is the acceptance gate — the feature is not done until `restamp(normalize(freshRun(X)), Y) === freshRun(Y)` holds for all three engine paths. If a path's `runId` weaving proves intractable to re-stamp, that path can ship with dedup disabled (per-engine guard) while the others proceed — the kill-switch and per-engine assertion make partial rollout safe.
