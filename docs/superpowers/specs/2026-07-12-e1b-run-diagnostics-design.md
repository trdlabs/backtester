# E1b — Structured run diagnostics / failure feedback (advisory) design

Date: 2026-07-12. Phase E, ROADMAP item 20 (second half; E1a = #103). Predecessors:
`docs/FEATURE-PARITY.md` (§4 E1), the period-selection discussion (trade-level power ≠ bar-T).

## Goal

Give the LLM loop a machine-readable, deterministic **fact vector + engine-derivable flags** for why
a run is weak — the interpretation language for E2/E3/E4's advisory numbers (a DSR / OOS-stability
number is meaningless on a run with 3 trades or zero exposure). **Boundary invariant:** the engine
emits only FACTS it can fully see and flags DERIVABLE from those facts + operator thresholds; the
lab-only judgments (`suspected_overfit`, `hypothesis_mismatch`) stay lab-side (they need hypothesis
text / cross-run context the deterministic engine does not have). Advisory + dark-launched:
`BACKTESTER_RUN_DIAGNOSTICS` default OFF, non-hashed summary field, `result_hash` byte-identical.

## Scope

- **In:** `apps/backtester/src/engine/diagnostics.ts` (pure `computeRunDiagnostics`), the SDK
  `RunDiagnostics` contract type, config (flag + two thresholds), and flag-gated worker-finalize
  wiring (overlay/strategy).
- **Out:** lab-only failure categories; request-supplied per-run thresholds (config-only first —
  follow-up); trade-level diagnostics as a separate artifact (facts suffice for the first slice);
  momentum path (no clean trades/equity pairing at that seam — not diagnosed).

## Pure module — `src/engine/diagnostics.ts`

`computeRunDiagnostics(input): RunDiagnostics` where `input = { trades, equity, barsProcessed,
orderCount, policy: { minTrades, concentrationPct } }`. All facts are pure deterministic functions of
`trades`/`equity`/`barsProcessed`, `quantize`d.

**Facts:**
- `tradeCount` = `trades.length`
- `orderCount` = `input.orderCount` (from the run summary's `ordersCount`)
- `barsProcessed`
- `exposureFraction` = `Σ(exitBarIndex − entryBarIndex) / barsProcessed` (0 when `barsProcessed=0`).
  Documented: sums position-bars, so it **may exceed 1** with concurrent positions.
- `winningTrades` / `losingTrades` = counts of `realizedPnl > 0` / `< 0`
- `topTradeContributionPct` = `maxWinner / grossProfit · 100` (0 when no profit) — concentration
- `returnsCount` = `dsrInputsFromEquity(equity)?.tCount ?? 0` (T, reusing E1a's shared rule)

**Flags** (deterministic list, engine-derivable only; stable order):
- `no_entries` — `tradeCount === 0`
- `underpowered` — `tradeCount < policy.minTrades`
- `single_trade_dominated` — `topTradeContributionPct > policy.concentrationPct` (and profit exists)
- `zero_exposure` — position-bars `=== 0`
- `all_losing` — `tradeCount > 0 && winningTrades === 0`

## Contract (SDK, additive, NON-hashed)

```ts
export type RunDiagnosticFlag =
  | 'no_entries' | 'underpowered' | 'single_trade_dominated' | 'zero_exposure' | 'all_losing';
export interface RunDiagnostics {
  readonly facts: {
    readonly tradeCount: number; readonly orderCount: number; readonly barsProcessed: number;
    readonly exposureFraction: number; readonly winningTrades: number; readonly losingTrades: number;
    readonly topTradeContributionPct: number; readonly returnsCount: number;
  };
  readonly flags: readonly RunDiagnosticFlag[];
  readonly policy: { readonly minTrades: number; readonly concentrationPct: number }; // provenance
}
// RunResultSummary += diagnostics?: RunDiagnostics  (absent when the flag is OFF)
```

`policy` is carried for provenance (a flag's meaning depends on the thresholds that produced it).

## Config (dark-launch, default OFF)

`BACKTESTER_RUN_DIAGNOSTICS` (bool) + `BACKTESTER_DIAG_MIN_TRADES` (default 30) +
`BACKTESTER_DIAG_CONCENTRATION_PCT` (default 80). Thresholds are operator policy (mirrors E2's
`empiricalMinN`); a numeric knob clamps to a sane floor, not fail-fast (unlike E4's fraction, an
out-of-range trade count is still meaningful — 0 just means "everything is underpowered").

## Wiring — worker finalize (overlay/strategy, flag-gated)

After `finalizeResult` (resultHash fixed), when `deps.diagnostics?.enabled`: compute
`computeRunDiagnostics` from `outcome.baseline` (`trades`, `evidence.equityCurve`,
`summary.barsProcessed`, `summary.ordersCount`) + the config policy, and attach `diagnostics` to the
summary projection (after `contentRef(payload)`, never in it). Flag OFF ⇒ no field ⇒ byte-identical.
Momentum path not diagnosed (consistent with E2/E4 seam).

## Determinism / invariant

Facts are deterministic functions of the run, `quantize`d, but the field lives on the NON-hashed
summary projection (like `trialContext`/`holdout`) so goldens stay byte-identical and the API-response
shape only changes when the flag is on. `decideVerdict` untouched — advisory.

## Testing (TDD)

**pure:** exact facts on a hand-built trades/equity fixture (exposureFraction incl. a concurrent
case > 1; topTradeContributionPct; winning/losing; returnsCount via the E1a rule); each flag toggles
at its threshold (`no_entries` at 0 trades; `underpowered` at `minTrades − 1` vs `minTrades`;
`single_trade_dominated` just over/under `concentrationPct`; `zero_exposure`; `all_losing`); empty
run ⇒ `no_entries` + `zero_exposure` + `underpowered`, no crash; `policy` echoed. **config:** default
off; exact-`true`; threshold defaults 30/80; custom thresholds parsed. **wiring:** flag OFF ⇒ no
`diagnostics` + golden `result_hash` unchanged; flag ON ⇒ diagnostics present with expected flags.

## Out of scope

Lab-only categories (`suspected_overfit`, `hypothesis_mismatch`); request-supplied thresholds;
per-trade diagnostics artifact; momentum path; the lab-side consumption (its own slice).
