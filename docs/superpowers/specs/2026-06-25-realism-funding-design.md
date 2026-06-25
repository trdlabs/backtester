# Realism — funding cost model + realistic-replay GAP report

**Date:** 2026-06-25
**Branch:** `feat/realism-funding` (from `main`)
**Status:** design approved, spec under review
**Predecessor:** sub#1 execution/PnL validation (`2026-06-24-execution-validation-design.md`, PR #51 merged). This is **sub#2-adjacent realism work** — the "anchor the engine to reality" follow-up.

## Problem

The backtester engine charges **fee + slippage** at each fill, but **never charges funding** while a perpetual position is held — even though the funding data is fully present in the tape (030: as-of live-forward funding column with coverage/stale-grace, exposed via `fundingAsOf`/`fundingWindow`). For perp longs held across funding windows, funding is a real cost-of-carry that is currently invisible. Backtest equity is therefore optimistic by an unquantified amount.

We want an **honest, opt-in realism convention** (next_bar_open fill + fee + adverse slippage + funding) and a **GAP report** that decomposes, per recorded trade, how much each cost component eats — establishing the convention that will later be ported to the paper engine.

## Goals

1. Add a **funding cost model** to the engine: while a position is open, accrue funding each bar from the tape's funding column, deducted from cash so equity is honest. **Opt-in** via a new optional `ExecutionProfile.fundingModel` field.
2. Provide a **realistic-replay GAP report**: replay the snapshot's recorded trades under a `REALISM_EXEC` profile and decompose per-trade cost drag (baseline / fee / slippage / funding) in pct/bps.
3. Keep the **default path byte-identical** — goldens, metrics, and existing demos must not move. The realism convention is opt-in this slice; flipping the default is a separate later task.

## Non-goals (explicit)

- **USD / sizing / portfolio-level metrics** (Sharpe-in-USD, max-drawdown-in-dollars, Kelly). The GAP report is **execution-layer only** (pnlPct / bps, leverage-invariant). USD is sub#2/portfolio territory.
- **Hybrid intrabar slippage** (buy→high, sell→low). Fixed-bps adverse slippage already exists and is the right first level for market orders; hybrid only adds realism for limit-order strategies (not in scope).
- **Changing the engine default** to the realism profile. Deferred to a separate task after the convention is validated.
- **Any change to trading-platform / the paper engine.** Cross-repo. (And: `043-exec-trust-model` is merged to `trading-platform` main as squash `6d9e05d` / #20 with active work ongoing — any future change there is via **worktree + speckit + gortex**, not from here.)
- **`computeBarFunding` helper** is an internal detail of the runner ↔ funding.ts integration; it is not a separate public API and need not be tested in isolation (covered by the step 5b integration test).

## Key data findings (drove the model decisions)

- **`funding_rate` is the 8h-equivalent rate, live-forward, sampled per minute.** SDK canonical-row doc: *"Aggregated funding (8h-equivalent), live-forward."* Inspection of the snapshot (BEATUSDT, 1368/1368 minutes `has_funding`) shows a **distinct value every minute** (~−0.00017…−0.00042), i.e. a continuously-floating 8h-equivalent quote, **not** an 8h rate held constant between change-points.
  - **Consequence:** per-minute proration (dividing the 8h rate by the interval) is mandatory, and a per-minute integral over the held window uses every sample — more faithful to this noisy live mark than a single boundary point-sample.
- **No `mark_price` column** exists in canonical-row (fields: `open/high/low/close/volume/turnover/oi_total_usd/funding_rate/liq_*/taker_*`). Notional uses `close` as the mark; a seam is left for a future mark column.
- **Recorded trades in the reference snapshot** (`../trading-mock-platform/data/snapshots/fixtures/2026-06-18-real-all/ops/bundle.json`, `tradesByRun`): **22 trades, all `long`** (long_oi_strategy). Close reasons: tp2=11, time_exit=5, hard_stop=4, run_terminated=2. **There are no short trades** → the short sign-pin test is synthetic.

## Approach (chosen: A — engine-integrated accrual + shared calculator + replay report)

Funding is charged in the real engine loop (opt-in via profile); the same pure calculator is reused by the replay report (DRY). The convention lives in the engine, so the future default-flip is trivial. Rejected: **B (report-only)** — would make "opt-in realism profile" a lie (no honest engine equity) and still need the engine work later; **C (portfolio USD)** — violates the chosen execution/portfolio layer separation.

## Architecture

```
profiles.ts
  + FundingModel types: PerMinuteProrateFundingModel { kind:'per_minute_prorate', intervalHours:8 }
  + SUPPORTED_FUNDING_MODEL_KINDS = ['per_minute_prorate']   // closed catalog, like SUPPORTED_FILL_MODEL_KINDS
  + ExecutionProfile.fundingModel?   // OPTIONAL — absent on DEFAULT_EXEC → default path unchanged
  + REALISM_EXEC: ExecutionProfile   // next_bar_open + fee bps + slippage bps + per_minute_prorate

funding.ts (NEW — pure math, no I/O; single source of truth for engine AND report)
  computeFundingPaidFraction(fundingRates8h, covered, side, intervalHours): Decimal
    // CONTRACT: fundingRates8h are 8h-EQUIVALENT rates (NOT pre-prorated). Division by
    // (intervalHours*60) happens EXACTLY here, nowhere else. Convention assert:
    // funding_rate > 0  ⟹  long pays short (guards against exchanges that invert the API sign).
    perMinute(rate, cov) = cov ? rate / (intervalHours*60) : 0
    raw = Σ_min perMinute(rate_min, covered_min)
    return sign(side) * raw          // sign(long)=+1, sign(short)=−1; positive = PAID (a cost)

execution.ts / ExecutionSimulator
  + fundingEnabled(): boolean        // ⟺ profile.fundingModel !== undefined
  + exposes fundingModel; unknown kind → fail-fast guard (mirror of the fill-kind guard)
  // fill-price math UNCHANGED

Portfolio
  + chargeFunding(cost: Decimal): void   // cost>0 → cash down (outflow); cost<0 → cash up (credit)
  // equityAt(price) formula UNCHANGED (cash + position MTM); funding shows up via cash

runner.ts  (settle-loop, between same_bar_close-settle and the equity-push)
  // AS BUILT: funding reading comes from the shared `fundingReadingAt(fundingCol, gridTs, bar.ts, t)`
  // classifier (extracted to market-tape.ts, reused by market-access — single source of grace logic).
  // present|stale → charge with the reading's rate; missing → charge 0. (Spec "Coverage" honored: stale
  // within grace IS charged, using the last real snapshot strictly from the past → no look-ahead.)
  if (exec.fundingEnabled() && portfolio.position !== null) {
    const reading = fundingReadingAt(fundingCol, gridTs, bar.ts, t);      // present|stale|missing, no look-ahead
    const covered = reading.state !== 'missing';
    const rate = covered ? reading.point.fundingRate : 0;
    const cost = computeBarFunding({ side, size, mark: bar.close, rate8h: rate, covered, barMinutes: gridMinutes, intervalHours: exec.fundingIntervalHours() }).toNumber();
    portfolio.chargeFunding(cost);                                        // reflected in equityAt(close)
    acc.fundingLedger.push({ barIndex: t, ts: bar.ts, rate, covered, cost });   // append-only, for report/audit
  }
  acc.equityCurve.push({ ..., equity: portfolio.equityAt(bar.close) });   // already includes bar-t funding

test/helpers-replay.ts  (extend sub#1)
  + per-trade decomposition: baseline_pnlPct / fee_drag / slippage_drag / funding_drag / funding_coverage_pct
scripts/realism-gap-report.mts (NEW)
  + replay recorded trades under REALISM_EXEC → GAP report (bps), per-trade + aggregate; deterministic artifact
test/realism-gap.test.ts (CI)
  + the 4 assertions below
```

## Funding model (formula, sign, notional, coverage)

- **Input semantics:** `fundingRates8h` = the 8h-equivalent rate as-of each held minute (from the 030 funding column). Named explicitly to prevent double-division; the rate is divided by `intervalHours*60` exactly once, inside `funding.ts`.
- **Sign:** `funding_rate > 0` ⟹ longs pay shorts. `computeFundingPaidFraction` returns `sign(side) * Σ(rate/intervalMin)`; positive = paid (cost). For BEATUSDT (rates < 0) a **long receives** funding (negative paid = credit). In the decomposition, `funding_drag_pct = −paidFraction` (paying lowers return; receiving raises it). A runtime/contract **assert pins this convention.**
- **Notional / mark:** `mark = close(t)`. Engine accrual is exact per bar: `funding_bar = size · close(t) · rate_asOf(t) · barMinutes/(intervalHours*60) · sign`. The replay report computes the same integral from per-bar `close`.
- **Coverage (stale/missing):** read `FundingReading` from the 030 column. `present`/`stale` (within grace) → use the rate; `missing` → charge 0 **and** increment an uncovered-minute counter → report exposes `funding_coverage_pct` per trade (so a funding_drag understated by data holes is visible). No look-ahead: stale returns the last real snapshot strictly from the past (a 030 guarantee).
- **Seam:** `intervalHours` lives in the model (not hardcoded 8); `fundingModel.kind` is a closed catalog so an `at_8h_boundary` variant can be added by value later (for paper-anchoring), exactly like the fill-model catalog.

## Engine accrual placement & invariants

- **Where:** `runner.ts`, end-of-bar — after the `same_bar_close` settle (line 451), before the equity push (line 454). At that point the bar's position state is final, so `equityAt(close)` includes the same bar's funding with no lag.
- **Boundary correctness under `next_bar_open` (the realism profile):**
  - **Entry:** pending(t) settles at `open(t+1)` → position open the whole bar t+1 → at `close(t+1)` `position!==null` → **full-bar funding** (held the whole bar). ✓
  - **Exit:** pending(t) settles at `open(t_exit)` → at `close(t_exit)` `position===null` → **0 funding** (held 0 minutes of that bar). ✓
  - "Full bar when position is open at close" is exact for next_bar_open. The `same_bar_close + funding` combo would mis-count the boundary bar → **not supported this slice** (documented; sub#1 paper validation does not use funding, no conflict).
- **`realizedPnl` separation:** funding is a **holding cost on the portfolio** (a cash flow), not an execution price. It hits `cash`/`equityAt` only; it is **NOT** folded into per-trade `realizedPnl`/`feePaid` (those stay execution-layer numbers). Funding is attributed on its own line in the GAP report. (Mirrors QuantConnect: price P&L in `Trade.ProfitLoss`, financing in `Portfolio.CashBook`.)
- **Default byte-identity (load-bearing):** the whole accrual block is gated on `exec.fundingEnabled()` (⟺ `fundingModel` present). `DEFAULT_EXEC` and sub#1 profiles carry no `fundingModel` → block never runs → `equityAt`, goldens, metrics unchanged. `fundingLedger` is append-only and empty on the default path.

## Replay GAP report & non-circular guards

The report reuses sub#1 `helpers-replay.ts` (recorded trades from `tradesByRun`), runs them under `REALISM_EXEC` through the engine, and takes numbers from **actual engine output**, not a re-derivation:

```
Per trade (bps):
  baseline_pnlPct      = close(entry)→close(exit), side-aware          // paper-independent, from rows
  fee_drag             = −(entry.feePaid + exit.feePaid) / notional·1e4 // from trade records
  slippage_drag        = −(fillPrice vs baseOpen) / baseOpen·1e4        // from Open/Close fills
  funding_drag         = −Σ(ledger.cost of trade) / notional·1e4        // from engine fundingLedger
  realistic_pnlPct     = equity-delta of the REALISM_EXEC run           // INDEPENDENT engine path
  GAP                  = realistic_pnlPct − baseline_pnlPct
  funding_coverage_pct = covered_minutes / held_minutes                 // funding-number reliability
Aggregate: mean GAP, decomposed mean (fee/slip/funding), total drag, coverage distribution, N trades
```

**DRY vs independence (the load-bearing point — avoids sub#1's pass-by-construction Critical):**
`funding.ts` is the **single production calculator**: the engine calls it per bar, and each `fundingLedger` entry *is* a `funding.ts` output — so `Σ ledger.cost` per trade equals the `funding.ts` integral (one product number, no second derivation). The **test guard recomputes the integral INLINE** — plain arithmetic in the test, **no import of `funding.ts`** (its own `Σ rate/480`, its own sign). A bug in `funding.ts` (divisor, sign, proration) makes the inline value diverge from the engine ledger. That is the genuine non-circular check (analogous to sub#1 Assertion A being paper-independent). The report itself never re-derives funding — it consumes the engine ledger.

**CI test (`test/realism-gap.test.ts`):**
1. **Non-circular funding guard:** engine `fundingLedger` from a real replay-strategy run under `REALISM_EXEC` vs **inline integral** → `|Δ| < 1e-10` (Decimal precision, not float `toEqual` — keeps long positions honest).
2. **Identity:** `realistic_pnlPct == baseline + fee_drag + slippage_drag + funding_drag`, Decimal-exact, where **`realistic_pnlPct` is taken from the engine `equityCurve`** (independent of the RHS decomposition) — so the identity confirms the settle-loop conserves value, not pass-by-construction.
3. **Sign-pin:** BEATUSDT long (rates < 0) → `funding_drag > 0` (credit); a **synthetic short** (no short in the data) → `funding_drag < 0`. Pins the sign convention against rate-convention changes on other exchanges.
4. **Cost-direction:** `fee_drag ≤ 0` and `slippage_drag ≤ 0` always (costs cannot improve return — a broken sign trips this).

**Output format:** deterministic (like `scripts/validate-execution.mts`) — JSON + human table; no timestamps/random in the artifact (repo canonical-JSON rule).

## Deterministic regression anchor (test 5b)

Concrete, committed expectations so the realism integration test is a true regression guard, not a vague behavior check:

- **Symbol/snapshot:** `BEATUSDT`, fixture `2026-06-18-real-all`.
- **Trade:** the `time_exit` long — `openedAtMs=1781767380000`, `closedAtMs=1781778240000` (~3.02h hold, ~181 held minutes). Longest BEATUSDT hold → meaningful funding.
- **Expected:** funding rates negative over the window ⟹ long → **funding credit** ⟹ `funding_drag > 0` ⟹ cash-delta from funding is **positive**. The test pins the sign and order of magnitude. **As built:** the observed credit is ≈ **2.389 bps** of notional; the shipped test pins the band `creditBps ∈ [1.8, 3.0]` (both sides bounded → catches sign inversion, zero-funding, and ~10× drift).

## Test strategy & build order (TDD, bottom-up; each step red→green before the next)

1. **`funding.ts`** + unit tests: proration, sign long/short, coverage mask (missing→0), `intervalHours`, convention assert. Isolated, no engine, runs in ms.
2. **`profiles.ts`**: `FundingModel` types, `SUPPORTED_FUNDING_MODEL_KINDS`, optional `fundingModel`, `REALISM_EXEC`. Unit: unknown-kind reject, `REALISM_EXEC` shape.
3. **`execution.ts`**: `fundingEnabled()` + `fundingModel` passthrough; unknown-kind fail-fast guard. Unit.
4. **`Portfolio.chargeFunding`**: cash mutation; `equityAt` reflects. Unit: cost>0→cash↓, cost<0→cash↑, equity delta.
5. **`runner.ts`** accrual (line 451→454) + `fundingLedger` in `RunAccumulators`. Integration, in order:
   - **(a) Golden-invariance FIRST** — run existing goldens/demos, assert **byte-identity** (no `fundingModel` → block skipped). The load-bearing safety gate.
   - (b) Realism path: position under `REALISM_EXEC` → `fundingLedger` non-empty, equity charged, BEATUSDT time_exit long → positive cash-delta (the 5b anchor above).
6. **`helpers-replay.ts`** decomposition + **`scripts/realism-gap-report.mts`** + **`test/realism-gap.test.ts`** (the 4 assertions).
7. **Final:** full suite + goldens intact + lint/typecheck + GAP report over the snapshot (demo artifact).

**Test pyramid:** unit (steps 1–4, isolated, fast) → integration (step 5, engine) → e2e-report (step 6, real snapshot). No Docker/sandbox dependency (not the sandbox path) → CI-friendly, no WSL2 skips.

**Process:** superpowers TDD (red→green→refactor) per step. This repo uses superpowers (brainstorm→spec→plan), not speckit (speckit is the trading-platform convention).
