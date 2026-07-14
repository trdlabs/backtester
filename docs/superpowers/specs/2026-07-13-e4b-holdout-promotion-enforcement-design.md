# E4b — held-out OOS promotion enforcement (signature-gate) design

Date: 2026-07-13. Phase E, ROADMAP item 23 (enforcement half; E4a advisory marker = #109/#111).
Predecessors: E4a (`holdout.ts` — `computeHoldoutWindow`/`holdoutOverlap`/`buildHoldoutMarker`), E3b
(`walk-forward-exec.ts` — the window-evaluation helpers to extract), the existing strategy-evidence
pipeline (`produce-strategy-evidence.ts`, `decideVerdict`, `backtest-evidence/v1`), E2 (family key /
trial ledger), the FEATURE-PARITY §5.3 held-out-window discussion.

## Goal

Turn E4a's advisory held-out marker into an **enforced promotion gate**. For a `mode:'promotion'` run,
a signed `backtest-evidence/v2` artifact is emitted **only if the run is held-out-qualified** — i.e. it
was evaluated on the reserved OOS window the LLM refine loop could not iterate against, and passed the
server-policy metric thresholds there. If it is not qualified, no signature is produced; the platform
(which requires promotion evidence for admission) therefore cannot admit it. This is the only systemic
defense against adaptive overfitting *of the refine loop itself* — E1–E5/E3b are advisory and gameable
by iteration.

## Framing (decided): signature-gate, not job failure

The backtester **decides and signs**; the platform **enforces admission** by trusting/verifying the
signature. Consequences:
- The job lifecycle is unchanged — a not-qualified promotion still terminates `completed`.
- `result_hash` is byte-identical: the promotion verdict + evidence live on the post-hash summary
  projection / as a signed artifact reference, never in the hashed payload. `decideVerdict` is reused
  unchanged.
- The enforcement lever is the **presence of a valid signature** (mirrors the existing "only sign
  `passed`" invariant), extended with the held-out requirement.
- A non-signature is accompanied by a first-class **`promotion` verdict field** on the summary carrying
  typed failure reasons — advisory feedback for the lab even when unsigned.

**Cross-repo preconditions (rollout gate):** the new signed body is a NEW artifact type
`backtest-evidence/v2` — v1 is NOT silently extended. Three co-preconditions must ALL hold before the
backtester flag is enabled: platform v2 canonical verification, a platform `requirePromotionEvidence`
admission policy, AND the lab Outcome-Embargo (without embargo the loop adapts to the holdout off the
binary verdict, since the hard attempt-limit is deferred). Until all three, this is a producer, not an
enforcer. (Detailed in Rollout.)

## Immutable qualification context (fix the window before execution)

The holdout window MUST NOT be recomputed from live coverage at finalize — coverage can grow during a
run, so the window would drift. E4b snapshots it **once at execution start** (the same point the run's
`datasetFingerprint` is computed) into an immutable object used identically for evaluation, the ledger
key, and the signed evidence:

```ts
interface QualificationWindowContext {
  readonly coverage: RunPeriod;        // dataset coverage snapshot at execution start (for the eval window)
  readonly window: RunPeriod;          // computeHoldoutWindow(coverage, fraction) — the reserved OOS window
  readonly fraction: number;
  readonly policyVersion: string;      // version of the promotion policy (thresholds + fraction + rules)
  readonly datasetFingerprint: string; // the run's dataset fingerprint (row-content snapshot)
  readonly qualificationEpochId: string; // TRUSTED canonical epoch id from the resolver (NOT the request pointer)
}
```

`policyVersion` is a constant string bumped whenever the promotion policy (thresholds, fraction rule,
required metrics) changes — it participates in the epoch key so a policy change is a new regime.

**The STABLE epoch identity is TRUSTED-RESOLVED, never client-asserted.** The eval `window` is
coverage-derived and drifts as new bars arrive; using the coverage boundary as the epoch would reset
`attemptNumber` to 1 on every ingest. And the epoch must NOT be a raw client value — a client could
change it every attempt to reset the counter. So the backtester derives it entirely server-side through
a TRUSTED `QualificationEpochResolver` (injected dep), returning an immutable, server-derived `epochId`
or rejecting. **No request field is added for it** (there is no resolver that would honor one today —
see below); the future reservation slice adds a request pointer additively, together with the resolver
that actually consumes it.

```ts
interface QualificationEpochResolver {
  // Returns the immutable server-derived epoch identity for a promotion run, or null if it cannot be
  // established. Derived from server-side state (the dataset), never from a client-supplied string.
  resolve(claimed: JobRow): Promise<{ epochId: string } | null>;
}
```

**Production resolver E4b ships (decided): `DatasetIdentityEpochResolver`.** There is no immutable
dataset snapshot id today (`DatasetDescriptor = { datasetRef, symbols, timeframe, period, rowCount }`),
and the reservation service is a follow-up — so E4b's concrete resolver derives the epoch from the
**validated dataset identity**: `resolve(claimed)` looks up `claimed.datasetRef` via
`dataPort.listDatasets()`; found ⇒ `{ epochId: <canonical datasetRef> }`, not found ⇒ `null` ⇒
`holdout_unavailable`. Properties: implementable now; **stable** (a `datasetRef` does not change on
ingest, so `attemptNumber` never resets on new bars); **server-verified** (the ref must resolve to a
real dataset); **non-fakeable** (a client can't reset the counter without switching to a genuinely
different dataset = a legitimately different test). Trade-off: the epoch is **coarse** — one
family×dataset×policy epoch that never resets across data campaigns — which is correct for E4b's
record-only accounting; per-campaign granularity needs the reservation service (follow-up, which adds
its request pointer then). The eval window still derives per-run from the coverage snapshot; only the
attempt-counting *epoch* uses the resolved
`epochId`.

## Qualification gate — ONE canonical pipeline, single reason

```ts
export type PromotionFailureReason =
  | 'signing_unavailable' | 'gate_rejected' | 'twin_divergent'
  | 'holdout_unavailable' | 'holdout_not_covered' | 'warmup_insufficient'
  | 'evaluation_insufficient' | 'attempt_record_failed' | 'metrics_failed';
```

There is exactly ONE evaluation order, and the gate **early-returns on the first failure** — so the
result carries a **single** `reason` (not an array; downstream checks and the ledger simply don't run
after an early failure). The steps, in order:

1. `signing_unavailable` — no signing key.
2. `gate_rejected` — bundle acceptance validation rejected the candidate.
3. `twin_divergent` — the execution-integrity twin check (`compareBacktestRuns(curated, candidate)`,
   full-run) diverges. (Steps 1–3 = bundle integrity: only a valid, equivalent candidate is a real
   attempt.)
4. `holdout_unavailable` — coverage can't be resolved (⇒ no window) OR the epoch resolver returned
   `null` (⇒ no attempt epoch). NOT the signing key (that is step 1); NOT flag-off (flag-off yields no
   `promotion` field at all).
5. `holdout_not_covered` — `window ⊄ run.period` (the run never measured the reserved region).
6. `warmup_insufficient` — the warmup region `[run.period.from, window.from)` contains fewer than
   `minWarmupBars` **distinct engine equity steps** (see clarification below), so the in-window
   evaluation is cold-started (the E3b slicing artifact). A real warmup requirement, not just
   `from < window.from`.
7. `evaluation_insufficient` — the anchored holdout-window slice has `< 2` equity points OR fewer than
   the policy `minTrades` in-window trades.
8. **Compute** holdout-window metrics for candidate + curated (via `evaluateWindow`, POLICY metric
   names) and `decideVerdict(candidate holdout metrics, promotion thresholds)` → a KNOWN verdict
   `'passed' | 'failed'`. (Computed BEFORE the ledger so the verdict can be persisted on the attempt
   row.)
9. **Record the attempt** (`recordIfNewAndGetAttempt`, storing the just-computed verdict) → `attemptNumber`.
   On ledger throw ⇒ `attempt_record_failed`, no signature (fail-closed). This runs regardless of the
   verdict, so a `failed` attempt still advances the epoch counter — a future hard-limit can't be gamed
   by racking up metric failures.
10. If the recorded verdict is `failed` ⇒ `metrics_failed` (recorded/counted, no signature).
11. Else ⇒ sign `backtest-evidence/v2` (binding `attemptNumber`) ⇒ `passed`.

Result: `passed` (signed) or `not_qualified` with exactly one `reason`.

**Warmup measurement (clarification):** `minWarmupBars` counts **distinct engine equity-curve steps
with `barTs < window.from`** (i.e. distinct engine timestamps actually simulated before the holdout),
NOT calendar bars — on a multi-symbol tape one engine step spans all symbols, and calendar gaps
(weekends/halts) don't produce steps. This measures real simulated warmup, not wall-clock span.

## Warm evaluation over the holdout window (shared with E3b)

**Extract** the window-evaluation logic currently private in `walk-forward-exec.ts` into a shared pure
module `src/engine/window-eval.ts`, consumed by BOTH E3b's `runWalkForward` and E4b's gate (no
duplication):

```ts
// pure: metrics over [window.from, window.to) of a completed outcome, with a boundary anchor for
// returns and a fully-in-test trade filter. requestedMetrics is POLICY-supplied, not request.metrics.
export function evaluateWindow(
  outcome: CompletedOutcome,
  window: RunPeriod,
  requestedMetrics: readonly string[],
): { metrics: Record<string, number>; equityPoints: number; inTestTrades: number; carryInClosedTradeCount: number };
```

E3b's `runWalkForward` is refactored to call `evaluateWindow` (behavior-preserving; its existing tests
must stay green — a byte-identical refactor). E4b calls it on the CANDIDATE outcome (run over
`period ⊇ holdout`, warm through pre-holdout) with the **promotion-policy metric names** (NOT
`request.metrics` — a client must not be able to omit an inconvenient metric). The curated baseline is
evaluated on the **same holdout slice** for provenance/comparison (not full-period metrics).

## Attempt ledger (atomic, stable epoch)

New durable store `PromotionAttemptLedger` (InMemory + Pg + migration), recording each promotion
attempt so the platform/lab can rate-limit (a hard-limit is a follow-up, not this slice).

- **Period-free promotion family key.** The E2 `computeFamilyKey` already hashes `period` — wrapping it
  does NOT remove period, so E4b defines its OWN key:
  ```ts
  computePromotionFamilyKey(req) = sha256(canonicalJson({
    hint: req.trialFamilyHint ?? req.moduleRef.id, datasetRef, symbols: [...symbols].sort(), timeframe,
  }));  // NO run period
  ```
- **Stable epoch key:** `qualificationEpochKey = sha256(canonicalJson({ promotionFamilyKey,
  epochId: <resolved>, policyVersion: ctx.policyVersion }))`. It uses the TRUSTED-RESOLVED `epochId`
  (not coverage, not the raw client ref) so it does not reset on ingest; `promotionFamilyKey` carries
  no period; `policyVersion` makes a policy change a new regime.
- **Per-attempt identity includes the data snapshot:** `attemptIdentity = sha256(canonicalJson({
  requestFingerprint, datasetFingerprint }))`. Two runs of the SAME request but on a DIFFERENT dataset
  snapshot (after a fix/backfill — different `datasetFingerprint`, different result) are DISTINCT
  attempts, not collapsed; a true replay (same request AND same snapshot) keeps its historical number.
- **Atomic API:**
  ```ts
  recordIfNewAndGetAttempt(r: PromotionAttemptRecord): Promise<{ attemptNumber: number; inserted: boolean }>;
  ```
  Uniqueness on `(qualificationEpochKey, attemptIdentity)`. The `attemptNumber` is **persisted on each
  row** (not recomputed by counting) and assigned by a **transactional epoch counter**, so concurrent
  attempts never collide and a replay returns its historical number:
  - Two rows: `promotion_epoch(epoch_key PK, next_attempt INT)` and
    `promotion_attempt(epoch_key, attempt_identity, attempt_number, request_fingerprint,
    dataset_fingerprint, run_id, result_hash, verdict, created_at_ms, PRIMARY KEY(epoch_key,
    attempt_identity))`.
  - One transaction: (1) `SELECT attempt_number FROM promotion_attempt WHERE (epoch_key,
    attempt_identity)` — if found ⇒ `{ attemptNumber, inserted:false }` (replay, no increment);
    (2) else `INSERT INTO promotion_epoch(epoch_key, next_attempt) VALUES($1,1) ON CONFLICT DO NOTHING`,
    then `SELECT next_attempt … FOR UPDATE` (locks the epoch row); (3) `n = next_attempt`; INSERT the
    attempt row with `attempt_number = n` (+ the stored `verdict`, see the gate order); `UPDATE
    promotion_epoch SET next_attempt = n+1`; COMMIT ⇒ `{ attemptNumber:n, inserted:true }`. The
    `FOR UPDATE` lock serializes concurrent inserts on the same epoch. InMemory mirrors this
    (single-process serialization + stored number).
- **Recorded BEFORE the metrics check** — a genuine qualification attempt (bundle-valid,
  twin-equivalent, holdout covered, warm, evaluable) is recorded/counted regardless of whether its
  metrics then pass, so failed qualification attempts also consume the epoch counter (a future
  hard-limit can't be bypassed by racking up metric failures). See the gate ordering below.
- **Fail-closed on the signature:** if the ledger op throws, the run still completes (job `completed`),
  but the promotion verdict is `not_qualified: attempt_record_failed` and **no signature is emitted** —
  we cannot bind a trustworthy `attemptNumber`, so we must not sign. (The one place E4b is
  fail-CLOSED, unlike the advisory E1–E5 fail-open, because the ledger is part of the enforcement.)
- **Pg concurrency test is mandatory:** `Promise.all` of N concurrent distinct-fingerprint attempts on
  one epoch must yield the exact set `{1..N}` (no duplicates, no gaps); a concurrent replay of an
  existing fingerprint must return its stored number.

## `backtest-evidence/v2` signed body

The v2 body binds the signature to the **held-out evaluation specifically** (a v1 body could be a
full-period pass):

The real v1 `SignedEvidenceBody` is FLAT (`EvidenceScope` is only an input helper to `buildEvidenceBody`,
never nested in the signed body): `{ schema, backtesterRunId, bundleHash, verdict, datasetRef,
window:{fromMs,toMs}, symbols, timeframe, keyId }`. v2 therefore **retains those exact 9 fields at the
top level** (uses `schema`, not a `version` key; `window` = the EXECUTION window in ms) and adds the
E4b held-out binding — no nesting change to the v1 fields:

```ts
interface EvidenceBodyV2 {
  readonly schema: 'backtest-evidence/v2';   // v1 uses 'backtest-evidence/v1' — SAME field
  // — v1 fields, flat + verbatim —
  readonly backtesterRunId: string;
  readonly bundleHash: string;
  readonly verdict: 'passed';                // v2 promotion bodies are only ever signed when passed
  readonly datasetRef: string;
  readonly window: { readonly fromMs: number; readonly toMs: number };  // EXECUTION window (full warm run)
  readonly symbols: readonly string[];       // sorted
  readonly timeframe: string;
  readonly keyId: string;
  // — E4b held-out binding —
  readonly mode: 'promotion';
  readonly evaluationWindow: { readonly fromMs: number; readonly toMs: number }; // reserved holdout window (measured)
  readonly candidateHoldoutMetrics: Record<string, number>;
  readonly curatedHoldoutMetrics: Record<string, number>;
  readonly thresholds: EvidenceThresholds;
  readonly attemptNumber: number;
  readonly qualificationEpochKey: string;
  readonly candidateResultHash: string;
  readonly curatedResultHash: string;
  readonly curatedBaselineRef: string;
  readonly qualification: { coverage: RunPeriod; fraction: number; policyVersion: string; datasetFingerprint: string };
}
```

`window` is the EXECUTION scope (full warm run); `evaluationWindow` is the measured holdout window —
both explicit so a verifier never conflates them. Signed only when `verdict==='passed'` (invariant
preserved). v1 stays for the existing research (non-promotion) evidence path, unchanged.

## Contract (SDK, additive, NON-hashed)

```ts
export interface PromotionResult {
  readonly verdict: 'passed' | 'not_qualified';
  readonly reason?: PromotionFailureReason;            // present iff not_qualified — exactly one (early-return)
  readonly evaluationWindow?: RunPeriod;               // the holdout window, when resolvable
  readonly attemptNumber?: number;                     // present when the ledger recorded the attempt
  readonly evaluatedOn: 'holdout';
}
// RunResultSummary += promotion?: PromotionResult   (non-hashed; advisory feedback for the lab)
// No request-contract change: the epoch is fully server-derived (DatasetIdentityEpochResolver). The
// reservation follow-up adds a request pointer additively when a resolver honors it.
```

`promotion` is present **only** when `BACKTESTER_PROMOTION_HOLDOUT_GATE` is ON AND `mode==='promotion'`.
Flag OFF or non-promotion ⇒ NO `promotion` field at all (never a `holdout_unavailable` result — the
feature is entirely inert, existing v1 evidence behavior).

## Worker wiring

The promotion gate lives in the existing strategy-evidence block (`processNextQueued` strategy path,
where curated + candidate run and `produceStrategyEvidence` is called) — NOT in `finalizeResult`. E4b:
- computes `QualificationWindowContext` at materialize/execution-start (coverage snapshot alongside
  `datasetFingerprint`), resolving the stable `epochId` via the injected `QualificationEpochResolver`;
- runs the promotion gate inside/around `produceStrategyEvidence` (extended for promotion): evaluate
  candidate+curated on the holdout slice, run the composition checks, record the attempt, sign v2 iff
  passed;
- builds a `PromotionResult` and threads it to `finalizeResult` (like `evidenceRef`) to merge onto the
  summary projection **after** `contentRef` (byte-identical result_hash).

Non-promotion runs and the flag-OFF path are untouched (existing v1 evidence behavior).

## Config (dark-launch, default OFF)

`BACKTESTER_PROMOTION_HOLDOUT_GATE` (bool, default OFF) — the master switch for E4b enforcement. When
OFF, `mode:'promotion'` runs behave exactly as today (existing v1 evidence path, no holdout
requirement) ⇒ byte-identical. Requires `BACKTESTER_HOLDOUT_ENABLED` (for a window) + a signing key +
`curatedBaselineRef` to be effective. Promotion policy (thresholds, fraction, `minWarmupBars`,
`minTrades`, `policyVersion`) is server-side config/constants.

## Determinism / invariant

`result_hash = contentRef(payload)` is byte-identical: the `promotion` field and the v2 evidence are
post-hash (summary projection / artifact ref), `decideVerdict` is reused unmodified, and the whole gate
is gated on `BACKTESTER_PROMOTION_HOLDOUT_GATE` + `mode==='promotion'`. Flag OFF or non-promotion ⇒
byte-identical, evidence path unchanged. `decideVerdict` untouched.

## Testing (TDD)

**shared `evaluateWindow`:** anchor + in-test filter identical to E3b's inlined logic; E3b's existing
`walk-forward-exec` tests stay green (byte-identical refactor).

**gate composition** (pure, injected candidate/curated outcomes + a stub ledger): each
`PromotionFailureReason` triggers at its condition (holdout_not_covered when `window ⊄ period`;
warmup_insufficient below `minWarmupBars`; evaluation_insufficient on a `<2`-point slice; metrics_failed
when holdout `decideVerdict='failed'`; twin_divergent; gate_rejected; signing_unavailable); all-pass ⇒
`passed`. Policy metrics used, NOT request.metrics (a request omitting `sharpe` still gets evaluated on
sharpe).

**epoch resolver:** `DatasetIdentityEpochResolver.resolve` returns `{ epochId: datasetRef }` for a
dataset present in the port and `null` for an unknown `datasetRef` (⇒ gate `holdout_unavailable`). The
`epochId` is a pure function of the (server-validated) `datasetRef` — no request field feeds it — so a
client has no lever to reset the counter (there is no epoch-ref request field to vary).

**epoch stability / period-free key:** a GROWN coverage (drifted window) with the SAME resolved
`epochId` keeps the SAME `qualificationEpochKey` (attemptNumber does NOT reset); a different `epochId`
or `policyVersion` ⇒ new epoch. `computePromotionFamilyKey` excludes `period` (two different run
periods, same hint/dataset/symbols/timeframe ⇒ same key).

**attempt ledger:** `recordIfNewAndGetAttempt` — first attempt `{1, inserted:true}`; a distinct second
`{2, true}`; a **true replay (same request AND same `datasetFingerprint`)** `{1, inserted:false}`
(historical number, no inflation); a **same-request-but-new-snapshot (backfill)** ⇒ a NEW attempt
`{n+1, inserted:true}` (dedupe axis is `attemptIdentity = hash(requestFingerprint, datasetFingerprint)`);
persisted `attempt_number` + stored `verdict` on each row. **Pg concurrency (mandatory):** `Promise.all`
of N concurrent distinct attempts on one epoch yields exactly `{1..N}` (no dup, no gap); a concurrent
replay returns its stored number. Same contract on InMemory + Pg (Pg gated by `DATABASE_URL`, exercising
the `FOR UPDATE` counter). Ledger throw ⇒ gate `not_qualified: attempt_record_failed`, no signature.
**Verdict-before-ledger / record regardless:** a `metrics_failed` attempt stores `verdict='failed'` and
still advances the counter (the next distinct attempt gets `n+1`).

**evidence v2:** a passing promotion signs a `backtest-evidence/v2` body embedding the v1 `scope`
(`window:{fromMs,toMs}` = execution) + `evaluationWindow` (holdout) + candidate/curated holdout metrics +
thresholds + verdict + attemptNumber + result hashes + curatedBaselineRef + qualificationEpochKey; a
non-passing promotion emits NO artifact. v1 research path unchanged.

**wiring / determinism:** flag OFF ⇒ NO `promotion` field at all + golden `result_hash` unchanged +
existing evidence behavior; flag ON + non-promotion ⇒ unchanged; flag ON + promotion qualified ⇒
`promotion.verdict='passed'` + v2 evidenceRef; flag ON + promotion not-covered ⇒
`promotion.verdict='not_qualified', reason='holdout_not_covered'` + NO evidenceRef; `result_hash`
byte-identical in every case.

## Rollout / follow-up (NOT enablement)

- **Enablement requires ALL THREE co-preconditions (keep the flag OFF until all are in place):**
  1. **Platform `backtest-evidence/v2` verifier** — canonical verification of the v2 body.
  2. **Platform `requirePromotionEvidence` admission policy** — admit only v2 promotion-grade
     signatures (else E4b is a producer, not an enforcer).
  3. **Lab Outcome-Embargo** — the refine loop must never see holdout-window outcomes during
     generation. This is NOT optional: since the hard attempt-limit is deferred, an un-embargoed loop
     can retry promotion and adapt to the holdout even off the mere binary `passed`/`metrics_failed`
     signal, defeating the gate. The signature-gate + embargo together are the defense.
  The `DatasetIdentityEpochResolver` is functional at enable-time (coarse but correct), so the resolver
  is NOT itself an enablement blocker — the three above are.
- **Follow-ups:** hard attempt-limit (`maxAttempts` policy → `not_qualified: exhausted`); the finer
  per-campaign **reservation service** behind `QualificationEpochResolver` (swaps in without touching
  the gate); auto-advertising the holdout window so the lab submits `period ⊇ holdout` correctly.

## Out of scope

Hard attempt-limit/reject; the lab Outcome-Embargo; the platform admission policy + v2 verifier; job
terminal-state changes (job stays `completed`); momentum path.
