# E3b — server-side per-fold walk-forward execution (advisory) design

Date: 2026-07-13. Phase E, ROADMAP item 22 (execution half; E3a substrate = #106). Predecessors:
`docs/FEATURE-PARITY.md` (§4 E3), E3a (`splitWalkForward`/`aggregateFolds`, merged, unwired), E1a
(`computeMetrics`), the E5a/E2 advisory-I/O guard invariant.

## Goal

Turn E3a's pure substrate into **real per-fold execution**: run each walk-forward fold's out-of-sample
window as a backtest and report cross-fold OOS stability. This is the first *executing* Phase E slice
(E1–E5 were pure projections), so determinism and `result_hash` semantics need care.

**Framing (decided): advisory overlay on the canonical run.** The canonical run over the full
`request.period` is unchanged — same `result_hash`, byte-identical. When the feature flag is ON **and**
the request carries a `walkForward` scheme, we *additionally* execute the folds, aggregate, and attach
a **non-hashed** `RunResultSummary.walkForward`. `decideVerdict` is untouched. Fail-open: a fold fault
never fails the canonical run. Cost: N+1 engine runs.

## Warmup / evaluation semantics (the load-bearing correctness decision)

Executing **only** `fold.test` cold-starts state at every fold boundary (an EMA(200) re-warms each
fold → the measurement is a slicing artifact). So each fold runs the engine **once over its EXECUTION
window `[train.from, test.to]`**, and metrics are computed over the EVALUATION window `test` only.

**Continuous-state warmup (named explicitly):** the engine really *trades* over `train` — so what warms
through `train` is not only indicators but **cash, open positions, and strategy state**. Each fold
therefore enters `test` in the continuous state it would have had running from `train.from`. This is
the intended semantics (it is what makes the OOS measurement realistic), not a side effect.

**Evaluation over the test window (post-hoc, pure — no engine change):**
- **Equity slice with a boundary anchor.** `equity = [the last equityCurve point with barTs < test.from]
  ++ [points with barTs ∈ [test.from, test.to)]`. The anchor is required: without it the first in-test
  return is measured from the *end* of the first test bar, so pnl/Sharpe/drawdown/CAGR lose the first
  OOS return and the carry-in level. The `< 2 points` insufficiency check is applied **after** the
  anchor is prepended.
- **Trade filter — fully in-test only.** The filter `entryTs >= test.from && exitTs < test.to` applies
  to **every trade-based metric** computed for the fold — not only expectancy / SQN / win rate but also
  `total_trades`, `profit_factor`, `top_trade_contribution_pct`, and any other metric derived from the
  trade list. A carry-in trade (entered in `train`, closed in `test`) would otherwise contribute its
  full PnL — including the `train` leg — to those metrics, which is not test-only attribution. Carry-in
  closed trades are excluded from the trade list passed to `computeMetrics` and reported as provenance
  (`carryInClosedTradeCount`); their equity effect is still captured via the boundary anchor
  (mark-to-market). Correct synthetic re-valuation of a carry-in trade's PnL at the boundary is a
  follow-up.
- `computeMetrics(request.metrics, anchoredEquity, inTestTrades, { elapsedYears: testSpanYears })` (E1a,
  pure).

`train` is executed for warmup and carried as provenance; it is never the measurement window.

## Scope

- **In:** pure orchestrator `apps/backtester/src/engine/walk-forward-exec.ts`; the SDK contract
  (`WalkForward` + `WalkForwardFoldResult` + `WalkForwardFailure` + `WalkForwardExecAggregate`,
  `BacktestRunRequest.walkForward?`, `RunResultSummary.walkForward?`); flag-gated worker wiring
  (`resolveWalkForward` on both canonical miss and hit paths); the requestFingerprint change; submit-time
  structural validation; config (flag + max-folds).
- **Out (later):** momentum path (no walkForward — consistent with E1b/E2/E4a/E5a); synthetic carry-in
  PnL re-valuation; executing/measuring the `train` window as its own result; parallel fold execution
  (sequential in-worker first); CPCV / purging+embargo; per-fold artifact persistence; enforcement /
  gate-flip on OOS stability (E4b territory).

## Pure orchestrator — `src/engine/walk-forward-exec.ts`

`runWalkForward(input, runFold): Promise<WalkForward>` — deterministic control flow, all I/O injected.
Never touches the ledger/pool/store/webhook; `runFold` is the only I/O and it is injected.

```ts
export interface WalkForwardExecInput {
  readonly scheme: WalkForwardScheme;            // { folds, mode } from the request
  readonly period: RunPeriod;                    // request.period (full span split into folds)
  readonly requestedMetrics: readonly string[];  // request.metrics — same names as the canonical run
  readonly maxFolds: number;                     // policy cap (config), validated safe-int ≥ 1
  readonly deadlineExceeded: () => boolean;      // true once the run's deadline has passed (injected)
}
// runFold executes ONE fold's execution window [train.from, test.to]. On failure it throws a
// WalkForwardFoldError carrying a normalized `.code`; the orchestrator maps an un-coded throw to
// 'runner_failure'.
export type RunFold = (fold: FoldWindow) => Promise<{ outcome: CompletedOutcome; hash: string }>;
```

Control flow (the enabled path NEVER throws and NEVER returns `undefined` — it always resolves to a
`WalkForward`; a truly unexpected throw is caught at the top and returned as
`{ status: 'unavailable', reason: 'internal_error', failedFolds: [], insufficientFolds: [] }`):
Every `unavailable` result also carries `failedFolds` and `insufficientFolds` (empty when no fold ran),
so per-fold diagnostics survive the all-failed case.
1. `!Number.isSafeInteger(scheme.folds) || scheme.folds < 1` cannot occur here (submit rejected it),
   but `scheme.folds > maxFolds` ⇒ `{ status: 'unavailable', scheme, reason: 'folds_exceeds_max',
   failedFolds: [], insufficientFolds: [] }`.
2. `splitWalkForward(period, scheme)` in try/catch — throw ⇒ `{ status: 'unavailable', reason:
   'split_error', failedFolds: [], insufficientFolds: [] }`.
3. For each `fold` in order:
   - `deadlineExceeded()` ⇒ push `{ index, code: 'budget_exhausted' }` for this and every remaining
     fold, then **stop**.
   - else `runFold(fold)` in try/catch:
     - throw ⇒ push `{ index, code: err.code ?? 'runner_failure' }` to `failedFolds`.
     - ok ⇒ evaluate the TEST window (anchored equity slice + in-test trade filter + `computeMetrics`,
       per "Warmup / evaluation"). Anchored-equity `< 2` points ⇒ push `fold.index` to
       `insufficientFolds` (ran, no measurable OOS returns — excluded from aggregate). Else push
       `WalkForwardFoldResult { index, train, test, foldOutcomeHash: hash, metrics,
       carryInClosedTradeCount }` to `folds`.
4. Assemble:
   - `aggregate = { ...aggregateFolds(folds.map(f => ({ index: f.index, metrics: f.metrics }))),
     requestedFoldCount: scheme.folds, completedFoldCount: folds.length, insufficientFolds }`.
   - `completedFoldCount === 0` ⇒ `{ status: 'unavailable', reason: <'all_folds_failed' if
     `failedFolds` non-empty else 'insufficient_folds'>, failedFolds, insufficientFolds }` (the
     collected per-fold diagnostics are surfaced, not discarded).
   - `completedFoldCount === scheme.folds` ⇒ `{ status: 'resolved', folds, aggregate, failedFolds: [] }`.
   - otherwise ⇒ `{ status: 'partial', folds, aggregate, failedFolds }`.

## Contract (SDK, additive, NON-hashed)

```ts
export type WalkForwardFailureCode =
  | 'validation_error' | 'missing_dataset' | 'sandbox_failure' | 'timeout'
  | 'runner_failure' | 'budget_exhausted';
export interface WalkForwardFailure {
  readonly index: number;
  readonly code: WalkForwardFailureCode;
}
export interface WalkForwardFoldResult {
  readonly index: number;
  readonly train: RunPeriod;            // continuous-state warmup window (executed, not measured)
  readonly test: RunPeriod;             // evaluation window
  readonly foldOutcomeHash: string;     // contentRef(full execution outcome for [train.from, test.to])
  readonly metrics: Record<string, number>;  // over the anchored test slice + in-test trades
  readonly carryInClosedTradeCount: number;  // entered train, closed test — excluded from trade metrics
}
export interface WalkForwardExecAggregate extends WalkForwardAggregate { // E3a: { foldCount, metrics }
  readonly requestedFoldCount: number;
  readonly completedFoldCount: number;
  readonly insufficientFolds: readonly number[];
}
export type WalkForward =
  | {
      readonly status: 'resolved' | 'partial';
      readonly scheme: WalkForwardScheme;
      readonly folds: readonly WalkForwardFoldResult[];   // completed folds only
      readonly aggregate: WalkForwardExecAggregate;
      readonly failedFolds: readonly WalkForwardFailure[];
    }
  | {
      readonly status: 'unavailable';
      readonly scheme: WalkForwardScheme;
      readonly reason:
        | 'split_error' | 'all_folds_failed' | 'folds_exceeds_max'
        | 'insufficient_folds' | 'internal_error';
      // Per-fold diagnostics survive even when nothing completed — `all_folds_failed` is exactly where
      // the normalized codes matter. Empty for split_error / folds_exceeds_max / internal_error
      // (no fold ran).
      readonly failedFolds: readonly WalkForwardFailure[];
      readonly insufficientFolds: readonly number[];
    };
// BacktestRunRequest += walkForward?: WalkForwardScheme   (per-request opt-in)
// RunResultSummary   += walkForward?: WalkForward           (non-hashed projection)
```

`status`: **resolved** = every requested fold completed; **partial** = ≥1 completed but some
failed/insufficient/budget-cut; **unavailable** = none completed.

## Worker wiring — `resolveWalkForward` (overlay/strategy, flag-gated)

Exported `resolveWalkForward(deps, claimed, engine): Promise<WalkForward | undefined>` (mirrors
`resolveHoldoutMarker`/`resolveNovelty`). Returns `undefined` **only** for the gate: flag OFF, request
has no `walkForward`, or `engine === 'momentum'`. When enabled-with-scheme it always resolves to a
`WalkForward` (never `undefined`, never throws — top-level guard → `unavailable: internal_error`).

**Runs on BOTH the canonical miss and hit paths.** The result cache stores a canonical **payload
template**, not a prior job's summary, and a cache HIT re-runs `finalizeResult` (restamp) — so a prior
job's `walkForward` is not retrievable from the cache. E3b therefore executes the folds fresh for the
current job on both paths, before the terminal transition:

```
canonical MISS → engine run → finalizeResult ─┐
canonical HIT  → restamp     → finalizeResult ─┤
                                               ├─→ resolveWalkForward(deps, claimed, engine)
                                               │     → merge walkForward onto summary (after contentRef)
                                               └─→ store.transition(... terminal, resultSummary ...)
```

Folds are skipped only on **idempotency replay of an already-terminal job** (the job already has a
stored summary). (An advisory sidecar cache to reuse a prior job's folds is deliberately out of scope —
it would materially expand E3b.)

**Production `runFold(fold)` — one FRESH execution per fold:**
- build the execution-window tape via `buildOverlayDataset({ datasetRef, symbols, timeframe,
  period: { from: fold.train.from, to: fold.test.to } })`, gated through the existing `overlayTapeCache`
  (its key already includes `from`/`to` — the proven per-window rebuild, not a new mechanism);
- run with a **fresh router/executor session built per fold** (`overlayRouterFor(deps, …)`), and
  `router.closeAll()` in a `finally`. **No shared mutable sandbox/router session is reused across
  folds** — each fold's execution state must be fresh (load-bearing while P1-4 IPC/sequence is open);
- after the run, **`assertSandboxClean(router)` (or the equivalent existing sandbox-health assertion)
  before accepting the outcome** — a dirty/leaked session invalidates the fold;
- classify any failure into a normalized `WalkForwardFailureCode` and throw a `WalkForwardFoldError`
  with that `.code` (missing dataset → `missing_dataset`; sandbox crash → `sandbox_failure`; wall-time
  → `timeout`; submit/shape → `validation_error`; else → `runner_failure`);
- on success return `{ outcome, hash: contentRef(outcome) }`.

**Deadline (soft, between folds — honest framing):** `deadlineExceeded` compares `deps.clock()` against
the run's effective deadline (the same run-timeout budget the worker already enforces) and is checked
**before starting each fold**. It does NOT interrupt an already-running fold — so once the deadline
passes, no *new* fold starts, but the fold in flight may finish later. The **hard upper bound on any
single fold is the existing per-fold sandbox wall-time timeout** (unchanged by E3b); the worst-case
overrun past the run deadline is therefore one sandbox-timeout, not N. (Passing a shrinking
`remainingMs` into each fold session to bound it tighter is a possible follow-up; for E3b the
pre-fold check plus the standing sandbox timeout is the guard.)

**Advisory-I/O safety (the E5a/E2 invariant):** a walk-forward fault NEVER fails the canonical run —
per-fold faults are contained as `failedFolds`; an unexpected orchestrator/setup fault becomes
`unavailable: internal_error`.

**Isolation:** folds call the engine entry directly (never `finalizeResult`), so they do NOT record E2
trials, do NOT write the novelty pool, do NOT resolve holdout/diagnostics, and do NOT fire the
completion webhook. This is a tested invariant.

## Request fingerprint (dedup identity) — config-independent

`walkForward` is part of the request fingerprint / `computeIdentity` **whenever the field is present in
the request — unconditionally, never gated on the feature flag.** The fingerprint must be a pure
function of the request so that toggling server config never changes the identity of an already-stored
request (`storedRequestFingerprint()` has no access to that config). Consequences:
- pre-E3b clients (no `walkForward` field) get byte-identical fingerprints — the absent field is not in
  the canonical JSON;
- two requests differing only in their scheme get different fingerprints (correct — they are different
  requests, and one scheme's advisory result must never replay for the other);
- a `walkForward`-bearing request with the flag OFF still fingerprints on the field (stable), and simply
  runs no folds. The canonical `result_hash` is unaffected in every case (the full-period outcome does
  not depend on the scheme).

## Submit-time validation (structure → HTTP 400)

TypeScript does not guard inbound JSON, so `submit.ts` validates the `walkForward` shape when present,
**independent of the feature flag**: `folds` is a safe integer `≥ 1`; `mode ∈ { 'rolling', 'expanding' }`.
A structurally invalid scheme is a client error → **HTTP 400**. This is distinct from the `MAX_FOLDS`
**policy** cap, which accepts the request and yields an advisory `unavailable: folds_exceeds_max` at
execution time.

## Config (dark-launch, default OFF)

`BACKTESTER_WALK_FORWARD_ENABLED` (bool, default OFF — master kill-switch) +
`BACKTESTER_WALK_FORWARD_MAX_FOLDS` (default `20`; parsed and validated as a **safe integer ≥ 1**, else
the default). Flag OFF or scheme absent ⇒ no fold execution, `result_hash` byte-identical.

## Determinism / invariant

`walkForward` lives ONLY on the non-hashed summary projection. Flag OFF or scheme absent ⇒ field absent
⇒ goldens byte-identical. `decideVerdict` untouched — advisory. (The fingerprint reflects the request's
`walkForward` field but not the flag, so it is config-stable; goldens that send no scheme are
unaffected.)

## Testing (TDD)

**pure orchestrator** (stub `runFold` returning canned `CompletedOutcome`s + stub `deadlineExceeded` —
no Docker): all-complete ⇒ `resolved` (`requestedFoldCount === completedFoldCount`, empty
`insufficientFolds`); one fold throws a coded error ⇒ `partial` + `failedFolds:[{index, <code>}]` (assert
the code is preserved, and an un-coded throw maps to `runner_failure`); all throw ⇒ `all_folds_failed`
**with `failedFolds` non-empty (diagnostics survive the all-failed case)**; `splitWalkForward` throw ⇒
`split_error` (empty `failedFolds`/`insufficientFolds`); `folds > maxFolds` ⇒ `folds_exceeds_max`; a fold whose anchored
test slice has `< 2` points ⇒ `insufficientFolds`, excluded from aggregate; all-insufficient ⇒
`insufficient_folds`; `deadlineExceeded` flips true after fold k ⇒ folds `k..N-1` coded
`budget_exhausted`, loop stops, status `partial`; an unexpected orchestrator throw ⇒
`unavailable: internal_error` (never a rejected promise).

**warmup / evaluation:** a fixture outcome spanning `[train, test]` — assert (a) the anchor point (last
equity before `test.from`) is included so the first in-test return is measured from the boundary;
(b) a carry-in trade (`entryTs < test.from && exitTs ∈ test`) is excluded from **all** trade-based
metrics — assert `total_trades` and `profit_factor` reflect only in-test trades — and is counted in
`carryInClosedTradeCount`; (c) trades and equity points fully before `test.from` are excluded.

**config:** default OFF, `maxFolds` default 20; exact-`true` enables; custom safe-int parsed; a
non-int/`< 1` max falls back to 20.

**submit validation:** `walkForward: { folds: 0 }` / `{ folds: 2.5 }` / `{ mode: 'bogus' }` ⇒ 400; valid
⇒ accepted; absent ⇒ accepted (flag-independent).

**fingerprint:** two requests differing only in `walkForward.folds` get **different** fingerprints;
adding/removing the flag does NOT change a given request's fingerprint (config-independence); a request
with no `walkForward` fingerprints identically to the pre-E3b shape.

**wiring** (fake engine-run seam, no Docker): flag OFF ⇒ no `walkForward` field + golden `result_hash`
unchanged; flag ON + scheme, canonical MISS ⇒ `walkForward` present; flag ON + scheme, canonical HIT
(restamp path) ⇒ `walkForward` ALSO present (proves folds run on both paths); **durability** — after a
store **round-trip** (persist then fresh read) the `walkForward` is intact, tested on **both**
`InMemoryJobStore` and `PgJobStore` (Pg exercises JSON (de)serialization); **isolation** — a
walk-forward run does NOT increment the E2 trial ledger, does NOT add to the novelty pool, and does NOT
invoke the completion webhook; **fresh session** — `runFold` constructs and `closeAll()`s a router per
fold and `assertSandboxClean` is called before accepting each outcome (assert per-fold construct/close,
no reuse).

## Rollout / follow-up (not enablement)

- Additive SDK contract change ⇒ an **SDK release** is required before a lab consumer can read
  `walkForward`; the **lab-side consumer of the walk-forward stability signal is a separate follow-up**.
- **Do NOT enable the production flag until P1-4 (IPC/sequence) is closed** — per-fold fresh sessions
  plus `assertSandboxClean` are the guard, but the fault surface is real; keep it dark-launched.
