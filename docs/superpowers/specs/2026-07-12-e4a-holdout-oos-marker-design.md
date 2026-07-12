# E4a — Held-out OOS qualification marker (advisory) design

Date: 2026-07-12. Phase E, ROADMAP item 23 (first slice). Predecessors: `docs/FEATURE-PARITY.md`
(§4 E4), E2 (#104/#105), E3a (#106/#107). **Naming:** code uses `holdout`/`qualification`, NOT
"E4" — the worker already labels the curated-baseline signed-evidence block `// ── E4 ──`; that is a
different feature.

## Goal

Declare a server-side held-out OOS window and mark every run that touches it — the structural,
un-evadable signal behind "qualification against a reserved window the LLM loop cannot iterate
against" and the defense against period-shopping (which E2's family-N does NOT catch, since a
different period is a different family). **Advisory-first + dark-launched**: detect + mark only; no
blocking, `decideVerdict` untouched, `BACKTESTER_HOLDOUT_ENABLED` default OFF, `result_hash`
byte-identical. Enforcement (reject/budget the 2nd attempt) is the gate-flip follow-up.

## Decisions (from brainstorming)

- **Window = last `fraction` of the dataset's coverage span** (per-dataset, adaptive). The window
  moves as coverage grows — accepted for an advisory marker; the marker carries provenance so a
  drift is auditable. (Explicit-date and per-symbol windows are follow-ups.)
- **Classification = structural period overlap** (half-open intervals) — every touch counts,
  regardless of intent, so lab cannot iterate the holdout under the guise of development.
- **Non-invasive:** a run against the holdout is just a normal run whose `period` overlaps the
  reserved window — no tape/period slicing (unlike E3b). Detection + marking happen at finalize.

## Components

### 1. Pure module — `src/engine/holdout.ts` (deterministic)

- `computeHoldoutWindow(coverage: RunPeriod, fraction: number): RunPeriod` — `window =
  [coverageTo − round(fraction·span), coverageTo]` (integer ms). **Fail-fast `HoldoutConfigError`**
  on `fraction ∉ (0,1)` or unparseable / `from ≥ to` coverage bounds (no silent clamp).
- `holdoutOverlap(runPeriod: RunPeriod, holdout: RunPeriod): { overlaps: boolean; containment:
  'none' | 'partial' | 'full' }` — **half-open `[from, to)`**: `overlaps = rFrom < hTo && hFrom <
  rTo` (a boundary touch is NOT overlap). `containment`: `'none'` when not overlapping; **`'full'`
  when the run is entirely inside the holdout** (`hFrom ≤ rFrom && rTo ≤ hTo`) — NOTE this means
  "run ⊆ holdout", NOT "run covered the whole holdout"; a 1-hour run inside a 2-day holdout is
  `full` yet says nothing about statistical sufficiency (trade-level power is E1b/E3b); else
  `'partial'`.
- `buildHoldoutMarker(coverage: RunPeriod, fraction: number, runPeriod: RunPeriod):
  HoldoutResolved` — composes the two into the provenance-bearing resolved marker.

### 2. Contract (SDK, additive, NON-hashed)

```ts
export interface HoldoutResolved {
  readonly status: 'resolved';
  readonly policy: 'coverage_fraction';
  readonly fraction: number;
  readonly coverage: RunPeriod;   // the coverage span the window was carved from (provenance)
  readonly window: RunPeriod;     // the reserved holdout window
  readonly overlaps: boolean;
  readonly containment: 'none' | 'partial' | 'full';
}
export interface HoldoutUnknown { readonly status: 'unknown'; readonly reason: 'coverage_not_found'; }
export type HoldoutMarker = HoldoutResolved | HoldoutUnknown;
// RunResultSummary += holdout?: HoldoutMarker  (absent when the flag is OFF)
```

Provenance (`policy`, `fraction`, `coverage`) is mandatory precisely because the window drifts with
coverage — a bare `window` would be un-auditable a month later.

### 3. Config (dark-launch triple, default OFF)

`BACKTESTER_HOLDOUT_ENABLED` (bool) + `BACKTESTER_HOLDOUT_FRACTION` (number). **Fail-fast** in
`loadConfig` when enabled and `fraction` is not a finite number in `(0,1)` — no silent clamp (a bad
env must surface, not be masked).

### 4. Wiring — worker finalize (overlay/strategy, flag-gated)

After `finalizeResult` (resultHash fixed), when holdout enabled:
- Look up the coverage descriptor for `claimed.datasetRef` via `deps.dataPort.listDatasets()`
  (`DatasetDescriptor.period` = coverage span).
- **coverage found** → `buildHoldoutMarker(coverage, fraction, claimed.request.period)` → attach the
  resolved marker.
- **coverage NOT found** → attach `{ status: 'unknown', reason: 'coverage_not_found' }` (so a
  consumer distinguishes "feature off" from "coverage missing" — NOT a silent omit).
- Marker rides the `RunResultSummary` projection only (after `contentRef(payload)`, never in it).

Flag OFF ⇒ no `holdout` field ⇒ byte-identical `result_hash` and response. Momentum path: same
finalize seam applies; if it lacks a clean period/coverage pairing it is simply not marked (fail-open).

### 5. Advisory / invariant

`decideVerdict` unchanged; no admission effect. The qualification-attempt NUMBER is already E2's
`trialContext.trialCount` (holdout runs of one family share the fixed holdout period ⇒ one E2
family) — E4 does not recount; a consumer reads `holdout` + `trialContext` together. `holdout` is
non-hashed (depends on server config + coverage, not run inputs), so goldens are byte-identical.

## Testing (TDD)

**computeHoldoutWindow:** last-`fraction` window with exact integer-ms bounds; `to` equals coverage
`to`; fail-fast on `fraction` 0 / 1 / <0 / >1 / NaN and on bad coverage dates. **holdoutOverlap
(half-open):** run fully inside ⇒ `{overlaps:true, containment:'full'}`; run straddling the start ⇒
`partial`; run entirely before / after ⇒ `none`; **boundary touch (`rTo === hFrom`) ⇒ NOT overlap**;
run wider than holdout ⇒ `partial`. **buildHoldoutMarker:** provenance fields populated
(`policy`/`fraction`/`coverage`/`window`). **wiring:** flag OFF ⇒ no `holdout` + golden `result_hash`
unchanged; flag ON + coverage ⇒ resolved marker; flag ON + no coverage ⇒ `{status:'unknown'}`.

## Out of scope

Enforcement (reject/budget a 2nd qualification attempt) — gate-flip follow-up; qualification window
into the signed `backtest-evidence/v1` body (cross-repo); explicit `mode:'promotion'` semantics;
explicit-date and per-symbol holdout policies; trade-level power / `insufficient_evidence` (E1b/E3b).
