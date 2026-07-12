# E3a — Walk-forward substrate (pure split + aggregate) design

Date: 2026-07-12. Phase E, ROADMAP item 22 (first slice). Predecessors: `docs/FEATURE-PARITY.md`
(§4 E3), E2 (#104/#105). E3 is split into **E3a (this slice — pure substrate + contract types)**
and **E3b (server-side per-fold execution wiring)**.

## Goal

Ship the deterministic, self-contained substrate for walk-forward evaluation — a pure split module
(period → ordered train/test fold windows) and a pure OOS aggregation module (per-fold metrics →
transparent cross-fold stats) — plus the shared contract types. **E3a executes nothing and does not
touch the submit or result path**, so it cannot create the impression that the server already runs
walk-forward. `result_hash` and all goldens are untouched by construction.

## Scope

- **In:** `apps/backtester/src/engine/walk-forward.ts` (pure `splitWalkForward` + `aggregateFolds` +
  a typed config error) and the shared **types** in `packages/sdk/src/contracts/run.ts`
  (`WalkForwardScheme`, `DateWindow`, `FoldWindow`, `WalkForwardFoldMetrics`,
  `WalkForwardMetricStats`, `WalkForwardAggregate`).
- **Out (deferred to E3b):** accepting `walkForward` on `BacktestRunRequest` (submit path);
  `RunResultSummary.walkForward` (result projection); the worker per-fold execution loop + tape/period
  slicing; purge/embargo, CPCV, PBO; parameter fitting in the train window. **No request field, no
  result field, no submit validation, no worker change in E3a** — a server API that would imply WF
  runs today.

## Contract types (SDK, exported; not yet wired into any request/result)

```ts
export interface WalkForwardScheme { readonly folds: number; readonly mode: 'rolling' | 'expanding'; }
export interface DateWindow { readonly from: string; readonly to: string; }
export interface FoldWindow { readonly index: number; readonly train: DateWindow; readonly test: DateWindow; }
export interface WalkForwardFoldMetrics { readonly index: number; readonly metrics: Record<string, number>; }
export interface WalkForwardMetricStats {
  readonly mean: number; readonly stddev: number; // population stddev (consistency with E1a, small N)
  readonly min: number; readonly max: number; readonly positiveFraction: number;
}
export interface WalkForwardAggregate { readonly foldCount: number; readonly metrics: Record<string, WalkForwardMetricStats>; }
```

Scheme is intentionally minimal — `{ folds, mode }` only. NO `trainBars`/`testBars`/`step` until the
executor exists, so the contract never promises more than E3b implements.

## `splitWalkForward(period: DateWindow, scheme: WalkForwardScheme): FoldWindow[]`

Partition `[fromMs, toMs]` into `folds + 1` equal time segments (integer-ms boundaries via
`fromMs + Math.round(total·k/segments)`, deterministic). Segment 0 is the initial in-sample/warmup
region and is never a test window. For fold `i` (0-based, `0 ≤ i < folds`):

- `test = [boundary(i+1), boundary(i+2)]` — the OOS window (segments 1..folds cover `[boundary(1), toMs]`).
- `train = [fromMs, boundary(i+1)]` when `mode='expanding'`; `[boundary(i), boundary(i+1)]` when
  `mode='rolling'`.

Both `train` and `test` are included now (E3b needs the contract without a rework), even though E3a
aggregates only test-window metrics. ISO strings via `new Date(ms).toISOString()` (deterministic
given ms).

**Fail-fast (typed `WalkForwardConfigError`, not an empty array — a config error must not hide):**
non-finite `from`/`to`, `to ≤ from`, or `folds` not a positive safe integer.

## `aggregateFolds(perFold: readonly WalkForwardFoldMetrics[]): WalkForwardAggregate`

For each metric name present in **every** fold (omit-safe intersection — a metric missing from any
fold is not aggregated, mirroring comparison-delta semantics), compute across folds: `mean`,
population `stddev`, `min`, `max`, and `positiveFraction` (fraction of folds with value `> 0`). All
`quantize`d. `foldCount = perFold.length`. Empty input → `{ foldCount: 0, metrics: {} }` (not an
error — "no folds" is valid data, distinct from a malformed split config).

## Determinism / invariant

Both functions are pure; aggregates `quantize`d; population stddev. E3a executes no backtest and
adds no request/result field, so `result_hash` and every golden are byte-identical (nothing calls
these functions on the run path yet).

## Testing (TDD)

**split:** produces exactly `folds` folds; test windows tile `[boundary(1), toMs]` contiguously;
`expanding` train always starts at `from`; `rolling` train is the single preceding segment;
integer-ms boundaries are exact; fail-fast on `folds<1`, non-integer `folds`, `to≤from`, invalid
dates. **aggregate:** mean/population-stddev/min/max/positiveFraction on hand-computed numbers;
metric present in only some folds is omitted; empty input → `{foldCount:0, metrics:{}}`; single fold
→ stddev 0.

## Out of scope (restated)

E3b server-side per-fold execution + `walkForward` request/result wiring; purge/embargo + CPCV +
PBO; train-window parameter fitting.
