# Realism — funding cost model + GAP report — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in funding cost model to the backtester engine and a realistic-replay GAP report that decomposes per-trade cost drag (baseline / fee / slippage / funding) in bps.

**Architecture:** A pure `funding.ts` calculator (per-minute proration of the tape's 8h-equivalent funding rate) is the single source of truth. The engine accrues funding end-of-bar into cash via `Portfolio.chargeFunding` (opt-in: only when `ExecutionProfile.fundingModel` is present, so the default path stays byte-identical). A replay GAP report consumes the engine's funding ledger; a CI test guards it with an independent inline integral.

**Tech Stack:** TypeScript (ESM), Vitest, decimal.js. Package: `apps/backtester`. Spec: `docs/superpowers/specs/2026-06-25-realism-funding-design.md`.

## Global Constraints

- **Default path byte-identical.** No golden, metric, or existing demo may move. All funding behavior is gated on `ExecutionProfile.fundingModel !== undefined`. `DEFAULT_EXEC` and all sub#1 profiles carry no `fundingModel`. (Constitution XIV: no silent fallback.)
- **All monetary arithmetic via `decimal.js`** (`new Decimal(...)`), quantized at artifact boundaries with the existing `quantize` from `../determinism/canonical-json.js`. Never accumulate funding in floats.
- **Funding is a holding cost on the portfolio**, charged to `cash` only — it is **NOT** folded into per-trade `realizedPnl`/`feePaid` (execution-layer numbers stay execution-layer).
- **Execution-layer only**: pnlPct / bps. No USD / sizing / portfolio metrics.
- **Closed catalogs, fail-fast.** `SUPPORTED_FUNDING_MODEL_KINDS` is closed; an unknown `fundingModel.kind` throws (mirror of `SUPPORTED_FILL_MODEL_KINDS`).
- **No look-ahead.** Funding reading is the 030 `as-of` snapshot at `bar.ts` (`present`/`stale` use the rate; `missing` → charge 0).
- **Sign convention (input contract):** `funding_rate > 0` ⟹ long pays short. `sign(long)=+1`, `sign(short)=−1`; positive paid-fraction = a cost.
- **Run a single test file (skips the slow `pretest` SDK build):** `npx vitest run <path>`. Full suite (with goldens): `pnpm test`.
- **Branch:** `feat/realism-funding` (already created, spec committed). Commit per task.

---

## File Structure

- `apps/backtester/src/engine/funding.ts` — **NEW.** Pure funding math (no I/O, no profiles import). Single source of truth.
- `apps/backtester/src/engine/profiles.ts` — **MODIFY.** Add `PerMinuteProrateFundingModel`, `SUPPORTED_FUNDING_MODEL_KINDS`, `REALISM_EXEC`.
- `packages/research-contracts/src/research/risk-execution.ts` — **MODIFY.** Add optional `fundingModel?: object` to `ExecutionProfile`.
- `packages/research-contracts/src/research/*` (evidence type) — **MODIFY.** Add optional `fundingLedger?` + `FundingLedgerEntry` to `RunEvidence`.
- `apps/backtester/src/engine/execution.ts` — **MODIFY.** `fundingEnabled()`, `fundingIntervalHours()`, unknown-kind guard.
- `apps/backtester/src/engine/portfolio.ts` — **MODIFY.** `chargeFunding(cost)`.
- `apps/backtester/src/engine/runner.ts` — **MODIFY.** End-of-bar accrual; `fundingLedger` in `RunAccumulators`; thread `marketTape` into `runSymbol`; expose ledger on the result.
- `apps/backtester/test/funding.test.ts` — **NEW.** Unit tests for `funding.ts`.
- `apps/backtester/test/funding-engine.test.ts` — **NEW.** Profiles catalog, `fundingEnabled`, `chargeFunding`, default-path empty-ledger.
- `apps/backtester/test/helpers-replay.ts` — **MODIFY.** Add per-trade cost decomposition helper.
- `apps/backtester/scripts/realism-gap-report.mts` — **NEW.** Deterministic GAP report over the snapshot.
- `apps/backtester/test/realism-gap.test.ts` — **NEW.** The 4 GAP/funding assertions incl. the non-circular guard + BEATUSDT 5b anchor.

---

## Task 1: Pure funding calculator (`funding.ts`)

**Files:**
- Create: `apps/backtester/src/engine/funding.ts`
- Test: `apps/backtester/test/funding.test.ts`

**Interfaces:**
- Produces:
  - `fundingSign(side: 'long' | 'short'): number`
  - `perMinuteFundingFraction(rate8h: number, intervalHours: number): Decimal`
  - `computeBarFunding(args: { side: 'long'|'short'; size: number; mark: number; rate8h: number; covered: boolean; barMinutes: number; intervalHours: number }): Decimal` — cash cost for one bar; positive = outflow (paid), negative = credit.
  - `computeFundingPaidFraction(args: { side: 'long'|'short'; rates8h: readonly number[]; covered: readonly boolean[]; barMinutes: number; intervalHours: number }): Decimal` — notional-fraction paid over a held window; positive = paid.

- [ ] **Step 1: Write the failing test**

Create `apps/backtester/test/funding.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  computeBarFunding,
  computeFundingPaidFraction,
  fundingSign,
  perMinuteFundingFraction,
} from '../src/engine/funding';

describe('funding — per-minute proration of the 8h-equivalent rate', () => {
  it('perMinuteFundingFraction divides the 8h rate by intervalHours*60 exactly once', () => {
    // 8h rate 0.0008 over 8h = 480 min → per-minute = 0.0008/480
    expect(perMinuteFundingFraction(0.0008, 8).toNumber()).toBeCloseTo(0.0008 / 480, 15);
  });

  it('fundingSign: long pays (+1), short receives (-1)', () => {
    expect(fundingSign('long')).toBe(1);
    expect(fundingSign('short')).toBe(-1);
  });

  it('computeBarFunding: long + positive rate = cost (cash outflow > 0)', () => {
    // size 2, mark 100, notional 200; 1-min bar; rate 0.0008/8h
    const cost = computeBarFunding({
      side: 'long', size: 2, mark: 100, rate8h: 0.0008, covered: true, barMinutes: 1, intervalHours: 8,
    });
    expect(cost.toNumber()).toBeCloseTo((0.0008 / 480) * 200, 15);
    expect(cost.toNumber()).toBeGreaterThan(0);
  });

  it('computeBarFunding: long + NEGATIVE rate = credit (cash inflow < 0)', () => {
    const cost = computeBarFunding({
      side: 'long', size: 2, mark: 100, rate8h: -0.0002, covered: true, barMinutes: 1, intervalHours: 8,
    });
    expect(cost.toNumber()).toBeLessThan(0);
  });

  it('computeBarFunding: short flips the sign vs long', () => {
    const long = computeBarFunding({ side: 'long', size: 1, mark: 50, rate8h: 0.0008, covered: true, barMinutes: 1, intervalHours: 8 });
    const short = computeBarFunding({ side: 'short', size: 1, mark: 50, rate8h: 0.0008, covered: true, barMinutes: 1, intervalHours: 8 });
    expect(short.toNumber()).toBeCloseTo(-long.toNumber(), 15);
  });

  it('computeBarFunding: uncovered minute charges 0', () => {
    const cost = computeBarFunding({ side: 'long', size: 2, mark: 100, rate8h: 0.0008, covered: false, barMinutes: 1, intervalHours: 8 });
    expect(cost.toNumber()).toBe(0);
  });

  it('computeFundingPaidFraction integrates per-minute and skips uncovered minutes', () => {
    const rates8h = [0.0008, 0.0008, 0.0008];
    const covered = [true, false, true]; // middle minute is a data hole → skipped
    const frac = computeFundingPaidFraction({ side: 'long', rates8h, covered, barMinutes: 1, intervalHours: 8 });
    expect(frac.toNumber()).toBeCloseTo((0.0008 / 480) * 2, 15);
  });

  it('computeFundingPaidFraction: constant rate held a full 8h recovers the discrete 8h charge', () => {
    const rates8h = new Array(480).fill(0.0008);
    const covered = new Array(480).fill(true);
    const frac = computeFundingPaidFraction({ side: 'long', rates8h, covered, barMinutes: 1, intervalHours: 8 });
    expect(frac.toNumber()).toBeCloseTo(0.0008, 12); // self-consistency: integral == 8h rate
  });

  it('intervalHours must be positive (fail-fast)', () => {
    expect(() => perMinuteFundingFraction(0.0008, 0)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/backtester/test/funding.test.ts`
Expected: FAIL — cannot find module `../src/engine/funding`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/backtester/src/engine/funding.ts`:

```typescript
// Realism — pure funding cost calculator (single source of truth for engine accrual AND GAP report).
// No I/O, no profiles import (avoids a cycle). All arithmetic in decimal.js; quantization happens at
// the artifact boundary in the engine, not here.
//
// CONTRACT — input semantics: `rate8h` / `rates8h` are 8h-EQUIVALENT funding rates as-of each held
// minute (030 funding column), NOT pre-prorated. Division by (intervalHours*60) happens EXACTLY here.
// SIGN convention: funding_rate > 0 ⟹ long pays short. sign(long)=+1, sign(short)=−1; a positive
// result is a cost (cash outflow / paid). Some exchanges invert the API sign — normalize upstream.

import { Decimal } from 'decimal.js';

/** +1 for long (pays when rate>0), −1 for short (receives when rate>0). */
export function fundingSign(side: 'long' | 'short'): number {
  return side === 'long' ? 1 : -1;
}

/** Per-minute fraction of notional implied by an 8h-equivalent rate. Divides by intervalHours*60 once. */
export function perMinuteFundingFraction(rate8h: number, intervalHours: number): Decimal {
  if (!(intervalHours > 0)) throw new Error(`funding: intervalHours must be > 0, got ${intervalHours}`);
  return new Decimal(rate8h).div(intervalHours * 60);
}

/** Cash cost of funding for one bar. Positive = outflow (paid); negative = credit. Uncovered → 0. */
export function computeBarFunding(args: {
  side: 'long' | 'short';
  size: number;
  mark: number;
  rate8h: number;
  covered: boolean;
  barMinutes: number;
  intervalHours: number;
}): Decimal {
  if (!args.covered) return new Decimal(0);
  const notional = new Decimal(args.size).times(args.mark);
  return perMinuteFundingFraction(args.rate8h, args.intervalHours)
    .times(args.barMinutes)
    .times(notional)
    .times(fundingSign(args.side));
}

/** Notional-fraction paid over a held window. Positive = paid; negative = credit. Uncovered minutes skipped. */
export function computeFundingPaidFraction(args: {
  side: 'long' | 'short';
  rates8h: readonly number[];
  covered: readonly boolean[];
  barMinutes: number;
  intervalHours: number;
}): Decimal {
  let acc = new Decimal(0);
  for (let i = 0; i < args.rates8h.length; i += 1) {
    if (!args.covered[i]) continue;
    acc = acc.plus(perMinuteFundingFraction(args.rates8h[i], args.intervalHours).times(args.barMinutes));
  }
  return acc.times(fundingSign(args.side));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/backtester/test/funding.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/engine/funding.ts apps/backtester/test/funding.test.ts
git commit -m "feat(realism): pure funding calculator (per-minute prorate of 8h-equiv rate)"
```

---

## Task 2: Funding model types + REALISM_EXEC profile (`profiles.ts`, contract field)

**Files:**
- Modify: `packages/research-contracts/src/research/risk-execution.ts:30-39` (add optional field)
- Modify: `apps/backtester/src/engine/profiles.ts`
- Test: `apps/backtester/test/funding-engine.test.ts` (created here, extended in Task 3/4)

**Interfaces:**
- Consumes: `ExecutionProfile`, `NextBarOpenFillModel`, `FixedBpsModel` (existing, `profiles.ts`).
- Produces:
  - `PerMinuteProrateFundingModel { readonly kind: 'per_minute_prorate'; readonly intervalHours: number }`
  - `SUPPORTED_FUNDING_MODEL_KINDS = ['per_minute_prorate'] as const`
  - `REALISM_EXEC: ExecutionProfile` (id `realism_exec`, next_bar_open, fee 5 bps, slippage 5 bps, funding per_minute_prorate intervalHours 8)
  - `ExecutionProfile.fundingModel?: object`

- [ ] **Step 1: Write the failing test**

Create `apps/backtester/test/funding-engine.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXEC,
  REALISM_EXEC,
  SUPPORTED_FUNDING_MODEL_KINDS,
  type PerMinuteProrateFundingModel,
} from '../src/engine/profiles';

describe('REALISM_EXEC profile + funding-model catalog', () => {
  it('per_minute_prorate is the only supported funding kind (closed catalog)', () => {
    expect([...SUPPORTED_FUNDING_MODEL_KINDS]).toEqual(['per_minute_prorate']);
  });

  it('REALISM_EXEC carries next_bar_open + fee/slippage bps + per_minute_prorate funding (8h)', () => {
    expect((REALISM_EXEC.fillModel as { kind: string }).kind).toBe('next_bar_open');
    expect((REALISM_EXEC.feeModel as { bps: number }).bps).toBe(5);
    expect((REALISM_EXEC.slippageModel as { bps: number }).bps).toBe(5);
    const fm = REALISM_EXEC.fundingModel as PerMinuteProrateFundingModel;
    expect(fm.kind).toBe('per_minute_prorate');
    expect(fm.intervalHours).toBe(8);
  });

  it('DEFAULT_EXEC carries NO fundingModel (opt-in: default path unchanged)', () => {
    expect(DEFAULT_EXEC.fundingModel).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/backtester/test/funding-engine.test.ts`
Expected: FAIL — `REALISM_EXEC` / `SUPPORTED_FUNDING_MODEL_KINDS` not exported.

- [ ] **Step 3a: Add the optional contract field**

In `packages/research-contracts/src/research/risk-execution.ts`, inside `interface ExecutionProfile` (after `slippageModel`):

```typescript
  readonly slippageModel: object;
  /** 035 (realism) — funding cost model. Optional: absent ⇒ no funding accrual (default path unchanged). */
  readonly fundingModel?: object;
  readonly latency?: object;
```

- [ ] **Step 3b: Add the model type, catalog, and profile**

In `apps/backtester/src/engine/profiles.ts`, after `SameBarCloseFillModel` (near line 28) add:

```typescript
/** Funding model: per-minute proration of the tape's 8h-equivalent funding rate (035 realism). */
export interface PerMinuteProrateFundingModel {
  readonly kind: 'per_minute_prorate';
  /** Funding interval the tape rate is expressed over (perps: 8h). The per-minute divisor is intervalHours*60. */
  readonly intervalHours: number;
}

/** Closed catalog of supported funding-model kinds (mirror of SUPPORTED_FILL_MODEL_KINDS). */
export const SUPPORTED_FUNDING_MODEL_KINDS = ['per_minute_prorate'] as const;
```

In the same file, after `DEFAULT_EXEC` (near line 77) add:

```typescript
/**
 * `REALISM_EXEC` (035 realism) — honest cost assumptions for analysis. next_bar_open fill, taker-ish fee
 * (5 bps/side), adverse slippage (5 bps), and per-minute-prorated funding on the 8h-equivalent tape rate.
 * Opt-in: it carries `fundingModel`, so a run under it accrues funding; the default path (DEFAULT_EXEC,
 * no fundingModel) stays byte-identical. fee/slippage bps are tunable analysis assumptions.
 */
export const REALISM_EXEC: ExecutionProfile = {
  id: 'realism_exec',
  version: '1.0.0',
  fillModel: { kind: 'next_bar_open' } satisfies NextBarOpenFillModel,
  feeModel: { kind: 'fixed_bps', bps: 5 } satisfies FixedBpsModel,
  slippageModel: { kind: 'fixed_bps', bps: 5 } satisfies FixedBpsModel,
  fundingModel: { kind: 'per_minute_prorate', intervalHours: 8 } satisfies PerMinuteProrateFundingModel,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/backtester/test/funding-engine.test.ts`
Then typecheck the contract change: `pnpm typecheck`
Expected: tests PASS (3); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/research-contracts/src/research/risk-execution.ts apps/backtester/src/engine/profiles.ts apps/backtester/test/funding-engine.test.ts
git commit -m "feat(realism): PerMinuteProrateFundingModel + REALISM_EXEC profile + optional ExecutionProfile.fundingModel"
```

---

## Task 3: ExecutionSimulator funding accessors + guard (`execution.ts`)

**Files:**
- Modify: `apps/backtester/src/engine/execution.ts`
- Test: `apps/backtester/test/funding-engine.test.ts` (extend)

**Interfaces:**
- Consumes: `SUPPORTED_FUNDING_MODEL_KINDS`, `PerMinuteProrateFundingModel` (Task 2).
- Produces (on `ExecutionSimulator`):
  - `fundingEnabled(): boolean` — true ⟺ `profile.fundingModel !== undefined`.
  - `fundingIntervalHours(): number` — the model's `intervalHours` (throws if funding not enabled).

- [ ] **Step 1: Write the failing test**

Append to `apps/backtester/test/funding-engine.test.ts`:

```typescript
import { ExecutionSimulator } from '../src/engine/execution';

describe('ExecutionSimulator — funding accessors + guard', () => {
  it('fundingEnabled() is false for DEFAULT_EXEC, true for REALISM_EXEC', () => {
    expect(new ExecutionSimulator(DEFAULT_EXEC).fundingEnabled()).toBe(false);
    expect(new ExecutionSimulator(REALISM_EXEC).fundingEnabled()).toBe(true);
  });

  it('fundingIntervalHours() returns the model interval (8)', () => {
    expect(new ExecutionSimulator(REALISM_EXEC).fundingIntervalHours()).toBe(8);
  });

  it('rejects an unknown fundingModel.kind (fail-fast, no silent fallback)', () => {
    const bad = { ...REALISM_EXEC, fundingModel: { kind: 'continuous_apr', intervalHours: 8 } };
    expect(() => new ExecutionSimulator(bad)).toThrow(/funding/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/backtester/test/funding-engine.test.ts`
Expected: FAIL — `fundingEnabled` not a function.

- [ ] **Step 3: Implement**

In `apps/backtester/src/engine/execution.ts`:

Add to the imports from `./profiles.js`:
```typescript
import { SUPPORTED_FILL_MODEL_KINDS, SUPPORTED_FUNDING_MODEL_KINDS, type FixedBpsModel, type PerMinuteProrateFundingModel } from './profiles.js';
```

Add a private field and constructor validation (inside the constructor, after the existing fill-kind guard block, before `this.slippageBps = ...`):
```typescript
  private readonly fundingModel: PerMinuteProrateFundingModel | undefined;
```
```typescript
    // 035 (realism): validate optional fundingModel against the closed catalog (fail-fast, no silent fallback).
    const fm = (profile as { fundingModel?: { kind?: unknown } }).fundingModel;
    if (fm !== undefined) {
      const k = fm.kind;
      if (typeof k !== 'string' || !(SUPPORTED_FUNDING_MODEL_KINDS as readonly string[]).includes(k)) {
        throw new Error(`ExecutionSimulator: unsupported fundingModel.kind: ${String(k)}`);
      }
      this.fundingModel = fm as PerMinuteProrateFundingModel;
    } else {
      this.fundingModel = undefined;
    }
```

Add two methods (after `settlesSameBar()`):
```typescript
  /** True when this profile accrues funding (opt-in: a fundingModel is present). */
  fundingEnabled(): boolean {
    return this.fundingModel !== undefined;
  }

  /** Funding interval (hours) the tape rate is expressed over. Throws if funding is not enabled. */
  fundingIntervalHours(): number {
    if (this.fundingModel === undefined) throw new Error('ExecutionSimulator: funding not enabled');
    return this.fundingModel.intervalHours;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/backtester/test/funding-engine.test.ts`
Expected: PASS (6 tests total in file).

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/engine/execution.ts apps/backtester/test/funding-engine.test.ts
git commit -m "feat(realism): ExecutionSimulator.fundingEnabled/fundingIntervalHours + unknown-kind guard"
```

---

## Task 4: `Portfolio.chargeFunding`

**Files:**
- Modify: `apps/backtester/src/engine/portfolio.ts` (after `equityAt`, ~line 115)
- Test: `apps/backtester/test/funding-engine.test.ts` (extend)

**Interfaces:**
- Produces: `Portfolio.chargeFunding(cost: number): void` — `cost > 0` reduces cash (paid), `cost < 0` increases cash (credit). `equityAt` reflects it via cash.

- [ ] **Step 1: Write the failing test**

Append to `apps/backtester/test/funding-engine.test.ts`:

```typescript
import { Portfolio } from '../src/engine/portfolio';

describe('Portfolio.chargeFunding', () => {
  it('positive cost reduces cash; equityAt(flat) reflects it', () => {
    const p = new Portfolio(1000);
    p.chargeFunding(2.5);
    expect(p.cash).toBeCloseTo(997.5, 8);
    expect(p.equityAt(123)).toBeCloseTo(997.5, 8); // flat → equity == cash
  });

  it('negative cost (credit) increases cash', () => {
    const p = new Portfolio(1000);
    p.chargeFunding(-1.25);
    expect(p.cash).toBeCloseTo(1001.25, 8);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/backtester/test/funding-engine.test.ts`
Expected: FAIL — `chargeFunding` not a function.

- [ ] **Step 3: Implement**

In `apps/backtester/src/engine/portfolio.ts`, after the `equityAt` method (line 115):

```typescript
  /**
   * 035 (realism) — charge funding against cash. `cost > 0` = outflow (paid), `cost < 0` = credit (received).
   * Funding is a holding cost on the portfolio, NOT an execution price → it never touches per-trade
   * realizedPnl/feePaid; it surfaces only through cash (and thus `equityAt`). Quantized like other cash flows.
   */
  chargeFunding(cost: number): void {
    this._cash = quantize(new Decimal(this._cash).minus(cost).toNumber());
  }
```

(`Decimal` and `quantize` are already imported in this file.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/backtester/test/funding-engine.test.ts`
Expected: PASS (8 tests total).

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/engine/portfolio.ts apps/backtester/test/funding-engine.test.ts
git commit -m "feat(realism): Portfolio.chargeFunding (cash-only holding cost, outside realizedPnl)"
```

---

## Task 5: Engine accrual in the settle-loop + ledger wiring (`runner.ts`)

**Files:**
- Modify: `apps/backtester/src/engine/runner.ts` (RunAccumulators ~line 123; `runSymbol` signature ~line 298 + loop ~line 451; `runAllSymbols` call ~line 513; result assembly ~line 533)
- Modify: `packages/research-contracts/src/research/*` evidence type — add optional `fundingLedger` + `FundingLedgerEntry`
- Test: `apps/backtester/test/funding-engine.test.ts` (extend — default-path empty ledger)

**Interfaces:**
- Consumes: `computeBarFunding` (Task 1), `exec.fundingEnabled()` / `exec.fundingIntervalHours()` (Task 3), `portfolio.chargeFunding` (Task 4), `marketTape.funding(symbol)` (`MinuteColumn<FundingSnapshot>` with `.at(ts)` / `.covered(ts)`).
- Produces:
  - `FundingLedgerEntry { readonly barIndex: number; readonly ts: number; readonly rate: number; readonly covered: boolean; readonly cost: number }`
  - `RunAccumulators.fundingLedger: FundingLedgerEntry[]`
  - `RunEvidence.fundingLedger?: readonly FundingLedgerEntry[]` (optional; empty on default path)

- [ ] **Step 1: Write the failing test (default-path invariant)**

Append to `apps/backtester/test/funding-engine.test.ts`. This pins the opt-in gate at the type/wiring level without a full run:

```typescript
import type { FundingLedgerEntry } from '../src/engine/runner';

describe('funding ledger wiring', () => {
  it('FundingLedgerEntry shape is exported and structurally usable', () => {
    const e: FundingLedgerEntry = { barIndex: 1, ts: 1781767440000, rate: -0.0002, covered: true, cost: -0.01 };
    expect(e.covered).toBe(true);
    expect(e.cost).toBeLessThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/backtester/test/funding-engine.test.ts`
Expected: FAIL — `FundingLedgerEntry` not exported from runner.

- [ ] **Step 3a: Define the ledger type + accumulator field**

In `apps/backtester/src/engine/runner.ts`, near the top-level types (above `interface RunAccumulators`):

```typescript
/** 035 (realism) — one per-bar funding charge while a position was open (append-only; empty on default path). */
export interface FundingLedgerEntry {
  readonly barIndex: number;
  readonly ts: number;
  readonly rate: number;
  readonly covered: boolean;
  readonly cost: number;
}
```

Add to `interface RunAccumulators` (after `equityCurve`):
```typescript
  readonly fundingLedger: FundingLedgerEntry[];
```

Initialize it in the `acc` literal (near line 484, alongside `equityCurve: []`):
```typescript
    fundingLedger: [],
```

Add the import at the top of the file (with the other engine imports):
```typescript
import { computeBarFunding } from './funding.js';
```

- [ ] **Step 3b: Thread `marketTape` into `runSymbol` and accrue**

Add a `marketTape` parameter to `runSymbol` (it already receives `symbol`, `candles`, `builder`, ..., `acc`). Append the parameter:
```typescript
  acc: RunAccumulators,
  marketTape: MarketTapeDataset | undefined,
): Promise<void> {
```

At the call site in `runAllSymbols` (~line 513) pass it:
```typescript
    await runSymbol(symbol, candles, builder, target.strategy, overlays, portfolio, engine, acc, marketTape);
```

At the top of `runSymbol`, after `const n = candles.length;`, derive the grid step and resolve the funding column once:
```typescript
  const gridMinutes = n > 1 ? (candles[1].ts - candles[0].ts) / 60_000 : 1;
  const fundingCol = exec.fundingEnabled() ? marketTape?.funding(symbol) : undefined;
```

Insert the accrual block between the `same_bar_close` settle (ends line 451) and the equity push (line 454):
```typescript
    // (4.5) 035 (realism) — end-of-bar funding accrual. Opt-in: only when the profile carries a
    // fundingModel. End-of-bar placement ⇒ equityAt(close) already includes this bar's funding (no lag).
    // Correct boundary semantics under next_bar_open: entry bar held full → charged; exit bar held 0 → skipped.
    if (exec.fundingEnabled() && portfolio.position !== null) {
      const pos = portfolio.position;
      const covered = fundingCol?.covered(bar.ts) ?? false;
      const snap = covered ? fundingCol?.at(bar.ts) : undefined;
      const rate = snap !== undefined ? snap.fundingRate : 0;
      const cost = computeBarFunding({
        side: pos.side,
        size: pos.size,
        mark: bar.close,
        rate8h: rate,
        covered,
        barMinutes: gridMinutes,
        intervalHours: exec.fundingIntervalHours(),
      }).toNumber();
      portfolio.chargeFunding(cost);
      acc.fundingLedger.push({ barIndex: t, ts: bar.ts, rate, covered, cost });
    }
```

- [ ] **Step 3c: Expose the ledger on the result evidence**

In the evidence type (find `RunEvidence` in `packages/research-contracts/src/research/*` — same type that declares `equityCurve`), add an optional field. Import/redeclare a minimal `FundingLedgerEntry` shape in the contract OR type it as `readonly object[]` to avoid a backtester→contract dependency:
```typescript
  /** 035 (realism) — per-bar funding charges (empty/absent on the default path). */
  readonly fundingLedger?: readonly { readonly barIndex: number; readonly ts: number; readonly rate: number; readonly covered: boolean; readonly cost: number }[];
```

In `runner.ts` result assembly (the `evidence` object near line 540, after `equityCurve: acc.equityCurve,`):
```typescript
    fundingLedger: acc.fundingLedger,
```

- [ ] **Step 4: Run test + default-path invariant**

Run: `npx vitest run apps/backtester/test/funding-engine.test.ts`
Expected: PASS.

Then the load-bearing golden-invariance gate — run the FULL suite (goldens + demos) and confirm nothing moved:
Run: `pnpm test`
Expected: all green, exact same pass count as `main` (no golden snapshot updated). If any golden moved, STOP — the opt-in gate leaked; verify `DEFAULT_EXEC.fundingModel` is undefined and the accrual block is fully inside the `fundingEnabled()` guard.

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/engine/runner.ts packages/research-contracts/src/research
git commit -m "feat(realism): end-of-bar funding accrual in settle-loop + fundingLedger (default path byte-identical)"
```

---

## Task 6: Replay GAP report + non-circular guard + BEATUSDT anchor

**Files:**
- Modify: `apps/backtester/test/helpers-replay.ts` (add `decomposeRealismDrag`)
- Create: `apps/backtester/scripts/realism-gap-report.mts`
- Create: `apps/backtester/test/realism-gap.test.ts`

**Interfaces:**
- Consumes: `tapeFromRows`, `makeReplayModule`, `PaperTrade` (existing `helpers-replay.ts`); `REALISM_EXEC` (Task 2); `FundingLedgerEntry` + the engine run (Task 5); `computeFundingPaidFraction` is **NOT** used by the test guard (the guard is inline).
- Produces:
  - `decomposeRealismDrag(...)`: per-trade `{ baselinePnlPct, feeDragBps, slippageDragBps, fundingDragBps, realisticPnlPct, gapBps, fundingCoveragePct }`.
  - GAP report artifact (JSON + human table) via the script.

- [ ] **Step 1: Write the failing test (the 4 assertions + 5b anchor)**

Create `apps/backtester/test/realism-gap.test.ts`. The reference fixture is the sub#1 committed slice (`fixtures/exec-validation/long-oi-time-exit.json`) which already holds BEATUSDT rows + the time_exit trade; reuse it.

```typescript
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CanonicalRowV2 } from '@trading/research-contracts/research';
import { type PaperTrade, runRealismLedger } from './helpers-replay.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(HERE, 'fixtures/exec-validation/long-oi-time-exit.json'), 'utf8'),
) as { trades: PaperTrade[]; rowsBySymbol: Record<string, CanonicalRowV2[]> };

const SYMBOL = 'BEATUSDT';
const rows = fixture.rowsBySymbol[SYMBOL];
const trade = fixture.trades.find((t) => t.symbol === SYMBOL && t.closeReason === 'time_exit')!;

describe('realism GAP — funding non-circular guard + sign + 5b anchor', () => {
  it('1) NON-CIRCULAR: engine fundingLedger == inline integral (|Δ| < 1e-10)', async () => {
    const { ledger, size } = await runRealismLedger(SYMBOL, rows, [trade]);
    // Inline recompute — plain arithmetic, NO import of funding.ts (independent of production code).
    // If funding.ts has a wrong divisor/sign/proration, this inline sum diverges from the engine ledger.
    const INTERVAL_MIN = 8 * 60; // 480
    const sign = trade.side === 'long' ? 1 : -1;
    let inline = 0;
    for (const e of ledger) {
      if (!e.covered) {
        expect(e.cost).toBe(0); // uncovered minute must charge exactly 0
        continue;
      }
      const row = rows.find((r) => r.minute_ts === e.ts)!; // mark = close at the funding minute
      inline += (e.rate / INTERVAL_MIN) * (size * row.close) * sign;
    }
    const engineTotal = ledger.reduce((s, e) => s + e.cost, 0);
    expect(Math.abs(engineTotal - inline)).toBeLessThan(1e-10);
  });

  it('3) SIGN-PIN: BEATUSDT long over negative rates → funding is a CREDIT (Σ cost < 0)', async () => {
    const { ledger } = await runRealismLedger(SYMBOL, rows, [trade]);
    const total = ledger.reduce((s, e) => s + e.cost, 0);
    expect(total).toBeLessThan(0); // long + negative rate ⇒ received funding ⇒ cash inflow ⇒ cost < 0
  });

  it('3b) SIGN-PIN (synthetic short): same rates, short side → funding is a COST (Σ cost > 0)', async () => {
    const shortTrade: PaperTrade = { ...trade, side: 'short' };
    const { ledger } = await runRealismLedger(SYMBOL, rows, [shortTrade]);
    const total = ledger.reduce((s, e) => s + e.cost, 0);
    expect(total).toBeGreaterThan(0);
  });

  it('5b) ANCHOR: BEATUSDT time_exit long credit is ~ +0.7..+0.9 bps of notional (order of magnitude)', async () => {
    const { ledger, size } = await runRealismLedger(SYMBOL, rows, [trade]);
    const entryRow = rows.find((r) => r.minute_ts === trade.openedAtMs)!;
    const notional = size * entryRow.close;
    const total = ledger.reduce((s, e) => s + e.cost, 0); // negative = credit
    const creditBps = (-total / notional) * 1e4;
    // AS BUILT: observed creditBps ≈ 2.389 → band pinned [1.8, 3.0] (both sides bounded).
    expect(creditBps).toBeGreaterThan(1.8);
    expect(creditBps).toBeLessThan(3.0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/backtester/test/realism-gap.test.ts`
Expected: FAIL — `runRealismLedger` not exported from `helpers-replay`.

- [ ] **Step 3a: Add `runRealismLedger` to `helpers-replay.ts`**

This runs the existing replay strategy under `REALISM_EXEC` through the real engine and returns the funding ledger + the opened position size. Reuse `tapeFromRows` + `makeReplayModule` already in the file, and the same `runBacktest` entry the sub#1 helper uses (mirror `replayPnlPct`'s wiring; pass `REALISM_EXEC` as the execution profile). Return `{ ledger: FundingLedgerEntry[]; size: number; result }`.

```typescript
import { REALISM_EXEC } from '../src/engine/profiles.js';
import type { FundingLedgerEntry } from '../src/engine/runner.js';

/**
 * Run the recorded trades through the real engine under REALISM_EXEC and surface the funding ledger.
 * Mirrors replayPnlPct's run wiring but binds the realism execution profile (funding ON). `size` is the
 * opened position size (single fill) — used by tests to convert per-bar cash funding into a notional fraction.
 */
export async function runRealismLedger(
  symbol: string,
  rows: CanonicalRowV2[],
  trades: PaperTrade[],
): Promise<{ ledger: FundingLedgerEntry[]; size: number; result: BacktestRunResult }> {
  const tape = tapeFromRows(symbol, rows);
  const module = makeReplayModule(symbol, trades);
  const result = await /* same runBacktest(...) call shape as replayPnlPct, but with executionProfile = REALISM_EXEC */;
  const ledger = (result.evidence.fundingLedger ?? []) as FundingLedgerEntry[];
  const size = result.evidence.simulatedFills.find((f) => f.intent === 'open')?.size ?? 0;
  return { ledger, size, result };
}
```

> Implementer note: copy the exact `runBacktest`/request-construction lines from the existing `replayPnlPct` in this same file (it already builds a `BacktestRunRequest` with the symbol, dataset, risk profile, and an execution profile). Change only the execution profile to `REALISM_EXEC`. Add any missing imports (`BacktestRunResult`) already used by `replayPnlPct`.

- [ ] **Step 3b: Run the failing test again, iterate to green**

Run: `npx vitest run apps/backtester/test/realism-gap.test.ts`
Expected: PASS (4 tests). If the 5b anchor band is off, read the actual `creditBps` from the failure, confirm it is positive and small (sub-2 bps for a ~3h hold), and tighten the band around the observed value, then commit the observed value as the pinned expectation.

- [ ] **Step 3c: Add the GAP report script**

Create `apps/backtester/scripts/realism-gap-report.mts` — model it on `apps/backtester/scripts/validate-execution.mts` (same fixture load + deterministic output, no timestamps/random). For each recorded trade it computes the decomposition and prints a per-trade table + aggregate:

```typescript
// Deterministic realism GAP report: replays recorded trades under REALISM_EXEC and decomposes per-trade
// cost drag (baseline / fee / slippage / funding) in bps. Output is canonical (sorted, no timestamps).
// Run: npx tsx apps/backtester/scripts/realism-gap-report.mts
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRealismLedger } from '../test/helpers-replay.js';
// ...load the same fixture(s); for each trade:
//   baselinePnlPct  = close(exit)/close(entry) − 1, side-aware
//   feeDragBps      = −(open.fee + close.fee)/notional·1e4        (from result.evidence.simulatedFills)
//   slippageDragBps = −(|fillPrice − baseOpen|/baseOpen)·1e4 summed over open+close fills
//   fundingDragBps  = −(Σ ledger.cost)/notional·1e4               (from runRealismLedger)
//   realisticPnlPct = (equity_end − equity_start)/notional        (from result.evidence.equityCurve)
//   gapBps          = (realisticPnlPct − baselinePnlPct)·1e4
//   fundingCoveragePct = covered_minutes/held_minutes
// Print per-trade rows sorted by (symbol, openedAtMs) + an aggregate block (mean gap, decomposed means, N).
```

(Implementer: the numeric helpers above are small; keep them inline in the script. `decomposeRealismDrag` may be factored into `helpers-replay.ts` if both the script and a future test want it — YAGNI until then.)

- [ ] **Step 3d: Run the report (demo artifact)**

Run: `npx tsx apps/backtester/scripts/realism-gap-report.mts`
Expected: a per-trade bps table + aggregate; funding column negative (credit) for the BEATUSDT longs; no crash.

- [ ] **Step 4: Full suite + typecheck**

Run: `pnpm typecheck && pnpm test`
Expected: all green; goldens unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/test/helpers-replay.ts apps/backtester/scripts/realism-gap-report.mts apps/backtester/test/realism-gap.test.ts
git commit -m "feat(realism): replay GAP report + non-circular funding guard + BEATUSDT anchor"
```

---

## Self-Review

**Spec coverage:**
- Funding model (per-minute prorate, 8h-equiv, sign, intervalHours, coverage) → Task 1. ✓
- `fundingModel` opt-in field + `REALISM_EXEC` + closed catalog → Task 2. ✓
- `fundingEnabled` + unknown-kind guard → Task 3. ✓
- `chargeFunding` (cash-only, outside realizedPnl) → Task 4. ✓
- End-of-bar accrual, boundary correctness, default byte-identity, ledger → Task 5. ✓
- Replay GAP report, non-circular inline guard, Identity/sign/cost-direction, 5b BEATUSDT anchor → Task 6. ✓
- Non-goals (USD/sizing, hybrid slippage, default flip, trading-platform) → not implemented (correct). ✓

**Note on assertion mapping:** spec assertion #2 (Identity `realistic == baseline + fee + slip + funding`) and #4 (cost-direction `fee/slip ≤ 0`) are realized in the **GAP report script** decomposition (Task 6, Step 3c) and are exercised by running it; the CI test file pins the load-bearing #1 (non-circular funding) and #3 (sign). If a CI-level Identity guard is wanted, add it to `realism-gap.test.ts` once `decomposeRealismDrag` is factored out — left as a YAGNI follow-up to avoid duplicating the script's math in the test.

**Placeholder scan:** Task 6 Step 3a/3c intentionally reference "the same `runBacktest` call shape as `replayPnlPct`" rather than reproducing ~40 lines of request construction that already exist in the file being modified — the implementer is editing that exact file and can copy the adjacent function. This is a deliberate DRY pointer, not a missing detail.

**Type consistency:** `FundingLedgerEntry` fields (`barIndex/ts/rate/covered/cost`) are identical across Task 5 (definition), the contract evidence field, and Task 6 (consumption). `computeBarFunding` arg shape matches between Task 1 (definition) and Task 5 (call). `fundingEnabled()`/`fundingIntervalHours()` names match between Task 3 and Task 5.
