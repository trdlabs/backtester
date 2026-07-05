# Platform handoff — long_oi live adapter `ctx.market` (OI/liq) violates its own gap/window contract

**Date:** 2026-07-05
**Status:** HANDOFF (findings from G7 backtest↔golden divergence investigation; the fix is trading-platform's — this doc is the agreed record on the backtester side)
**Parent:** `2026-07-05-long-oi-signal-parity-design.md` + `-followup-vps.md`.

## Why this matters

We ran the **byte-identical** vendored `long_oi` module (identical `DEFAULT_PARAMS` — both verified) through the backtester on the real 1-minute срез the live bot traded, and compared to the bot's recorded golden trades. Only **2 of 8** trades reproduced cleanly; **6 of 8** fired on different bars (entry-price deltas of 11–24%). Params and trade-representation are ruled out (see the design/followup docs). The residual cause is that the module reads `ctx.market` (OI/liquidations) through **different context-builders** live vs backtest — and the LIVE builder deviates from the module's documented data contract, so the golden reflects that deviation. The backtester's `market-access.ts` implements the contract correctly. **Net: the backtester is contract-faithful; the live adapter is not — so "reproduce the golden exactly" is the wrong target until the live adapter is aligned.**

## Findings (file:line)

### #1 — gap handling: live fabricates `0`, contract says `undefined` (HIGHEST impact; a real bug)
- **Contract:** `platform/specs/026-long-oi-strategy-module/contracts/live-adapter.md:20` — "gap → `undefined` (carry-forward запрещён)".
- **Backtest (correct):** `trading-backtester/apps/backtester/src/engine/market-tape.ts` `indexByMinute()` only maps minutes with a real reading; `market-access.ts::pointInTimeMarketApi` (`oiAsOf`/`oiWindow`/`liqAsOf`/`liqWindow`, ~L115-124) returns literal `undefined` on a gap. The vendored `signals.ts::oiWindow3` then returns `null` for the whole window and long_oi's OI-recovery branch is correctly skipped (C1 degradation: no zero-substitution).
- **Live (bug):** `platform/src/runtime/module_host/module_strategy_adapter.ts::prepareBar` (~L233-234) appends UNCONDITIONALLY with `?? 0`: `oiBuf = [...oiBuf, { ts, oiTotalUsd: Number(oiPoint.value ?? 0) }]` (same for `liqBuf`). A data lapse (WS reconnect / source-TTL lapse / cold start) fabricates a literal OI/liq reading of **0** — a phantom OI collapse — which feeds `oiRecovery = pctChange(...)` and can flip enter/no-enter on exactly the gappy bars. **Self-inconsistent:** two lines below, `fundingBuf`/`takerBuf` are built correctly (`fundingIn ? {...} : undefined`). So oi/liq is a deviation from both the contract AND the file's own pattern.

### #2 — window indexing: live is call-sequence, backtest is calendar-grid (HIGH impact)
- **Backtest (correct):** `market-access.ts::windowMinutes` (~L43) builds `oiWindow(3)` from the candle-timestamp grid — exactly the 3 **calendar minutes** ending at T, gaps explicit.
- **Live:** `module_strategy_adapter.ts` `oiBuf`/`liqBuf` are plain arrays pushed once per `onMinuteMetrics` call and sliced `-3`. The window is indexed by **number of calls**, not calendar minute. On delayed/skipped bar delivery (the serial `queue.enqueue` in `bot_runner.ts::onTicker`, WS reconnects, backpressure), `oi3[0..2]` spans a different real-time interval than "T-2,T-1,T", while the vendored math (`pctChange`, `oiRecovery`) assumes fixed ~1-minute spacing.

### #3 — OI value construction: live async tick-carried aggregate vs backtest discrete per-minute (MEDIUM-HIGH; config- + provenance-dependent)
- **Live:** `platform/src/market/providers/remote_market_provider.ts::resolveMinuteMarketContext` (~L226-250). Default `USE_AGGREGATED_MARKET_DATA=true` (`platform/src/config/shared.ts:280`) → `oiValue = aggMinute.oiTotalUsd` from `MarketAggregator.getAggregatedOiPoint` (`market_aggregator.ts` ~L676-714): a **cross-exchange SUM** of per-exchange OI ticks within a TTL, each itself a bounded forward-carry. Continuous, async, tick-driven. (The `useAgg=false` path is a single-exchange last-ticker value, also async.)
- **Backtest:** a single discrete per-minute `oi_total_usd` scalar from the canonical row.
- Unlike #1/#2 (pure semantics, fixable by aligning the builder), #3's **magnitude** can differ, and whether it matters depends on (a) whether `USE_AGGREGATED_MARKET_DATA` was on for the golden run and (b) how the fixture's `rowsBySymbol.oi_total_usd` was captured (#5, below).

### #5 — fixture provenance (open; not resolvable from committed code)
The committed `2026-06-18-real-all` `rowsBySymbol.oi_total_usd`/`liq_*` were produced by a VPS-only collector not present in `trading-backtester` or `trading-platform` at HEAD (`fetch-snapshot.ts`'s `aggregateHistorical` doesn't emit `rowsBySymbol` for this fixture). Whether that collector snapshotted the SAME `MarketAggregator` minute output the live bot consumed (→ faithful) or something else is unknown here.

## Ask of trading-platform

1. **Fix #1:** in `module_strategy_adapter.ts::prepareBar`, build `oiBuf`/`liqBuf` gap-explicitly (`oiIn ? {...} : undefined`), matching the funding/taker branch two lines down and the `live-adapter.md:20` contract — never `?? 0`.
2. **Fix #2:** index the OI/liq window by calendar minute (align to `market-access.ts::windowMinutes`), so a skipped/delayed bar produces a gap rather than a silently-compressed window.
3. **Clarify #3/#5:** document whether `USE_AGGREGATED_MARKET_DATA` was on for the retired long_oi bot, and whether the historical `rowsBySymbol` collector captured the aggregator's per-minute output (so a backtest on that срез sees the same OI series). If yes, #1/#2 fixes should make future golden reproducible; if no, the fixture OI is not faithful and a re-capture is needed.

## Impact on G7 / the backtester
No backtester change is needed for correctness — `market-access.ts` already implements the contract. Once the live adapter is aligned (or a new post-fix golden is captured), the Stage-1 `it.skip` exact-parity test (`apps/backtester/test/long-oi-parity/signal-parity.test.ts`) should flip green on committed data. The 2/8 already-clean matches confirm the backtest engine + timestamp handling are correct.
