# FOLLOW-UP: long_oi full faithfulness chain — old-bot golden ≡ backtest(bundle) ≡ paper(bundle)

**Date:** 2026-07-05
**Status:** FOLLOW-UP STUB (not yet brainstormed into a full spec — a future session runs superpowers:brainstorming on this)
**Parent:** `2026-07-05-long-oi-signal-parity-design.md` (G7 Stage 1). Stage 1 proved long_oi RUNS faithfully on real 1m data (tradeCount=0 closed) but could NOT reproduce the golden exactly — see "Why Stage 1 could not close it" below.

## Goal (the full chain the user described)

Prove the three-way faithfulness chain on REAL data:

```
old-code-bot golden (VPS trade history)  ≡  backtest(strategy BUNDLE)  ≡  platform paper(strategy BUNDLE)
```

Until ~2026-07-04 an OLD long_oi bot ran on the VPS **as code inside the platform** (not yet a `kind:'strategy'` bundle) and wrote a real **trade history**. Take a VPS slice of that history + trades, run the strategy **bundle** through both (a) the backtester and (b) the platform's paper host, and confirm all three converge (signals exact + metrics in tolerance, per Stage 1's acceptance definition).

**Period (user):** **2026-07-01 .. 2026-07-03** (3 real days).

## Why Stage 1 could not close it (verified findings — the concrete blockers this follow-up must fix)

1. **Live params/decisions are SANITIZED OUT of the committed fixture.** In `trading-mock-platform/data/snapshots/fixtures/2026-06-18-real-all/ops/bundle.json`: `analysisByRun.<runId>.strategyConfig = {available:false, reason:'not_in_sanitized_export'}` and `decisionsByRun.<runId>` is empty; `runs[].strategy.version = 'unknown'`. So the vendored module runs `DEFAULT_PARAMS` ≠ the live bot's actual config → different TP/SL decisions. Evidence it is params/decisions and NOT a timing convention: **close-reason FLIPS** across the 8 trades (golden `tp2` → backtest `hard_stop`; golden `stop_loss` → backtest `tp2`) — a timestamp offset cannot turn a take-profit into a stop-loss.
2. **Trade-record granularity differs: leg vs position.** The vendored module's `tp1Action:'partial_exit'` (`tp1ExitPercent:50`) emits TWO closed-trade records per position (the TP1 partial + the remainder), while the old-bot golden ledger records ONE trade per position. So the Stage-1 trade-vs-trade comparison is structurally mismatched; comparing at the **decision/signal level** (enter/exit decisions per bar) sidesteps this.
3. **The golden day (06-18) actually had no committed live config** — even the 1-day срез cannot reconstruct the golden. (NOTE: the 06-12 `startedAtMs` was only when the paper process launched; the comparison DAY was the same 06-18 — this was NOT a period/warmup problem. long_oi's warmup is only `candlesMin:30`.)

## What this follow-up needs (the three deliverables)

### A. Un-sanitized VPS slice (the data)
Fetch a 2026-07-01..07-03 slice from the VPS that INCLUDES what the sanitizer currently strips:
- `historical.rowsBySymbol` — real 1-minute CanonicalRowV2 (OHLC + oi/funding/liq/taker) for the traded symbols.
- `tradesByRun` — the old bot's real trade history (the golden outcomes).
- **`analysisByRun.<run>.strategyConfig`** — the live module's actual params (currently `not_in_sanitized_export`).
- **`decisionsByRun.<run>`** — the per-bar enter/exit/annotate decisions the live module emitted (the signal-level golden; currently empty).
Requires either (i) a mock-platform export/sanitizer change to include config + decisions for this trusted internal use, or (ii) a raw VPS fetch bypassing the public sanitizer. Reuse `trading-mock-platform/tools/fetch-snapshot`.

### B. Compare at the DECISION (signal) level, not trade-record level
Golden = `decisionsByRun` enter/exit decisions. Feed the fetched `strategyConfig` params to the vendored `LONG_OI_MODULE` via `ctx.params` (the code is byte-identical; only params were missing), run through `runBacktest` (Stage-1 `runLongOiOnRows`, generalized to accept params), and compare the module's emitted decisions to the golden decisions bar-for-bar. This isolates strategy faithfulness from execution/fill and from the tp1 leg-vs-position artifact.

### C. Add the platform-paper leg (the third arm)
Run the SAME bundle through the platform's paper host on the same slice (the 058 market-replay-streamer path in trading-platform — currently Draft) and assert paper(bundle) ≡ backtest(bundle) ≡ golden.

## Reusable from Stage 1 (already built + reviewed on branch feat/long-oi-signal-parity)
- `apps/backtester/test/long-oi-parity/run-long-oi.ts` — runs LONG_OI_MODULE through runBacktest (generalize: accept `params`).
- `.../match-trades.ts`, `.../normalize-close-reason.ts`, `.../golden-types.ts`, `.../scorable filter` — comparison infra (extend to decision-level).
- `apps/backtester/test/fixtures/strategies/long_oi/*` — vendored module + drift guard.
- `apps/backtester/scripts/extract-signal-parity-fixture.mts` — fixture extractor (extend to pull config + decisions; also fix the stale `trading-mock-platform`→`mock-platform` SLICE_PATH default, shared with `extract-validation-fixture.mts`).

## Dependencies / gates
- VPS access for the 07-01..07-03 fetch.
- mock-platform export change to surface `strategyConfig` + `decisionsByRun` (or raw fetch).
- platform 058 market-replay-streamer (Draft) for the paper arm.
