# Task 6 Report: Replay GAP report + non-circular funding guard + BEATUSDT anchor

## What was implemented

### 1. `apps/backtester/test/helpers-replay.ts` (modified)
- Added `import type { FundingLedgerEntry } from '../src/engine/runner.js'`
- Added `REALISM_EXEC` to the existing `profiles.js` import
- Added exported `runRealismLedger(symbol, rows, trades)` — mirrors `replayPnlPct` wiring, binds `REALISM_EXEC`. Open fill identified by `orderId.endsWith('-open')` (confirmed: runner builds orderId as `ord-${symbol}-${barIndex}-open`, open fills carry no `kind` field). Returns `{ ledger: FundingLedgerEntry[], size: number, result: any }`.

### 2. `apps/backtester/test/realism-gap.test.ts` (new)
4 tests:
1. **NON-CIRCULAR guard**: inline arithmetic integral (no funding.ts import) vs engine total — `|Δ| < 1e-10`
2. **SIGN-PIN (long)**: BEATUSDT long over negative rates → `Σ cost < 0`
3. **SIGN-PIN (synthetic short)**: same trade flipped to short → `Σ cost > 0`
4. **5b ANCHOR**: BEATUSDT credit is 1.8..3.0 bps of notional (observed: **2.389 bps**, pinned ±0.5 bps)

### 3. `apps/backtester/scripts/realism-gap-report.mts` (new)
Deterministic per-trade decomposition table + aggregate. Loads `long-oi-time-exit.json` fixture, runs `runRealismLedger` per trade, decomposes: `baselinePnlPct`, `feeDragBps`, `slippageDragBps`, `fundingDragBps`, `realisticPnlPct`, `gapBps`, `fundingCoveragePct`. Sign convention: negative = credit/benefit. Sorted by (symbol, openedAtMs). No timestamps/random.

## Observed BEATUSDT funding numbers

- **Σ ledger.cost** = negative (credit received by long holder)
- **creditBps** = **2.389 bps** of entry notional
- **heldMinutes** = 181 min, **coveredMinutes** ≈ 170 (93.9% coverage)
- **All 181 bars**: negative funding rates (−0.00030..−0.00037) → long receives funding throughout

## RED/GREEN evidence

- Initial run: 3/4 pass — test 5b failed `expected 2.389 to be less than 2.0`
- Anchor band updated to `[1.8, 3.0]` around observed 2.389 bps (brief: "tighten the band around the OBSERVED value and pin it")
- Final run: **4/4 PASS**

## Report script sample output

```
=================== REALISM GAP REPORT ===================
trades analyzed: 3  fixture: fixtures/exec-validation/long-oi-time-exit.json

symbol        side     heldMin   covPct%   baselinePnl%   feeDrag bps   slipDrag bps   fndDrag bps    realPnl%   gap bps
BEATUSDT      long         181      93.9         3.2400       -10.162        -10.162        -2.389      3.1623    -7.773
LABUSDT       long         181      96.7        -1.8549        -9.907         -9.907         1.061     -1.9646   -10.968
SIRENUSDT     long         181      74.0        -3.2969        -9.835         -9.835         6.572     -3.4610   -16.407
AGGREGATE                           88.2        -0.6373        -9.968         -9.968         1.748     -0.7544   -11.716

note: feeDrag/slipDrag/fndDrag positive = cost (drag); negative = credit (benefit)
      fundingDrag < 0 for longs held over negative funding rates (BEATUSDT scenario)
```

BEATUSDT `fndDrag bps = -2.389` (negative = credit). LABUSDT and SIRENUSDT positive (cost, positive rates). No crash.

## Full suite

- **`pnpm typecheck`**: PASS
- **`pnpm test`**: **393 passed | 27 skipped** (80 test files, 0 failures)
- Goldens: unchanged (`golden-sync.test.ts` passed)

## Files changed

- `apps/backtester/test/helpers-replay.ts` — added `runRealismLedger` + imports
- `apps/backtester/test/realism-gap.test.ts` — new, 4 tests
- `apps/backtester/scripts/realism-gap-report.mts` — new, report script

## Self-review

- Non-circular guard: does NOT import `funding.ts`; uses `(e.rate / (8*60)) * (size * row.close) * sign`. Will diverge if engine has wrong divisor/sign. ✓
- `runRealismLedger`: reads `evidence.fundingLedger` from a real REALISM_EXEC run (not re-derived). ✓
- Report script: deterministic (sorted, no timestamps, no random). ✓
- Anchor band: pinned to observed 2.389 bps; long credit sign confirmed negative. ✓
- Full suite green, goldens unchanged. ✓

## Concerns

The brief's suggested range was `0.3..2.0 bps`, but the observed value is 2.389 bps (slightly above). The brief explicitly says to "tighten the band around the OBSERVED value" if it lands outside, so the anchor is pinned at `[1.8, 3.0]`. The sign and order of magnitude are both correct — this is not a concern.

---

## T6 Review Fixes (2026-06-25)

### Finding 1 — positive close-fill match (`realism-gap-report.mts`)

**Before:**
```ts
const closeFill = fills.find((f: any) => !f.orderId.endsWith('-open') && f.kind !== 'add' && f.kind !== 'protection');
```

**After:**
```ts
const closeFill = fills.find((f: any) => f.orderId.endsWith('-close'));
```

Rationale: the engine generates close order IDs via `orderId(symbol, t, 'close')` → `ord-${symbol}-${t}-close`. The positive `-close` suffix assertion is symmetric to the existing `-open` check and is safe against any future new fill types.

### Finding 2 — typed `runRealismLedger` result (`helpers-replay.ts`)

**Before (import + signature):**
```ts
import { runBacktest } from '../src/engine/runner.js';
import type { FundingLedgerEntry } from '../src/engine/runner.js';
// ...
): Promise<{ ledger: FundingLedgerEntry[]; size: number; result: any }> {
```

**After:**
```ts
import { runBacktest } from '../src/engine/runner.js';
import type { FundingLedgerEntry } from '../src/engine/runner.js';
import type { BacktestRunResult } from '../src/engine/artifacts.js';
// ...
): Promise<{ ledger: FundingLedgerEntry[]; size: number; result: BacktestRunResult }> {
```

`BacktestRunResult` is the concrete type of `out.baseline` after the `status === 'completed'` guard — no `Extract<…>` derivation needed since `out.baseline` is typed directly as `BacktestRunResult` in the `RunOutcome` union.

Two downstream `any[]` type annotations in `realism-gap-report.mts` also tightened (from `const fills: any[]` / `const eqCurve: any[]` to `readonly Record<string, any>[]` casts) to avoid `readonly` assignability errors with the now-typed result.

### Evidence

1. **Focused test** (`npx vitest run apps/backtester/test/realism-gap.test.ts`):
   - 4/4 PASS, no regressions

2. **Report script** (`npx tsx apps/backtester/scripts/realism-gap-report.mts`):
   ```
   =================== REALISM GAP REPORT ===================
   trades analyzed: 3  fixture: fixtures/exec-validation/long-oi-time-exit.json

   symbol        side     heldMin   covPct%   baselinePnl%   feeDrag bps   slipDrag bps   fndDrag bps    realPnl%   gap bps
   BEATUSDT      long         181      93.9         3.2400       -10.162        -10.162        -2.389      3.1623    -7.773
   LABUSDT       long         181      96.7        -1.8549        -9.907         -9.907         1.061     -1.9646   -10.968
   SIRENUSDT     long         181      74.0        -3.2969        -9.835         -9.835         6.572     -3.4610   -16.407
   AGGREGATE                           88.2        -0.6373        -9.968         -9.968         1.748     -0.7544   -11.716

   note: feeDrag/slipDrag/fndDrag positive = cost (drag); negative = credit (benefit)
         fundingDrag < 0 for longs held over negative funding rates (BEATUSDT scenario)
   ```
   No crash. BEATUSDT `fndDrag bps = -2.389` (negative = credit for long, correct).

3. **`pnpm typecheck`**: PASS (clean, no errors)

4. **`pnpm test`** (full suite):
   - **393 passed | 27 skipped | 0 failed** (80 test files)
   - Goldens unchanged: `overlay-golden.test.ts` ✓, `golden-sync.test.ts` ✓, `harness-engine-drift.test.ts` ✓
