# Execution/PnL validation via trade-replay (sub#1) — Design

**Date:** 2026-06-24
**Status:** Approved (brainstorming), pending spec review
**Branch:** `feat/execution-validation`
**Base:** `main` @ `43795f2`

## Problem

Before trusting hypothesis-vs-baseline deltas from the backtester, we must know the
**baseline is computed correctly** — i.e. the backtester's execution + PnL math
reproduces a reference engine on real trades. We have a reference: the platform's
**paper** run of `long_oi_strategy` (sibling repo `trading-mock-platform`), with the
real trade list AND the minute-level market data baked into a committed slice.

This is sub#1 of two: **sub#1 (this)** validates the EXECUTION/PnL engine by replaying
the bot's real entry/exit timeline on the same bars and matching per-trade `pnlPct`.
**sub#2 (later)** ports `long_oi_strategy` itself as a module and checks the backtester
reproduces the same DECISIONS (cross-checked against sub#1 so the port doesn't drift).

## Key facts (grounded, 2026-06-24)

- **Reference data:** `trading-mock-platform/data/snapshots/fixtures/2026-06-18-real-all/ops/bundle.json`
  (commit 876151c, "real loss-day demo slice, taker + funding"). It carries
  `historical.rowsBySymbol[symbol]` = **per-minute CanonicalRowV2** rows
  (`minute_ts` step 60_000 ms; fields open/high/low/close/volume/turnover/oi_total_usd/
  `funding_rate`/liq_long_usd/liq_short_usd/has_*), 11 symbols, ~1 day (2026-06-18).
  `tradesByRun[runId]` = the paper trades: `{tradeId, symbol, side:'long', openedAtMs,
  closedAtMs, realizedPnl, pnlPct, isWin, closeReason}` — **no fill prices, no fee, no
  qty.** (The 1h/1d `barsBySymbolAndTimeframe` are too coarse and are NOT used.)
- **Paper engine convention (derived empirically by reconciling trades vs the 1m rows):**
  fills at the **1m `close`** of the entry/exit minute, **no fee, no funding, no
  slippage** — confirmed by EXACT matches on clean closes (e.g. BEATUSDT `pnlPct=5.411`
  == `(exitClose-entryClose)/entryClose=5.411`; `3.343`==`3.343`). For these, paper
  `pnlPct = (exitClose − entryClose)/entryClose × 100`.
- **TP/SL/BE/hard_stop closes fill at the TRIGGER price** (intra-minute), NOT the bar
  close — so they do NOT reconcile to close→close and CANNOT be reproduced without the
  strategy's trigger levels → deferred to sub#2 (+ a future `same_bar_trigger` fill mode).
  Only `time_exit` (and other clean, no-trigger closes) fill at the bar close.
- **Engine fill model today:** `ExecutionProfile.fillModel.kind` ∈ `{ 'next_bar_open' }`
  only (`profiles.ts` `SUPPORTED_FILL_MODEL_KINDS`). The runner places a pending at the
  decision bar t and `settlePending` fills it at bar **t+1**'s `open` (`runner.ts`).
  `ExecutionSimulator.compute{Open,Close}Fill` are **price-agnostic** — they apply
  slippage/fee to whatever base price the runner passes. fee/slippage are fixed-bps and
  configurable (default 10/5 bps; set to 0 to disable).
- **Funding is NOT charged** to PnL by the engine (it's exposed as market data only).
  Since the paper engine also ignores funding, the backtester (no funding) MATCHES here.

## Approach

Add a **`same_bar_close`** fill model (decision at bar t fills at `close(t)`), replay the
paper trades' real entry/exit timeline through the engine on the 1m rows with fees +
slippage set to 0, and assert the backtester's per-trade `pnlPct` matches the paper
`pnlPct` for the clean-close (`time_exit`) trades. Trigger-close (TP/SL/...) trades are
explicitly excluded and logged, not silently dropped.

## Design

### 1. `same_bar_close` fill model (engine)

- Add `'same_bar_close'` to `SUPPORTED_FILL_MODEL_KINDS` (`profiles.ts`) and accept it in
  `ExecutionSimulator` (no new fill math — it reuses `compute{Open,Close}Fill`).
- Runner change (`runner.ts` `runSymbol`/`settlePending`): under `same_bar_close`, a
  decision made in `onBarClose(t)` settles **within the same bar t** using **`close(t)`**
  as the fill base, instead of deferring a pending to bar t+1's `open`. No look-ahead —
  `close(t)` is known at `onBarClose(t)` (it is the bar's close that drove the decision).
- `next_bar_open` behavior, the default `DEFAULT_EXEC`/`UNSUPPORTED_FILL_EXEC` profiles,
  and ALL goldens are unchanged (the new kind is opt-in via the executionProfile).
- A future `same_bar_trigger` (fill at a strategy-supplied trigger price, for TP/SL) is
  NOT built here — only noted as the sub#2 follow-up.

### 2. Data ingestion (1m rows → tape)

Load `rowsBySymbol[symbol]` (CanonicalRowV2) from the slice into a `MarketTapeDataset`
per symbol — these rows are the exact canonical-row shape the engine already consumes;
build the tape directly from them via an in-memory rows source (no Docker stack, no
HTTP). The slice path is an input to the harness (default the committed mock-platform
fixture path; overridable by env).

### 3. Trade-replay driver

A trusted in-process **replay strategy module**: given a per-symbol list of the paper
trades, its `onBarClose(ctx)` emits `enter(long)` on the bar whose minute == `openedAtMs`
and `exit` on the bar whose minute == `closedAtMs` (idle otherwise). Run through
`runBacktest` with `executionProfile = { fillModel: same_bar_close, feeModel: 0bps,
slippageModel: 0bps }`. This drives the engine's settle/portfolio along the real trade
timeline; each replayed trade yields backtester entry/exit fills.

### 4. Comparison + success metric

Inclusion rule (explicit): a paper trade is **in-scope** iff `closeReason === 'time_exit'`
(the only observed non-trigger close — fills at the bar close) AND both `openedAtMs` and
`closedAtMs` fall within the symbol's 1m row coverage. Every other `closeReason`
(`tp*`/`*_stop`/`be_stop`/`hard_stop`/…) is a trigger close → excluded. For each in-scope
trade: compute backtester `pnlPct = (exitFill − entryFill)/entryFill × 100` and compare to
the paper `pnlPct`. **Success = every such trade matches
within a tight tolerance** (e.g. `|Δ| ≤ 1e-6` relative, effectively exact, since both are
pure close-to-close with no costs). The harness prints a report: per-trade (symbol,
entry/exit minute, paper pnlPct, backtest pnlPct, Δ, match), an aggregate (N matched / N
in-scope), and an explicit **EXCLUDED list** (trigger-close + out-of-coverage trades, with
the reason) so coverage is never silently truncated.

### 5. Scope / exclusions (YAGNI)

- **TP/SL/BE/hard_stop trades** — excluded + logged; reproduced in sub#2 (needs the
  strategy's trigger levels + a `same_bar_trigger` fill mode).
- **`realizedPnl` in USD / position sizing** — not validated here (the trade log has no
  qty; USD PnL needs the risk-profile sizing). sub#1 validates **`pnlPct`** (price PnL,
  sizing-independent). Deferred to sub#2.
- **Funding cost model** — NOT built (paper ignores funding; backtester matches). Only
  needed if a future reference includes funding.
- **`long_oi_strategy` logic port** — sub#2.

## Testing

- **`same_bar_close` unit (engine):** a decision at bar t fills at `close(t)`; a held
  enter→exit over the 1m series yields `pnlPct = (exitClose − entryClose)/entryClose`;
  no look-ahead (the fill never uses a future bar); `next_bar_open` path and the frozen
  goldens (momentum `sha256:eff10116…`, overlay goldens) are byte-unchanged.
- **Replay reconciliation:** on a small committed fixture (a few clean-close trades + their
  1m rows, trimmed from the slice), every in-scope `time_exit` trade's backtester `pnlPct`
  matches the paper `pnlPct` within tolerance; excluded trades are reported. This is the
  CI-runnable regression (no external repo dependency).
- **Full-slice harness (manual/data-gated):** run the replay over the whole
  `2026-06-18-real-all` slice and print the coverage report; not a CI assertion (depends on
  the sibling fixture path).
- Full suite + typecheck green; goldens unmoved.

## Non-goals

Out: TP/SL trigger reproduction, USD/realizedPnl & sizing validation, funding cost model,
the `long_oi_strategy` port (sub#2), live/real-money reference (the reference is paper),
multi-run/aggregate equity-curve comparison, the 1h/1d bars.
