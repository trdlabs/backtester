# Paper↔backtest trade-reconciliation harness (sub#2 scaffolding) — design

**Date:** 2026-06-26
**Branch:** `feat/trade-reconcile` (from `main`)
**Status:** design approved, spec under review
**Predecessor:** sub#1 execution/PnL validation (#51). This is the **strategy-agnostic measuring stick** for sub#2.

## Problem / context

We want to validate that the **backtester reproduces the platform paper engine** — not just execution math (sub#1 proved that on recorded trades), but eventually the strategy DECISIONS too. The full sub#2 ("run the same strategy in both, compare trades") is **blocked**: the platform is mid-transition from *strategy-as-code-in-repo* to *strategy-as-artifact-in-storage* (weeks away). Once the strategy is a loadable artifact, the backtester can run **the same artifact** the bot uses — apples-to-apples, no hand-port, no drift. A hand-port done now would be throwaway (its source basis vanishes) and a weaker validation.

What is NOT blocked and never throwaway: the **comparison/scoring layer** that takes two trade lists (paper-recorded vs backtester-generated) and classifies them. It is strategy-agnostic and artifact-agnostic. Building it now de-risks sub#2 (when the artifact lands, the only new work is "load + run"), forces the subtle reconciliation semantics to be decided while context is fresh, and is immediately self-testable against sub#1's replay.

## Goal

A pure, deterministic **`reconcileTrades`** harness + report that pairs paper-recorded trades with backtester-produced trades and classifies each as matched / divergent (engine vs data) / paper-only / backtest-only / ambiguous, with a non-circular data-vs-engine classifier. It must run today against sub#1's replay and plug unchanged into an artifact-driven run later.

## Non-goals

- **No strategy port / artifact loading** — waits for the platform's strategy-as-artifact transition (the real sub#2 input).
- **No USD / `realizedPnl` reconciliation** — needs sizing/risk profile (snapshot redacts qty/fee); that is sub#2b. The harness compares **pnlPct** only.
- **No change to the engine, sub#1's `helpers-replay.ts`, or the realism work.** New files only.
- **No cross-repo (trading-platform) change.**

## Reference data

Snapshot `../trading-mock-platform/data/snapshots/fixtures/2026-06-18-real-all/ops/bundle.json`: `tradesByRun` = 22 recorded paper trades, each `{tradeId, runId, symbol, side, openedAtMs, closedAtMs, realizedPnl, pnlPct, isWin, closeReason}` (closeReasons: tp2=11, time_exit=5, hard_stop=4, run_terminated=2). `decisionsByRun` is **empty** (decisions/levels not captured — confirms a port can't be reconstructed from the snapshot). `runs[].strategy = {name:'long_oi_strategy'}`. Per-minute `CanonicalRowV2` rows per symbol (for the independent close-to-close classifier). sub#1 found LABUSDT/REUSDT data-divergent (snapshot bars ≠ paper's live fills).

## Match criterion (decided)

Trades are paired by key `${symbol}|${openedAtMs}|${side}`. A pair is **`matched`** iff: exit minute equal **and** `closeReason` equal **and** `|ΔpnlPct| ≤ pnlPctTol`. This is stricter than sub#1 (which compared pnlPct only) — it catches "exited at the wrong time" and "exited for the wrong reason", which is exactly what trigger trades (tp2/hard_stop) exercise.

## Architecture

### Taxonomy (per trade)
- **`matched`** — paired; exit-min == + closeReason == + `|ΔpnlPct| ≤ tol`.
- **`engine_divergent`** — paired but diverges (exit-min / closeReason / pnlPct), AND an independent close-to-close from the rows DOES reproduce paper's pnlPct within tol → the data is fine, the engine/strategy is not. **This is the real signal** (a port/engine bug, once a strategy generates trades).
- **`data_divergent`** — paired but diverges, AND the independent close-to-close does NOT reproduce paper (or rows are missing) → the input bars can't yield paper's number → not the engine's fault (the LABUSDT/REUSDT case). **Conservative default:** if canonical rows for the entry or exit minute are absent, the trade is `data_divergent`, NEVER `engine_divergent` — missing data is never charged as an engine bug (same principle as `funding missing → 0` in #52).
- **`paper_only`** — a paper trade with no backtester counterpart at its key (backtester did not open there).
- **`backtest_only`** — a backtester trade with no paper counterpart (an extra position).
- **`ambiguous`** — more than one trade on either side shares a key. With `maxConcurrentPositions=1` per symbol this is impossible in valid data, so the class is normally empty; a non-empty `ambiguous` is a corrupt-data signal, surfaced (never silently greedy-paired).

### Non-circularity anchor
The `data_` vs `engine_` split is decided by an **independent** close-to-close computed from `CanonicalRowV2` — NOT from the engine. This is sub#1's Assertion-A principle repurposed as a classifier, so the harness neither credits nor blames the engine for data issues, and cannot become pass-by-construction.

## Interfaces (`apps/backtester/test/helpers-reconcile.ts`, pure, no I/O)

```ts
type Side = 'long' | 'short';
type ReconcileStatus =
  | 'matched' | 'engine_divergent' | 'data_divergent'
  | 'paper_only' | 'backtest_only' | 'ambiguous';

interface NormalizedTrade {
  readonly symbol: string;
  readonly side: Side;
  readonly entryTs: number;
  readonly exitTs: number;
  readonly closeReason: string;
  readonly pnlPct: number;   // price return on notional, side-aware (see normalizer contract)
}

interface ReconcileRow {
  readonly key: string;                 // `${symbol}|${entryTs}|${side}`
  readonly status: ReconcileStatus;
  readonly paper?: NormalizedTrade;
  readonly backtest?: NormalizedTrade;
  readonly deltas?: { readonly exitTsMatch: boolean; readonly closeReasonMatch: boolean; readonly pnlPctDelta: number };
  readonly note?: string;               // e.g. "rows missing for exit minute"
}

interface ReconcileSummary {
  readonly total: number; readonly matched: number;
  readonly engineDivergent: number; readonly dataDivergent: number;
  readonly paperOnly: number; readonly backtestOnly: number; readonly ambiguous: number;
  readonly matchRate: number;           // matched / total
}

interface ReconcileResult { readonly rows: readonly ReconcileRow[]; readonly summary: ReconcileSummary }

function reconcileTrades(args: {
  paper: readonly NormalizedTrade[];
  backtest: readonly NormalizedTrade[];
  rows: Readonly<Record<string, readonly CanonicalRowV2[]>>;
  pnlPctTol?: number;                   // default 1e-3
}): ReconcileResult;
```

### Normalizer contracts (load-bearing)
- `paperToNormalized(t: PaperTrade): NormalizedTrade` — `entryTs=openedAtMs`, `exitTs=closedAtMs`, `pnlPct=Number(t.pnlPct)` (paper's recorded price-return).
- `engineTradeToNormalized(t, side): NormalizedTrade` — **`pnlPct` MUST be computed from `entry/exitFillPrice`, side-aware, the SAME way as sub#1** (`long: (exit−entry)/entry·100`, `short: (entry−exit)/entry·100`). It MUST NOT be derived from `trade.realizedPnl` (USD / leverage-dependent) — doing so would compare a different quantity against `pnlPctTol` and falsely trip `engine_divergent` on leveraged positions. This is a hard contract, asserted by a unit test.
- `closeToClosePnlPct(rows, entryTs, exitTs, side): number | undefined` — independent price return from the rows' closes at the two minutes, side-aware; `undefined` if a row for either minute is absent (floor-lookup tolerant, like sub#1).

## Report (`apps/backtester/scripts/reconcile-report.mts`)
Deterministic (rows sorted by `symbol` then `entryTs`; no timestamps/random — repo canonical-output rule). Per-trade table (key, status, exit/closeReason/pnlPct deltas, note) + an aggregate block (counts per class + `matchRate`). Built on `reconcileTrades` (consumes the engine ledger/trades, never re-derives).

## Testing

- **Real (`apps/backtester/test/reconcile.test.ts`):** run sub#1's replay (recorded trades through the engine under the paper convention `same_bar_close`, fee0/slip0), normalize both sides, `reconcileTrades` vs the 22 paper trades. Assertions: **`engineDivergent === 0`** (the engine reproduces paper where data permits); LABUSDT/REUSDT land in `data_divergent` (the known sub#1 finding); **`ambiguous === 0` asserted as a hard `assertEmpty`** (a non-empty class is a corrupt-data signal to catch immediately, not a number to notice later); `matched + dataDivergent === total` for the in-coverage set.
- **Synthetic (unit, same test file or a sibling):** replay always reproduces exactly paper's trades, so `paper_only` / `backtest_only` / `ambiguous` / the missing-rows→`data_divergent` paths are exercised with fabricated small `NormalizedTrade[]` lists + a rows map with a deliberate hole. Each taxonomy class gets at least one asserting test.
- **Normalizer-contract test:** a leveraged-style fabricated engine trade where `realizedPnl`-derived pct ≠ fillPrice-derived pct — assert the normalizer returns the fillPrice-derived value (guards the load-bearing contract above).

## Scope

A single focused plan: `helpers-reconcile.ts` (pure core + normalizers), `reconcile.test.ts` (real + synthetic + contract), `reconcile-report.mts` (artifact). No engine change, no decomposition. The harness's payoff is realized when the strategy artifact plugs in as the `backtest` input — at which point sub#2 proper is "load artifact → run → feed its trades to this harness."
