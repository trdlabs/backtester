# E1a — Metric catalog expansion (design)

Date: 2026-07-12. Phase E, ROADMAP item 20 (first half). Predecessor: `docs/FEATURE-PARITY.md`.
Second half (structured failure feedback) is a separate slice **E1b** and is out of scope here.

## Goal

Expand the request-gated metric catalog on the overlay/strategy engine path so the LLM loop and
Phase E gates have the metrics practitioners compare on — and expose the distribution moments that
E2's Deflated Sharpe Ratio consumes. Purely additive: no public type change, existing
`result_hash` byte-identical.

## Scope

- **In:** `apps/backtester/src/engine/metrics.ts` (new metric functions + a shared returns-stats
  helper) and `apps/backtester/src/engine/registry-definition.ts` (advertise new metric names in
  the `default-overlay` catalog — the single source feeding discovery + `/v1/capabilities`).
- **Out:** momentum runner (`src/runner/`, does not share `computeMetrics`); `rolling_sharpe`
  (a series, not a scalar — deferred to Tier 2 tearsheet artifact); ratio annualization; the
  failure-feedback channel (E1b); the SDK public `RunResultSummary` type (`metrics:
  Record<string, number>` is unchanged — only new possible keys).

## New metrics (all request-gated, all `quantize`d)

| Name | Definition | Fail-closed |
|---|---|---|
| `sortino` | `mean(r) / downsideStd(r)`, `r` = per-bar returns; `downsideStd = sqrt(mean(min(r,0)²))` — **downside deviation vs 0, not a MAR/target return** | `count<2` or `downsideStd===0` → `0` (symmetric to `sharpe`) |
| `expectancy` | `mean(realizedPnl)` over closed trades — absolute currency, like `pnl` | `0` trades → `0` |
| `sqn` | `mean(pnl)/std(pnl) · √N` over closed trades; **`std` is population** (consistent with `sharpe`) | `N<2` or `std===0` → `0` |
| `cagr` | `(eq_last/eq_first)^(1/years) − 1`, `years = elapsedYears` from `request.period` | `elapsedYears == null` / `eq_first≤0` / `eq_last≤0` / `ratio≤0` → **omit key** |
| `calmar` | `cagr / max_drawdown` | `max_drawdown===0` or `cagr` undefined → **omit key** |
| `returns_stddev` | population std of per-bar returns | `count<2` → `0` |
| `returns_skew` | `(1/count·Σ(r−μ)³) / std³` | `count<2` or `std===0` → `0` |
| `returns_kurtosis` | `(1/count·Σ(r−μ)⁴) / std⁴` — **Pearson kurtosis, normal distribution = 3.0** (not excess; DSR consumes γ₄ this way) | `count<2` or `std===0` → `0` |
| `returns_count` | length of the actually-built returns array (= `T`, DSR sample length) | invalid series → `0` |

omit-key metrics (`cagr`, `calmar`) follow the established `profit_factor` pattern: a
`number | null` helper, and the switch only assigns when non-null. `0` would be a *valid* value;
these are *undefined*, so the key is omitted, not zeroed.

## Shared returns-stats helper (the load-bearing refactor)

A single internal `computeReturnsStats(equity)` builds the per-bar returns series ONCE and returns
`{ count, mean, std, m3, m4, downsideStd }` (moments unquantized). It feeds `sharpe`, `sortino`,
`returns_stddev`, `returns_skew`, `returns_kurtosis`, `returns_count` — so all DSR raw material
comes from one series computed under one rule (user requirement #7/#8).

**Byte-identity constraint (golden-critical):** `sharpe` is refactored to read from this helper but
its output MUST stay byte-identical to today's, or existing `result_hash` goldens break. The helper
must replicate today's exact `sharpe` arithmetic and short-circuits:

- `equity.length < 2` → empty returns → `count 0`.
- **`prev === 0` anywhere in the series → the whole series is invalid** (today `sharpe` does
  `return 0` on the first `prev === 0`); the helper returns `count 0, mean 0, std 0, m3 0, m4 0,
  downsideStd 0`, so every returns-derived metric reads `0` — matching today's short-circuit.
- `mean = Σr / count`, `variance = Σ(r−mean)² / count` (population), `std = sqrt(variance)` — same
  reduce order and divisor as current `sharpe`, so `sharpe = quantize(mean/std)` is byte-identical.
- `m3 = Σ(r−mean)³`, `m4 = Σ(r−mean)⁴`, `downsideStd = sqrt(Σ min(r,0)² / count)` are additive
  computations that never touch the `mean`/`variance` arithmetic — they cannot perturb `sharpe`.

`sharpe` guard mapping (unchanged behavior): `count<2` → 0, `std===0` → 0, else `quantize(mean/std)`.

## Signature change

`computeMetrics(requested, equity, trades)` → `computeMetrics(requested, equity, trades, context)`
where `context = { elapsedYears: number | null }` — an explicit object even with one field, so
future annualization inputs (`timeframe`, `periodsPerYear`) slot in without another signature
change. `assembleResult` computes `elapsedYears` from `request.period` (`(toMs − fromMs) /
(365.25·24·3600·1000)`, `null` if non-positive/unparseable) and passes it; `metrics.ts` does no
date parsing. `cagr`/`calmar` omit when `elapsedYears == null`. Only caller is `assembleResult`;
`verify_change` run before editing.

## Determinism / invariant

All functions are pure over `equity`/`trades`/`elapsedYears`, `quantize`d at each metric boundary.
Metrics stay request-gated (`default: break`), so a request that does not name a new metric
produces a byte-identical `metrics` object and `result_hash`. No golden moves.

## Testing (TDD)

1. **Pin current `sharpe`** on a fixture before refactoring (characterization), then refactor to the
   helper and assert byte-identical `sharpe` + full-suite golden `result_hash` unchanged.
2. Per-metric value tests on a fixture with hand-computed expected numbers.
3. Edge cases: empty trades (`expectancy`/`sqn`→0), zero drawdown (`calmar` omit), blow-up
   `equity_last≤0` (`cagr` omit), `n<2` (all returns metrics→0), `prev===0` mid-series (whole
   returns family→0, and `sharpe` still 0).
4. Determinism replay: identical input → identical `quantize`d output.
5. **Non-regression:** a request for only the *old* metric set yields exactly the old keys — no
   new DSR ingredients auto-added.

## Out of scope (restated)

E1b failure feedback; rolling/series metrics + tearsheet (Tier 2); ratio annualization
(`periods_per_year`); momentum path.
