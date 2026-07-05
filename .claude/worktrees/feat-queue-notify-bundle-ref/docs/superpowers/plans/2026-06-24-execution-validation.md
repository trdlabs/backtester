# Execution/PnL validation (sub#1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate the backtester's execution/PnL math against the platform's paper engine by adding a `same_bar_close` fill model and replaying `long_oi_strategy`'s real `time_exit` trades on the baked 1m slice, matching per-trade `pnlPct`.

**Architecture:** A new opt-in `same_bar_close` fill model settles a decision made at bar t at `close(t)` (the paper engine's convention), vs the existing `next_bar_open`. A trusted "replay" strategy module emits enter/exit at the recorded trade minutes; a comparison harness builds a `MarketTapeDataset` from the slice's per-minute `CanonicalRowV2` rows, runs the replay with fees+slippage = 0, and asserts the backtester `pnlPct` equals the paper `pnlPct` for clean-close trades.

**Tech Stack:** TypeScript (strict, ESM `.js` extensions), Node ≥22, Vitest, pnpm, decimal.js (engine money math).

## Global Constraints

- ESM imports MUST use the `.js` extension on relative paths.
- Goldens MUST NOT move: momentum `sha256:eff10116147933c96d92ae50071ef66339467fb69545c38855dcd50c2c0b43ba` + overlay goldens. The new fill model is opt-in (default profile stays `next_bar_open`); existing tests are unaffected.
- Paper engine convention (the reference to match): fills at the **1m `close`**, **fee = 0, slippage = 0, no funding**. So the validation runs with `executionProfile = { fillModel: same_bar_close, feeModel: {fixed_bps, bps:0}, slippageModel: {fixed_bps, bps:0} }`.
- `same_bar_close` MUST NOT look ahead: a fill at `close(t)` for a decision made in `onBarClose(t)` is causal (the close drove the decision).
- Inclusion rule for validated trades: `closeReason === 'time_exit'` AND both `openedAtMs`/`closedAtMs` within the symbol's 1m row coverage. All other `closeReason` (`tp*`/`*_stop`/`hard_stop`/…) are excluded + logged (never silently dropped).
- Success metric is **`pnlPct`** (price PnL): for a long trade, `pnlPct = (exitFillPrice − entryFillPrice)/entryFillPrice × 100`. USD/realizedPnl + sizing are sub#2 (the trade log has no qty).
- Reference slice: `../trading-mock-platform/data/snapshots/fixtures/2026-06-18-real-all/ops/bundle.json` (sibling repo). `historical.rowsBySymbol[symbol]` = `CanonicalRowV2[]` (`minute_ts` step 60_000ms). `tradesByRun[runId]` = `{tradeId,symbol,side,openedAtMs,closedAtMs,realizedPnl,pnlPct,isWin,closeReason}`.
- Run `pnpm typecheck` and `pnpm test` from the repo root.

---

## File Structure

- **Modify** `apps/backtester/src/engine/profiles.ts` — add `SameBarCloseFillModel` + `'same_bar_close'` to `SUPPORTED_FILL_MODEL_KINDS`.
- **Modify** `apps/backtester/src/engine/execution.ts` — `ExecutionSimulator.settlesSameBar()`.
- **Modify** `apps/backtester/src/engine/runner.ts` — `settlePending` takes a `fillBase` price; runner settles `same_bar_close` pendings at `close(t)` within the same bar.
- **Create** `apps/backtester/test/same-bar-close.test.ts` — engine unit test.
- **Create** `apps/backtester/test/helpers-replay.ts` — replay strategy module factory + `tapeFromRows` loader (shared by the CI test and the harness).
- **Create** `apps/backtester/test/fixtures/exec-validation/long-oi-time-exit.json` — small committed fixture (a few `time_exit` trades + their 1m rows, trimmed from the slice).
- **Create** `apps/backtester/scripts/extract-validation-fixture.mts` — one-off extractor that writes the fixture from the slice.
- **Create** `apps/backtester/test/exec-validation.test.ts` — CI reconciliation test over the committed fixture.
- **Create** `apps/backtester/scripts/validate-execution.mts` — full-slice manual harness (coverage report).

---

## Task 1: `same_bar_close` fill model (engine)

**Files:**
- Modify: `apps/backtester/src/engine/profiles.ts`
- Modify: `apps/backtester/src/engine/execution.ts`
- Modify: `apps/backtester/src/engine/runner.ts`
- Test: `apps/backtester/test/same-bar-close.test.ts`

**Interfaces:**
- Produces: `ExecutionSimulator.settlesSameBar(): boolean`; `executionProfile.fillModel.kind === 'same_bar_close'` accepted; a decision at bar t fills at `close(t)`.

- [ ] **Step 1: Write the failing test**

Create `apps/backtester/test/same-bar-close.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { runBacktest } from '../src/engine/runner.js';
import { marketTapeFromCanonicalRows } from '../src/engine/market-tape.js';
import { createTrustedRouter } from '../src/engine/module-executor.js';
import { createModuleRegistry } from '../src/engine/sandbox/routing.js';
import { DEFAULT_RISK } from '../src/engine/profiles.js';
import { shortAfterPump } from '../src/engine/examples/short-after-pump.strategy.js';
import type { BacktestRunRequest, ExecutionProfile, StrategyModule, CanonicalRowV2 } from '@trading/research-contracts';

// Five 1m bars; a strategy enters long on bar index 1 (close 115) and exits on bar index 3 (close 135).
const TS0 = 1_781_740_800_000;
const rows: CanonicalRowV2[] = [100, 110, 120, 130, 140].map((px, i) => ({
  schema_version: 2, minute_ts: TS0 + i * 60_000, symbol: 'TST',
  open: px, high: px + 1, low: px - 1, close: px + 5, volume: 1000,
} as unknown as CanonicalRowV2));

// Base the manifest on a known-valid 017 strategy manifest (paramsSchema/contractVersion/etc.), overriding
// only id/version/name/hooks — a hand-built minimal manifest fails 017 module validation in runBacktest.
const replayMod: StrategyModule = {
  manifest: { ...shortAfterPump.manifest, id: 'replay', version: '1.0.0', name: 'replay', hooks: ['onBarClose', 'onPositionBar'] },
  onBarClose: (ctx) => (ctx.bar.ts === TS0 + 1 * 60_000 ? { kind: 'enter', side: 'long' } : { kind: 'idle' }),
  onPositionBar: (ctx) => (ctx.bar.ts === TS0 + 3 * 60_000 ? { kind: 'exit', target: 'replay' } : { kind: 'idle' }),
} as unknown as StrategyModule;

const SAME_BAR_EXEC: ExecutionProfile = {
  id: 'same_bar', version: '1.0.0',
  fillModel: { kind: 'same_bar_close' } as never,
  feeModel: { kind: 'fixed_bps', bps: 0 }, slippageModel: { kind: 'fixed_bps', bps: 0 },
};

const req: BacktestRunRequest = {
  runId: 'sbc-1', mode: 'research', moduleRef: { id: 'replay', version: '1.0.0' },
  datasetRef: 'tst', symbols: ['TST'], timeframe: '1m',
  period: { from: new Date(TS0).toISOString(), to: new Date(TS0 + 5 * 60_000).toISOString() },
  riskProfileRef: { id: 'default_risk', version: '1.0.0' },
  executionProfileRef: { id: 'same_bar', version: '1.0.0' }, seed: 1, metrics: [],
} as unknown as BacktestRunRequest;

describe('same_bar_close fill model', () => {
  it('fills enter/exit at the decision bar close', async () => {
    const built = marketTapeFromCanonicalRows('tst', '1m', rows);
    if (!built.ok) throw new Error(built.detail);
    const registry = createModuleRegistry({ strategies: [replayMod], riskProfiles: [DEFAULT_RISK], executionProfiles: [SAME_BAR_EXEC] });
    const out = await runBacktest(req, { registry, marketTape: built.tape, router: createTrustedRouter() });
    expect(out.status).toBe('completed');
    if (out.status !== 'completed') return;
    const trades = out.baseline.trades;
    expect(trades.length).toBe(1);
    expect(trades[0].entryFillPrice).toBe(115); // close of bar index 1
    expect(trades[0].exitFillPrice).toBe(135);  // close of bar index 3
    const pnlPct = (trades[0].exitFillPrice - trades[0].entryFillPrice) / trades[0].entryFillPrice * 100;
    expect(pnlPct).toBeCloseTo((135 - 115) / 115 * 100, 9);
  });
});
```

Grounded facts this uses (verified): `marketTapeFromCanonicalRows(datasetRef, timeframe, rows)` returns `TapeBuildResult = {ok:true, tape: MarketTapeDataset} | {ok:false, reason, detail}` (so guard `.ok`, use `.tape`). `createModuleRegistry({strategies, riskProfiles, executionProfiles})` (`engine/sandbox/routing.js`) returns a registry `runBacktest` accepts (the overlay path uses it). A valid 017 strategy manifest carries `id/version/kind/name/summary/rationale/author/contractVersion/status/paramsSchema/params/capabilities/dataNeeds/hooks` — hence spreading `shortAfterPump.manifest`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run apps/backtester/test/same-bar-close.test.ts`
Expected: FAIL — `runBacktest` pre-flight rejects `fillModel.kind: 'same_bar_close'` as `unsupported_fill_model_kind` (so `out.status !== 'completed'`).

- [ ] **Step 3: Add the fill model to the catalog**

In `apps/backtester/src/engine/profiles.ts`, after `NextBarOpenFillModel`:

```ts
/** Fill at the close of the decision bar (same bar as onBarClose). */
export interface SameBarCloseFillModel {
  readonly kind: 'same_bar_close';
}
```

and extend the catalog:

```ts
export const SUPPORTED_FILL_MODEL_KINDS = ['next_bar_open', 'same_bar_close'] as const;
```

- [ ] **Step 4: Add `settlesSameBar()` to `ExecutionSimulator`**

In `apps/backtester/src/engine/execution.ts`, store the fill kind and expose the predicate. In the constructor (after the existing `fillKind` validation that throws on unsupported), add a field assignment; add the field + method to the class:

```ts
  private readonly slippageBps: number;
  private readonly feeBps: number;
  private readonly fillKind: string;

  constructor(private readonly profile: ExecutionProfile) {
    const fillKind = (profile.fillModel as { kind?: unknown }).kind;
    if (typeof fillKind !== 'string' || !(SUPPORTED_FILL_MODEL_KINDS as readonly string[]).includes(fillKind)) {
      throw new Error(`ExecutionSimulator: unsupported fillModel.kind: ${String(fillKind)}`);
    }
    this.fillKind = fillKind;
    this.slippageBps = bpsOf(profile.slippageModel);
    this.feeBps = bpsOf(profile.feeModel);
  }

  /** True when fills settle at the decision bar's close (vs deferring to next bar open). */
  settlesSameBar(): boolean {
    return this.fillKind === 'same_bar_close';
  }
```

- [ ] **Step 5: Parameterize `settlePending` with the fill base price**

In `apps/backtester/src/engine/runner.ts`, change the `settlePending` signature to accept the fill base price, and replace every `bar.open` inside it with `fillBase`:

```ts
function settlePending(
  bar: Readonly<Bar>,
  barIndex: number,
  portfolio: Portfolio,
  exec: ExecutionSimulator,
  acc: RunAccumulators,
  fillBase: number,
): void {
  // ... body UNCHANGED except: the three `exec.computeOpenFill(... bar.open ...)` /
  //     `exec.computeCloseFill(... bar.open ...)` calls now pass `fillBase` instead of `bar.open`.
}
```

Concretely, the three call sites inside `settlePending` become:
- open: `exec.computeOpenFill(pending.side, fillBase, pending.sizingPct ?? 1, portfolio.cash)`
- add: `exec.computeOpenFill(pending.side, fillBase, pending.sizingPct ?? 1, portfolio.cash)`
- close: `exec.computeCloseFill(pending.side, fillBase, closedSize)`

- [ ] **Step 6: Update the existing (next_bar_open) settle call + add the same-bar settle**

In `runSymbol`, the existing settle of a t−1 pending at the START of bar t passes `bar.open`:

```ts
    if (portfolio.pending !== null && portfolio.pending.decisionBarIndex === t - 1) {
      settlePending(bar, t, portfolio, exec, acc, bar.open);
    }
```

Then, immediately BEFORE the `// (5) EquityPoint` line `acc.equityCurve.push({ barIndex: t, ... })`, add the same-bar settle:

```ts
    // same_bar_close: settle a pending placed THIS bar at close(t) — no cross-bar deferral, no look-ahead.
    if (exec.settlesSameBar() && portfolio.pending !== null && portfolio.pending.decisionBarIndex === t) {
      settlePending(bar, t, portfolio, exec, acc, bar.close);
    }
```

(`exec` is already destructured in `runSymbol` via `const { router, risk, exec, composer } = engine;`.)

- [ ] **Step 7: Run the unit test + goldens**

Run: `pnpm exec vitest run apps/backtester/test/same-bar-close.test.ts apps/backtester/test/overlay-golden.test.ts apps/backtester/test/determinism.test.ts`
Expected: same-bar-close PASS (entry 115 / exit 135); goldens unchanged. Then `pnpm typecheck` clean.

- [ ] **Step 8: Commit**

```bash
git add apps/backtester/src/engine/profiles.ts apps/backtester/src/engine/execution.ts apps/backtester/src/engine/runner.ts apps/backtester/test/same-bar-close.test.ts
git commit -m "feat(engine): same_bar_close fill model (fills at the decision bar close)"
```

---

## Task 2: Replay module + rows loader + CI reconciliation test

**Files:**
- Create: `apps/backtester/test/helpers-replay.ts`
- Create: `apps/backtester/scripts/extract-validation-fixture.mts`
- Create: `apps/backtester/test/fixtures/exec-validation/long-oi-time-exit.json`
- Test: `apps/backtester/test/exec-validation.test.ts`

**Interfaces:**
- Consumes: `same_bar_close` (Task 1); `marketTapeFromCanonicalRows(datasetRef, timeframe, rows)`; `runBacktest`; `createTrustedRouter`.
- Produces:
  - `tapeFromRows(symbol: string, rows: CanonicalRowV2[]): MarketTapeDataset`
  - `makeReplayModule(symbol: string, trades: PaperTrade[]): StrategyModule` — enters long at `openedAtMs`, exits at `closedAtMs`.
  - `replayPnlPct(symbol, rows, trades): { tradeId: string; backtestPnlPct: number; paperPnlPct: number }[]`
  - `type PaperTrade = { tradeId: string; symbol: string; openedAtMs: number; closedAtMs: number; pnlPct: string; closeReason: string }`

- [ ] **Step 1: Write the extractor and generate the committed fixture**

Create `apps/backtester/scripts/extract-validation-fixture.mts` — reads the slice, picks up to 3 symbols that each have ≥1 `time_exit` trade fully inside their 1m row coverage, and writes `{ trades, rowsBySymbol }` trimmed to those symbols:

```ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SLICE = process.env.SLICE_PATH ?? resolve(HERE, '../../../../trading-mock-platform/data/snapshots/fixtures/2026-06-18-real-all/ops/bundle.json');
const OUT = resolve(HERE, '../test/fixtures/exec-validation/long-oi-time-exit.json');

const b = JSON.parse(readFileSync(SLICE, 'utf8'));
const rowsBySymbol = b.historical.rowsBySymbol as Record<string, { minute_ts: number }[]>;
const allTrades = Object.values(b.tradesByRun as Record<string, any[]>).flat();

const inCoverage = (t: any) => {
  const rows = rowsBySymbol[t.symbol];
  if (!rows?.length) return false;
  return t.openedAtMs >= rows[0].minute_ts && t.closedAtMs <= rows[rows.length - 1].minute_ts;
};
const cleanTimeExit = allTrades.filter((t) => t.closeReason === 'time_exit' && inCoverage(t));
const picked: string[] = [];
for (const t of cleanTimeExit) { if (picked.length < 3 && !picked.includes(t.symbol)) picked.push(t.symbol); }
const trades = cleanTimeExit.filter((t) => picked.includes(t.symbol)).map((t) => ({
  tradeId: t.tradeId, symbol: t.symbol, openedAtMs: t.openedAtMs, closedAtMs: t.closedAtMs,
  pnlPct: String(t.pnlPct), closeReason: t.closeReason,
}));
const rows = Object.fromEntries(picked.map((s) => [s, rowsBySymbol[s]]));
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ trades, rowsBySymbol: rows }, null, 0));
console.log(`wrote ${OUT}: ${trades.length} trades, ${picked.length} symbols (${picked.join(',')})`);
```

Run it once to generate the fixture:
`pnpm exec tsx apps/backtester/scripts/extract-validation-fixture.mts`
Expected: writes the fixture with ≥1 trade. If it reports 0 trades, widen the picked-symbol cap or confirm the slice path; do NOT hand-write the fixture.

- [ ] **Step 2: Write the failing test**

Create `apps/backtester/test/exec-validation.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayPnlPct, type PaperTrade } from './helpers-replay.js';
import type { CanonicalRowV2 } from '@trading/research-contracts';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(resolve(HERE, 'fixtures/exec-validation/long-oi-time-exit.json'), 'utf8')) as {
  trades: PaperTrade[]; rowsBySymbol: Record<string, CanonicalRowV2[]>;
};

describe('execution validation — backtester reproduces paper pnlPct on time_exit trades', () => {
  it('per-trade backtest pnlPct equals paper pnlPct', async () => {
    expect(fixture.trades.length).toBeGreaterThan(0);
    for (const sym of Object.keys(fixture.rowsBySymbol)) {
      const symTrades = fixture.trades.filter((t) => t.symbol === sym);
      if (symTrades.length === 0) continue;
      const results = await replayPnlPct(sym, fixture.rowsBySymbol[sym], symTrades);
      for (const r of results) {
        expect(r.backtestPnlPct).toBeCloseTo(r.paperPnlPct, 4); // pure close-to-close, no costs → exact
      }
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm exec vitest run apps/backtester/test/exec-validation.test.ts`
Expected: FAIL — `./helpers-replay.js` / `replayPnlPct` not found.

- [ ] **Step 4: Implement `helpers-replay.ts`**

Create `apps/backtester/test/helpers-replay.ts`:

```ts
import { runBacktest } from '../src/engine/runner.js';
import { marketTapeFromCanonicalRows } from '../src/engine/market-tape.js';
import { createTrustedRouter } from '../src/engine/module-executor.js';
import { createModuleRegistry } from '../src/engine/sandbox/routing.js';
import { DEFAULT_RISK } from '../src/engine/profiles.js';
import { shortAfterPump } from '../src/engine/examples/short-after-pump.strategy.js';
import type { BacktestRunRequest, ExecutionProfile, MarketTapeDataset, StrategyModule, CanonicalRowV2 } from '@trading/research-contracts';

export type PaperTrade = {
  tradeId: string; symbol: string; openedAtMs: number; closedAtMs: number; pnlPct: string; closeReason: string;
};

const SAME_BAR_NO_COST: ExecutionProfile = {
  id: 'paper_match', version: '1.0.0',
  fillModel: { kind: 'same_bar_close' } as never,
  feeModel: { kind: 'fixed_bps', bps: 0 }, slippageModel: { kind: 'fixed_bps', bps: 0 },
};

export function tapeFromRows(symbol: string, rows: CanonicalRowV2[]): MarketTapeDataset {
  const built = marketTapeFromCanonicalRows(symbol, '1m', rows);
  if (!built.ok) throw new Error(`tape build failed for ${symbol}: ${built.detail}`);
  return built.tape;
}

/** Replay strategy: enter long at each trade's openedAtMs, exit at its closedAtMs (single position at a time).
 *  Manifest is based on a known-valid 017 strategy manifest (shortAfterPump) — id/version/name/hooks overridden. */
export function makeReplayModule(symbol: string, trades: PaperTrade[]): StrategyModule {
  const opens = new Set(trades.map((t) => t.openedAtMs));
  const closes = new Set(trades.map((t) => t.closedAtMs));
  return {
    manifest: { ...shortAfterPump.manifest, id: `replay-${symbol}`, version: '1.0.0', name: `replay-${symbol}`, hooks: ['onBarClose', 'onPositionBar'] },
    onBarClose: (ctx) => (opens.has(ctx.bar.ts) ? { kind: 'enter', side: 'long' } : { kind: 'idle' }),
    onPositionBar: (ctx) => (closes.has(ctx.bar.ts) ? { kind: 'exit', target: 'replay' } : { kind: 'idle' }),
  } as unknown as StrategyModule;
}

export async function replayPnlPct(symbol: string, rows: CanonicalRowV2[], trades: PaperTrade[]): Promise<
  { tradeId: string; backtestPnlPct: number; paperPnlPct: number }[]
> {
  const tape = tapeFromRows(symbol, rows);
  const mod = makeReplayModule(symbol, trades);
  const registry = createModuleRegistry({ strategies: [mod], riskProfiles: [DEFAULT_RISK], executionProfiles: [SAME_BAR_NO_COST] });
  const req = {
    runId: `replay-${symbol}`, mode: 'research', moduleRef: { id: mod.manifest.id, version: '1.0.0' },
    datasetRef: symbol, symbols: [symbol], timeframe: '1m',
    period: { from: new Date(rows[0].minute_ts).toISOString(), to: new Date(rows[rows.length - 1].minute_ts + 60_000).toISOString() },
    riskProfileRef: { id: 'default_risk', version: '1.0.0' },
    executionProfileRef: { id: 'paper_match', version: '1.0.0' }, seed: 1, metrics: [],
  } as unknown as BacktestRunRequest;
  const out = await runBacktest(req, { registry, marketTape: tape, router: createTrustedRouter() });
  if (out.status !== 'completed') throw new Error(`replay not completed: ${JSON.stringify('validation' in out ? out.validation : out)}`);
  const byOpen = new Map(trades.map((t) => [t.openedAtMs, t]));
  return out.baseline.trades.map((bt) => {
    const paper = byOpen.get(bt.entryTs);
    return {
      tradeId: paper?.tradeId ?? `bt-${bt.entryTs}`,
      backtestPnlPct: (bt.exitFillPrice - bt.entryFillPrice) / bt.entryFillPrice * 100,
      paperPnlPct: paper ? Number(paper.pnlPct) : NaN,
    };
  });
}
```

`replayPnlPct` is `async` (runBacktest is async). Step 2's test already `await`s it and uses an `async` `it`.

- [ ] **Step 5: Run the test**

Run: `pnpm exec vitest run apps/backtester/test/exec-validation.test.ts`
Expected: PASS — every fixture `time_exit` trade's backtest `pnlPct` ≈ paper `pnlPct` (4 decimals). If a trade is off, the residual reveals a fill-convention or row-coverage issue — investigate (do NOT loosen the tolerance to hide it).

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm typecheck`

```bash
git add apps/backtester/test/helpers-replay.ts apps/backtester/scripts/extract-validation-fixture.mts apps/backtester/test/fixtures/exec-validation/long-oi-time-exit.json apps/backtester/test/exec-validation.test.ts
git commit -m "test(validation): replay long_oi time_exit trades, backtest pnlPct == paper"
```

---

## Task 3: Full-slice manual harness (coverage report)

**Files:**
- Create: `apps/backtester/scripts/validate-execution.mts`

**Interfaces:**
- Consumes: `replayPnlPct`, `PaperTrade` from `../test/helpers-replay.js`.

- [ ] **Step 1: Write the harness**

Create `apps/backtester/scripts/validate-execution.mts` — runs the replay over the WHOLE slice and prints a coverage report (matched / mismatched / excluded), data-gated on the slice path:

```ts
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayPnlPct, type PaperTrade } from '../test/helpers-replay.js';
import type { CanonicalRowV2 } from '@trading/research-contracts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SLICE = process.env.SLICE_PATH ?? resolve(HERE, '../../../../trading-mock-platform/data/snapshots/fixtures/2026-06-18-real-all/ops/bundle.json');
const TOL = Number(process.env.PNL_TOL ?? 1e-4);

async function main() {
  const b = JSON.parse(readFileSync(SLICE, 'utf8'));
  const rowsBySymbol = b.historical.rowsBySymbol as Record<string, CanonicalRowV2[]>;
  const allTrades: PaperTrade[] = Object.values(b.tradesByRun as Record<string, any[]>).flat();

  const inCov = (t: PaperTrade) => {
    const r = rowsBySymbol[t.symbol];
    return r?.length && t.openedAtMs >= r[0].minute_ts && t.closedAtMs <= r[r.length - 1].minute_ts;
  };
  const scope = allTrades.filter((t) => t.closeReason === 'time_exit' && inCov(t));
  const excluded = allTrades.filter((t) => !(t.closeReason === 'time_exit' && inCov(t)));

  let matched = 0; const misses: string[] = [];
  for (const sym of new Set(scope.map((t) => t.symbol))) {
    const symTrades = scope.filter((t) => t.symbol === sym);
    const results = await replayPnlPct(sym, rowsBySymbol[sym], symTrades);
    for (const r of results) {
      if (Math.abs(r.backtestPnlPct - r.paperPnlPct) <= TOL) matched += 1;
      else misses.push(`${sym} ${r.tradeId}: backtest=${r.backtestPnlPct.toFixed(4)} paper=${r.paperPnlPct.toFixed(4)}`);
    }
  }
  console.log('\n============== EXECUTION VALIDATION (paper engine, time_exit) ==============');
  console.log(`in-scope time_exit trades: ${scope.length}  | matched (<=${TOL}): ${matched}  | mismatched: ${misses.length}`);
  for (const m of misses) console.log('  MISS ', m);
  const byReason: Record<string, number> = {};
  for (const t of excluded) byReason[t.closeReason] = (byReason[t.closeReason] ?? 0) + 1;
  console.log(`EXCLUDED ${excluded.length} (trigger-close / out-of-coverage):`, JSON.stringify(byReason));
  console.log('=============================================================================');
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run the harness (data-gated)**

Run: `pnpm exec tsx apps/backtester/scripts/validate-execution.mts`
Expected: prints the report; in-scope `time_exit` trades all matched (mismatched = 0); EXCLUDED lists the trigger-close reasons (`tp2`/`be_stop`/`hard_stop`/…). If the slice path is absent, the script errors clearly (acceptable — it is a manual harness, not CI).

- [ ] **Step 3: Commit**

```bash
git add apps/backtester/scripts/validate-execution.mts
git commit -m "test(validation): full-slice execution-validation harness (coverage report)"
```

---

## Self-Review

**Spec coverage:**
- `same_bar_close` fill model (spec §1) → Task 1. ✅
- Data ingestion from `rowsBySymbol` (spec §2) → Task 2 `tapeFromRows` (`marketTapeFromCanonicalRows`). ✅
- Trade-replay driver (spec §3) → Task 2 `makeReplayModule` (onBarClose enter / onPositionBar exit). ✅
- Comparison + `pnlPct` success metric (spec §4) → Task 2 (CI fixture) + Task 3 (full report). ✅
- Inclusion rule `closeReason==='time_exit'` + coverage; excluded logged (spec §4) → Task 2 extractor + Task 3 report. ✅
- Exclusions: TP/SL→sub#2, USD/sizing→sub#2, funding not modeled (spec §5) → out of scope; report logs excluded. ✅
- Testing: same_bar_close unit, CI reconciliation on committed fixture, manual full-slice harness, goldens unmoved (spec Testing) → Tasks 1/2/3 + Task 1 Step 7. ✅

**Placeholder scan:** Code shown for every step. Two adaptation notes (Task 1 Step 1 `.dataset` accessor / request-shape; Task 2 Step 5 await) name the exact file to mirror and the exact one-line change — not vague TODOs.

**Type consistency:** `settlesSameBar()`, `settlePending(..., fillBase)`, `SUPPORTED_FILL_MODEL_KINDS`, `marketTapeFromCanonicalRows(datasetRef, timeframe, rows).dataset`, `Trade.entry/exitFillPrice`, `EnterDecision{kind:'enter',side}`, `ExitDecision{kind:'exit',target}`, `PaperTrade`, `replayPnlPct`/`makeReplayModule`/`tapeFromRows` are used identically across tasks.
