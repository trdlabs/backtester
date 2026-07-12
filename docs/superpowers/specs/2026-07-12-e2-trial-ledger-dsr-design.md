# E2 — Trial ledger + Deflated Sharpe Ratio gate (design, advisory)

Date: 2026-07-12. Phase E, ROADMAP item 21. Predecessors: `docs/FEATURE-PARITY.md` (§4 E2),
E1a (PR #103 — the distribution moments this consumes). Family-identity layering: ROADMAP item 21
(L0–L3).

## Goal

Count trials per hypothesis family server-side and compute a Deflated Sharpe Ratio (Bailey &
López de Prado 2014) that scales admission difficulty with the recorded trial count N — turning our
"provable reproducibility" into "provable rigor". **E2 is advisory + dark-launched**: it records
N + DSR into a non-hashed result field (and the unsigned evidence result), never changes the
`decideVerdict` gate, and is off unless `BACKTESTER_TRIAL_LEDGER=true`. `result_hash` stays
byte-identical.

## Decisions (from brainstorming)

- **Ownership: hybrid.** Server owns the ledger and authoritatively counts N; lab only *hints* the
  family via a new `trialFamilyHint` (family-identity layer L1). Server stays the count authority.
- **V[SR]: hybrid.** Asymptotic `(1 + 0.5·SR²)/T` for small N; empirical sample variance of stored
  per-trial Sharpes for `N ≥ empiricalMinN` (default 5, configurable). Ledger therefore stores each
  trial's Sharpe + moments + T.
- **Family key includes market context AND period:** `sha256(canonicalJson({ hint:
  trialFamilyHint ?? moduleRef.id, datasetRef, symbols: [...].sort(), timeframe, period: {from,to}
  }))`. Same idea on a different symbol/timeframe/window is a *different* family (else V[SR] mixes
  incomparable Sharpes).
- **Recording: advisory, non-hashed.** N+DSR → new non-hashed `RunResultSummary.trialContext` +
  unsigned `ProduceStrategyResult`. `decideVerdict` unchanged. Flag default OFF.
- **Signed `backtest-evidence/v1` body is NOT touched** — cross-repo (platform verifies the canonical
  body); deferred to the gate-flip follow-up with platform forward-compat coordination.

## Components

### 1. Pure DSR module — `src/engine/deflated-sharpe.ts` (deterministic, stateless)

- `normalCdf(x)`, `normalInvCdf(p)` — **own deterministic approximations**, NOT `Math.erf` (no
  runtime guarantee): `normalCdf` via a Zelen–Severo / A&S 7.1.26 rational erf approx (~1e-7);
  `normalInvCdf` via Acklam's algorithm (~1e-9).
- `asymptoticSharpeVariance(sr, T) = (1 + 0.5·sr²)/T`.
- `deflationThreshold(vSR, N) = √vSR · [ (1−γ)·Φ⁻¹(1−1/N) + γ·Φ⁻¹(1−1/(N·e)) ]`, γ = Euler–Mascheroni
  (0.5772156649…), e = Euler's number.
- `deflatedSharpe({ sr, skew, kurtosis, T, sr0 }) = Φ[ (sr − sr0)·√(T−1) / √(1 − skew·sr +
  (kurtosis−1)/4·sr²) ]` (Pearson kurtosis, normal = 3 — E1a's `returns_kurtosis` plugs in directly).
- Orchestrator `computeDsr({ sr, skew, kurtosis, T, priorSharpes, empiricalMinN })` →
  `{ deflatedSharpe, trialCount: N, sr0, vSR, vSRBasis } | null`. `N = priorSharpes.length` (this
  run already recorded). **Guards (fail-closed → return `null`, no trialContext written):**
  - `N ≤ 1` ⇒ `sr0 = 0`, `vSRBasis = 'asymptotic'` (avoids `Φ⁻¹(1−1/1)=Φ⁻¹(0)=−∞`). At N=1 DSR
    reduces to the Probabilistic Sharpe Ratio vs 0 — meaningful.
  - `N < empiricalMinN` (but > 1) ⇒ asymptotic vSR; `N ≥ empiricalMinN` ⇒ empirical
    `sampleVariance(priorSharpes)`.
  - `T < 2`, denominator `1 − skew·sr + (kurtosis−1)/4·sr² ≤ 0`, or any non-finite intermediate ⇒
    `null`.
  - All outputs `quantize`d.

### 2. Trial ledger — `src/jobs/ledger/trial-ledger.ts` (worker-time store, mirrors `ResultCache`)

```ts
interface TrialRecord {
  familyKey: string;
  requestFingerprint: string;   // dedupe axis — replay/cache-hit must NOT inflate N
  runId: string;
  resultHash: string;
  trialFamilyHint?: string;     // provenance
  marketContext: { datasetRef: string; symbols: readonly string[]; timeframe: string;
                   period: { from: string; to: string } };
  sharpe: number; skew: number; kurtosis: number; tCount: number;
  createdAtMs: number;
}
interface TrialLedger {
  /** Idempotent on (familyKey, requestFingerprint); returns true iff a new row was inserted. */
  recordIfNew(r: TrialRecord): Promise<boolean>;
  query(familyKey: string): Promise<readonly TrialRecord[]>;
}
```

- `InMemoryTrialLedger` (Map keyed `familyKey`→Map keyed `requestFingerprint`) + `PgTrialLedger`.
- Migration `0007_trial_ledger.sql`: table `backtest_trial_ledger` with
  **`UNIQUE(family_key, request_fingerprint)`** (the dedupe key — `recordIfNew` = `INSERT … ON
  CONFLICT DO NOTHING`), index on `family_key` for `query`.
- `computeFamilyKey(req)` helper (same dir): the canonical-JSON sha256 above. `trialFamilyHint` is
  **NOT** added to `requestFingerprint` (advisory, not run-affecting — like `correlationId`), so
  existing dedup/idempotency keys are unchanged.

### 3. Contract additions (SDK, additive — optional fields, no consumer break)

- `RunSubmitRequest` / `BacktestRunRequest` `+= trialFamilyHint?: string`.
- `RunResultSummary += trialContext?: TrialContext` where
  `TrialContext = { familyKey; familyHint?; trialCount; deflatedSharpe; sr0; vSR; vSRBasis:
  'asymptotic'|'empirical'; tCount }`. **Not part of the hashed payload.**

### 4. DSR inputs independent of `request.metrics`

Ledger needs sharpe+skew+kurtosis+T, but metrics are request-gated. Export a **narrow** helper
`dsrInputsFromEquity(equity): { sharpe; skew; kurtosis; tCount } | null` from `metrics.ts` (reuses
the private `computeReturnsStats`; returns `null` when the series is invalid / `tCount < 2`). Does
not widen the metrics module's internal surface beyond this.

### 5. Wiring — worker finalize, flag-gated

In the finalize path (after `finalizeResult`, so `resultHash` is already computed), when
`BACKTESTER_TRIAL_LEDGER` on and `deps.trialLedger` present:
1. `inputs = dsrInputsFromEquity(equity)`; if `null` (degenerate run, `T<2`) → skip entirely (no
   record, no trialContext).
2. `familyKey = computeFamilyKey(request)`.
3. `recordIfNew({ familyKey, requestFingerprint, runId, resultHash, trialFamilyHint, marketContext,
   ...inputs, createdAtMs })` — replay of the same trial is a no-op.
4. `trials = query(familyKey)`; `dsr = computeDsr({ ...inputs, priorSharpes: trials.map(t=>t.sharpe),
   empiricalMinN })`.
5. If `dsr !== null` → attach `trialContext` to the summary projection (**after** the hash) and to
   the unsigned `ProduceStrategyResult` on the strategy path.

Flag OFF ⇒ none of this runs ⇒ `trialContext` absent ⇒ byte-identical `result_hash` AND API
response. Concurrency: `recordIfNew` + `query` is not atomic across processes, so N is approximate
under simultaneous same-family finalizes — acceptable for advisory (documented); a later atomic
`recordAndQueryFamily` is a Pg follow-up.

### 6. Gate

`decideVerdict` **unchanged**. No DSR threshold in admission. Flip deferred to a post-calibration
follow-up.

## Determinism / invariant

`trialContext` lives on the `RunResultSummary` projection, written after `contentRef(payload)`,
never in `payload`. DSR is stateful (depends on family history) — that is *why* it is out of the
hash and labelled advisory. Golden `result_hash` unmoved; flag-OFF path fully byte-identical.

## Testing (TDD)

**Pure DSR:** `normalCdf(0)=0.5`, `normalCdf(1.96)≈0.975`, `normalInvCdf(0.975)≈1.96`,
`normalInvCdf(normalCdf(x))≈x`; worked-example `deflationThreshold` + `deflatedSharpe` vs
independently-computed values; vSR-basis switch at `empiricalMinN`; **`N=1` ⇒ no Inf/NaN, `sr0=0`,
`vSRBasis='asymptotic'`**; denominator ≤0 ⇒ `null`; `T<2` ⇒ `null`.
**Ledger:** `recordIfNew`/`query` (InMemory always, Pg gated/skips); **repeated same
`(familyKey, requestFingerprint)` does NOT increase `trialCount`**; distinct params (distinct
requestFingerprint) in one family ⇒ N grows.
**familyKey:** same hint+context ⇒ same key; symbol-order-insensitive; **different period ⇒ different
key**; different timeframe ⇒ different key.
**Wiring:** flag OFF ⇒ no `trialContext` + golden `result_hash` unchanged; flag ON ⇒ `trialContext`
present, `trialCount` as expected, second distinct trial ⇒ N=2, replay ⇒ N stable; **`trialContext`
contains only finite numbers**.
**Non-regression:** flag-OFF byte-identity (existing goldens green).

## Out of scope

Signed `backtest-evidence/v1` body change (cross-repo; gate-flip follow-up); the gate flip itself;
walk-forward/CPCV (E3); lab-side `trialFamilyHint` emission (separate lab slice); atomic
cross-process `recordAndQueryFamily`.
