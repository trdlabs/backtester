# long_oi signal-parity — backtester reproduces recorded real-bot trades (G7 Stage 1)

**Date:** 2026-07-05
**Status:** APPROVED (brainstorm — anchor/scope/staging confirmed with user)
**Parent:** trading-lab roadmap §8 gap **G7** («tradeCount=0 + живой прогон»). This is the backtester-side deliverable; the roadmap tracking stays in trading-lab.

## 0. Context & motivation

The prior `tradeCount=0` observation for `long_oi` was an **artifact of running a minute-denominated strategy on a 1-hour demo fixture** (`ESPORTSUSDT:1h`): long_oi's FSM uses wall-clock minute thresholds (`watch.maxMinutes=40`, `oiWindow(3)`=3 min, `dump.lookbackMin=20` one-minute candles), so on 1h bars the WATCHING phase always times out before the next bar and the entry branch is structurally unreachable. It is **not** an engine bug (the engine's `oiAsOf/oiWindow/liqAsOf/liqWindow` feed OI/liq correctly) and **not** a data-plumbing gap.

What was never proven: that the backtester, running long_oi's **real decision code** from raw **1-minute** bars, reproduces the trades the **real bot** actually recorded. This spec builds that proof (Stage 1).

The existing `exec-validation` harness (`apps/backtester/test/exec-validation.test.ts`, `test/helpers-replay.ts`) validates the **fill/PnL model** by **force-injecting** recorded trades' entry/exit timestamps (`makeReplayModule` emits a known trade at a known bar) and checking the engine's fill math reproduces recorded pnl. It does **not** run long_oi's decision logic — so it never proves the engine would **generate the same entries**. That is the gap this spec closes.

## 1. Goal & acceptance

**Prove `long_oi` backtest ≡ recorded real-bot golden (signals exact + metrics in tolerance)** on real 1-minute data.

- **Anchor:** committed fixture `trading-mock-platform/data/snapshots/fixtures/2026-06-18-real-all` — **one real day** (`ESPORTSUSDT` 1-minute `CanonicalRowV2`, 06-18T00:00..23:59Z, carrying OI + funding + liquidations + taker). It records **9 real `long_oi` ESPORTSUSDT trades**.
- **Subject:** `ESPORTSUSDT` only, 1-minute (the symbol trading-lab's `defaultPlatformRun` targets; richest golden set — mix of take-profit and stop-loss exits).
- **Scorable set = 8 trades** (see §3 warmup): the golden ESPORTSUSDT entries whose entry time + long_oi's lookback fall inside the committed data window. The 06-18T00:04 entry is excluded (only 4 min after data start — insufficient lookback).

**Acceptance:** running `LONG_OI_MODULE` through the real `runBacktest` on the срез's ESPORTSUSDT 1-minute rows reproduces the 8 scorable golden trades — same entry bar, same side, same exit bar + normalized close-reason, pnl% within epsilon — and produces **no extra** entries inside the scorable window.

## 2. Architecture (repo: trading-backtester)

Extend the existing `exec-validation` harness rather than build parallel infra:

- **Today:** `helpers-replay.ts::replayPnlPct` builds `makeReplayModule` (force-injects recorded trades) → runs the real `runBacktest` (`createTrustedRouter()`, `SAME_BAR_NO_COST`) → returns `{backtestPnlPct, paperPnlPct}` per trade. Fill-model only.
- **Stage 1:** a new harness runs the **real `LONG_OI_MODULE`** (`{manifest, init, onBarClose, onPositionBar}`) through the **same `runBacktest`** on the срез's ESPORTSUSDT 1-minute rows, from raw bars, and collects the **engine-generated** trades. `runBacktest` already accepts an arbitrary `StrategyModule` (that is exactly how the replay stub runs today) — so long_oi executes **without** being added to `TRUSTED_REGISTRY_DEFINITION` (which stays `short_after_pump`-only).
- Reuse the committed golden fixture pattern (`test/fixtures/exec-validation/long-oi-time-exit.json`, produced by `scripts/extract-validation-fixture.mts`): a trimmed, committed `{ trades: PaperTrade[], rowsBySymbol: Record<symbol, CanonicalRowV2[]> }` for ESPORTSUSDT so the test is offline/deterministic and reads no live mock HTTP.

### Unit boundaries
- `runLongOiOnRows(rows: CanonicalRowV2[], symbol): GeneratedTrade[]` — pure adapter: feed 1-minute rows to `runBacktest` with `LONG_OI_MODULE`, return the engine's trades (entry/exit bar ts, side, exit reason, pnl%). One responsibility: execute the real module.
- `normalizeCloseReason(raw): CanonicalCloseReason` — §4.
- `matchTrades(golden, generated, scorableWindow): ParityReport` — §4 comparison. Pure, testable in isolation.
- The CI test wires: load fixture → filter scorable → run → match → assert.

## Task 0 (prerequisite): source of the runnable `long_oi` module

Before any harness code, **resolve where the backtester test obtains a runnable `long_oi` module**. The real module lives in `trading-platform/src/strategies/long_oi/*.ts` (byte-identical copy vendored in `trading-lab/docs/fixtures/strategies/long-oi-code/*.ts`); it is self-contained at runtime (only `type`-only imports from `@trading-platform/sdk/research-contract` + its own sibling files) and exports `LONG_OI_MODULE: StrategyModule` / `createLongOiModule()`. It is **not** in the backtester's trusted registry. Options (pick in the plan, do not guess):
1. **SDK export** — trading-platform publishes `long_oi` (or its `StrategyModule` factory) via `@trading-platform/sdk`; backtester imports it. Cleanest single-source-of-truth; needs a platform SDK release.
2. **Vendor into backtester test fixtures** — copy `long-oi-code/*.ts` under `apps/backtester/test/fixtures/strategies/long_oi/` with a provenance README + a byte-identity guard (checksum test against the platform source) so drift is caught.
3. **Path/workspace import** — import directly from a sibling checkout (fragile; rejected unless the repos are a workspace).

Task 0's deliverable: the chosen source wired so `import { LONG_OI_MODULE }` resolves in a backtester test, plus (for option 2) a drift guard. Every later task depends on it.

## 3. Warmup & scorable window

long_oi needs lookback before its first entry: `dump.lookbackMin = 20` one-minute candles to detect a dump, then up to `watch.maxMinutes = 40` in WATCHING before entering. **Warmup = `dump.lookbackMin + watch.maxMinutes = 60` minutes** (params-derived, conservative).

- **Scorable window** = `[data_start + warmup, data_end]` = `[06-18T01:00Z, 06-18T23:59Z]`.
- A golden trade is **scorable** iff its `openedAtMs ≥ data_start + warmup`. For ESPORTSUSDT this yields **8 of 9** (only 06-18T00:04 is excluded).
- Trades excluded by warmup are documented in the test (not silently dropped): assert the excluded set is exactly `{06-18T00:04}` so a data-window change surfaces.

Note: the committed срез is exactly one day (06-18T00:00..23:59); the earliest golden trade overall (06-17T22:48, a *different* symbol) is outside the window by construction — out of scope for the ESPORTSUSDT-only Stage 1.

## 4. Signal-match definition (signals exact + metrics in tolerance)

For each scorable golden trade, find the generated trade with the same **entry bar** and assert:
1. **Entry bar exact** — generated entry `minute_ts == golden.openedAtMs` (±0; 1-minute bars, deterministic engine). A missing or shifted entry is a failure.
2. **Side** — `long` (both).
3. **Exit bar** — generated exit `minute_ts == golden.closedAtMs` (±0).
4. **Close-reason (normalized)** — `normalizeCloseReason(generated) == normalizeCloseReason(golden)` (§4a).
5. **pnl% within epsilon** — `|generated.pnlPct − golden.pnlPct| ≤ tolPct` (default `0.05` pct-point; absorbs fill-model micro-differences between the paper host and the backtester, which are the concern the existing `exec-validation` already bounds — not a signal difference).

**No-extra-in-scorable-window (over-trigger guard):** the set of generated **entries** whose `entry_ts` ∈ scorable window must equal the scorable golden entry set — i.e. the engine produces **no additional** long_oi entries the real bot did not. Count + entry-bar set equality, both directions.

### 4a. Close-reason normalization
Golden carries `closeReason` ∈ {`take_profit_final`, `stop_loss`, `time_exit`, `other`} and `closeReasonRaw` ∈ {`tp2`, `sl`, …}; the engine's exit reason vocabulary differs. Normalize BOTH sides to a canonical enum before comparison:
```
CanonicalCloseReason = 'take_profit' | 'stop_loss' | 'time_exit' | 'other'
take_profit_final | tp1 | tp2 | take_profit*   -> 'take_profit'
stop_loss | sl                                 -> 'stop_loss'
time_exit | max_hold | watch_expire            -> 'time_exit'
everything else                                -> 'other'
```
The exact raw-token map is finalized in the plan by reading the engine's actual exit-reason emissions + the golden `closeReasonRaw` values; `other`↔`other` matches are allowed but flagged in the report (they weaken the assertion) so they don't silently pass.

## 5. Error handling / determinism

- Deterministic: same rows + same module + same seed/execution-profile → byte-identical generated trades. A determinism test runs twice and asserts equality.
- If `runLongOiOnRows` produces **zero** trades in the scorable window, that is a **hard failure** (the tradeCount=0 regression) — not a skip.
- Offline: the test reads the committed trimmed fixture, never live mock HTTP.

## 6. Out of scope

- **Stage 2 — LLM-built long_oi bundle ≡ vendored module.** A separate slice (trading-lab side: the analyst→builder chain produces a bundle; assert it reproduces the vendored module's trades on the same срез). Isolates *builder* faithfulness from *engine* faithfulness. Not in this spec.
- **North-star — real 3-day срез + real-platform paper ≡ срез.** No committed 3-distinct-day real fixture exists (`2026-06-16-to-18-extended` is one real day copied ×3 for 1h-term rendering — unusable for trade verification); a genuine multi-day срез needs a VPS fetch (`trading-mock-platform/tools/fetch-snapshot`), and live-platform paper parity is the trading-platform `058 market-replay-streamer` (Draft). Both deferred.
- Multi-symbol parity (the other 12/22 golden trades across 10 symbols) — Stage 1 is ESPORTSUSDT-only; a follow-up can widen once the single-symbol harness is proven.

## 7. Tests / acceptance contour

1. `normalizeCloseReason` — table (each raw token → canonical; unknown → other).
2. `matchTrades` — pure: exact match → pass; shifted entry bar → fail; wrong close-reason → fail; pnl beyond epsilon → fail; an extra generated entry in-window → fail (over-trigger); a golden entry with no generated match → fail (under-trigger).
3. Warmup: scorable filter yields exactly 8 ESPORTSUSDT trades; the excluded set is exactly `{06-18T00:04}`.
4. Integration (CI): load fixture → `runLongOiOnRows` → match against the 8 scorable → all pass, no extra in-window; non-zero trades (tradeCount=0 guard).
5. Determinism: two runs byte-identical.

## 8. Risks

- **Module source (Task 0)** — if long_oi cannot be cleanly imported into a backtester test (option choice), Stage 1 is blocked; Task 0 resolves it first.
- **Fill-model divergence** — the real paper host and the backtester may fill slightly differently; §4 keeps **signals** exact and puts only **pnl%** under tolerance, matching what `exec-validation` already established is reconcilable for BEATUSDT/SIRENUSDT (LABUSDT/REUSDT were flagged divergent — ESPORTSUSDT reproducibility to be confirmed in the plan; if ESPORTSUSDT itself is fill-divergent, scope the pnl tolerance per that finding, never loosen the signal assertions).
- **Exit-reason vocabulary drift** — §4a normalization is finalized against the engine's real emissions in the plan, with `other`↔`other` flagged so it can't mask a mismatch.
