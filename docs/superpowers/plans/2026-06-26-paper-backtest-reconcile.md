# Paper↔backtest trade-reconciliation harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pure, strategy-agnostic `reconcileTrades` harness + report that pairs paper-recorded trades with backtester-produced trades and classifies each (matched / engine_divergent / data_divergent / paper_only / backtest_only / ambiguous).

**Architecture:** A pure core (`helpers-reconcile.ts`) groups two `NormalizedTrade[]` lists by `symbol|entryTs|side`, classifies pairs, and splits divergences into data-vs-engine via an independent close-to-close from `CanonicalRowV2` rows. Tested first with synthetic fixtures (every taxonomy path + the normalizer contract), then end-to-end against sub#1's replay routed through the real engine.

**Tech Stack:** TypeScript (ESM), Vitest. Package: `apps/backtester`. Spec: `docs/superpowers/specs/2026-06-26-paper-backtest-reconcile-design.md`.

## Global Constraints

- **pnlPct only** (no USD/realizedPnl reconciliation — sub#2b).
- **Match criterion:** pairs by `${symbol}|${openedAtMs}|${side}`; `matched` iff exit minute equal AND closeReason equal AND `|ΔpnlPct| ≤ pnlPctTol` (default `1e-3`).
- **Taxonomy:** `matched | engine_divergent | data_divergent | paper_only | backtest_only | ambiguous`.
- **Conservative data-vs-engine split:** a divergent pair is `engine_divergent` ONLY if an independent close-to-close from the rows reproduces paper's pnlPct within tol. If rows for the entry or exit minute are absent, OR the close-to-close does not reproduce paper → `data_divergent`. Missing data is NEVER `engine_divergent`.
- **Non-circular anchor:** the data-vs-engine classifier reads `CanonicalRowV2` rows, NEVER the engine output.
- **Normalizer contract (load-bearing):** `engineTradeToNormalized` computes `pnlPct` from `entry/exitFillPrice` side-aware (long `(exit−entry)/entry·100`, short `(entry−exit)/entry·100`) — NEVER from `trade.realizedPnl` (USD/leverage-dependent). Asserted by a unit test.
- **`ambiguous` is a hard `assertEmpty`** on real snapshot data (a non-empty class is a corrupt-data signal), not just a counter.
- **No change to the engine, sub#1's `helpers-replay.ts`, or the realism work.** New files only.
- **Deterministic report** (sorted, no timestamps/random).
- **Run a single test file:** `npx vitest run apps/backtester/test/reconcile.test.ts`. Full suite: `pnpm test`.
- **Branch:** `feat/trade-reconcile` (already created; spec committed). Commit per task.

---

## File Structure

- `apps/backtester/test/helpers-reconcile.ts` — **NEW.** Pure core: types, `tradeKey`, `paperToNormalized`, `engineTradeToNormalized`, `closeToClosePnlPct`, `reconcileTrades`; plus `makeReconcileReplayModule` (a replay strategy that exits carrying the paper trade's `closeReason`).
- `apps/backtester/test/reconcile.test.ts` — **NEW.** Synthetic unit tests (all taxonomy + normalizer contract) and the real end-to-end self-test.
- `apps/backtester/scripts/reconcile-report.mts` — **NEW.** Deterministic reconciliation report.

---

## Task 1: Pure reconcile core + synthetic coverage

**Files:**
- Create: `apps/backtester/test/helpers-reconcile.ts`
- Test: `apps/backtester/test/reconcile.test.ts` (synthetic portion)

**Interfaces:**
- Consumes: `CanonicalRowV2` (`@trading/research-contracts/research`), `Trade` (`../src/engine/artifacts.js`), `PaperTrade` (`./helpers-replay.js`).
- Produces: `NormalizedTrade`, `ReconcileStatus`, `ReconcileRow`, `ReconcileSummary`, `ReconcileResult`; `tradeKey`, `paperToNormalized`, `engineTradeToNormalized(t: Trade)`, `closeToClosePnlPct(rows, entryTs, exitTs, side)`, `reconcileTrades(args)`.

- [ ] **Step 1: Write the failing synthetic tests**

Create `apps/backtester/test/reconcile.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import type { CanonicalRowV2 } from '@trading/research-contracts/research';
import {
  closeToClosePnlPct,
  engineTradeToNormalized,
  reconcileTrades,
  type NormalizedTrade,
} from './helpers-reconcile.js';

const N = (o: Partial<NormalizedTrade> & { symbol: string; side: 'long' | 'short'; entryTs: number; exitTs: number; closeReason: string; pnlPct: number }): NormalizedTrade => o;

// minimal rows: two minutes whose closes reproduce a chosen long pnlPct
const rowsFor = (symbol: string, entryTs: number, exitTs: number, entryClose: number, exitClose: number): Record<string, CanonicalRowV2[]> => ({
  [symbol]: [
    { minute_ts: entryTs, close: entryClose } as unknown as CanonicalRowV2,
    { minute_ts: exitTs, close: exitClose } as unknown as CanonicalRowV2,
  ],
});

describe('reconcileTrades — taxonomy', () => {
  it('matched: exitTs + closeReason + pnlPct all within tol', () => {
    const paper = [N({ symbol: 'AAA', side: 'long', entryTs: 1, exitTs: 2, closeReason: 'tp2', pnlPct: 5 })];
    const backtest = [N({ symbol: 'AAA', side: 'long', entryTs: 1, exitTs: 2, closeReason: 'tp2', pnlPct: 5.0005 })];
    const r = reconcileTrades({ paper, backtest, rows: {}, pnlPctTol: 1e-3 });
    expect(r.rows[0].status).toBe('matched');
    expect(r.summary.matched).toBe(1);
    expect(r.summary.matchRate).toBe(1);
  });

  it('engine_divergent: pnlPct differs AND rows reproduce paper', () => {
    // paper long +5% (close 100→105); backtest says +2% → engine/strategy wrong, data is fine
    const paper = [N({ symbol: 'AAA', side: 'long', entryTs: 1, exitTs: 2, closeReason: 'tp2', pnlPct: 5 })];
    const backtest = [N({ symbol: 'AAA', side: 'long', entryTs: 1, exitTs: 2, closeReason: 'tp2', pnlPct: 2 })];
    const r = reconcileTrades({ paper, backtest, rows: rowsFor('AAA', 1, 2, 100, 105), pnlPctTol: 1e-3 });
    expect(r.rows[0].status).toBe('engine_divergent');
    expect(r.summary.engineDivergent).toBe(1);
  });

  it('data_divergent: pnlPct differs AND rows do NOT reproduce paper', () => {
    // paper +5% but rows say -1.76% (close 100→98.24) → data issue, not engine
    const paper = [N({ symbol: 'AAA', side: 'long', entryTs: 1, exitTs: 2, closeReason: 'time_exit', pnlPct: 5 })];
    const backtest = [N({ symbol: 'AAA', side: 'long', entryTs: 1, exitTs: 2, closeReason: 'time_exit', pnlPct: -1.76 })];
    const r = reconcileTrades({ paper, backtest, rows: rowsFor('AAA', 1, 2, 100, 98.24), pnlPctTol: 1e-3 });
    expect(r.rows[0].status).toBe('data_divergent');
    expect(r.summary.dataDivergent).toBe(1);
  });

  it('data_divergent (conservative): divergent but rows missing for the minute', () => {
    const paper = [N({ symbol: 'AAA', side: 'long', entryTs: 1, exitTs: 2, closeReason: 'tp2', pnlPct: 5 })];
    const backtest = [N({ symbol: 'AAA', side: 'long', entryTs: 1, exitTs: 2, closeReason: 'tp2', pnlPct: 2 })];
    const r = reconcileTrades({ paper, backtest, rows: {}, pnlPctTol: 1e-3 }); // no rows → cannot blame engine
    expect(r.rows[0].status).toBe('data_divergent');
    expect(r.rows[0].note).toMatch(/rows missing/i);
  });

  it('paper_only and backtest_only', () => {
    const paper = [N({ symbol: 'AAA', side: 'long', entryTs: 1, exitTs: 2, closeReason: 'tp2', pnlPct: 5 })];
    const backtest = [N({ symbol: 'BBB', side: 'long', entryTs: 9, exitTs: 10, closeReason: 'tp2', pnlPct: 1 })];
    const r = reconcileTrades({ paper, backtest, rows: {}, pnlPctTol: 1e-3 });
    const byStatus = Object.fromEntries(r.rows.map((x) => [x.status, x]));
    expect(byStatus.paper_only.paper!.symbol).toBe('AAA');
    expect(byStatus.backtest_only.backtest!.symbol).toBe('BBB');
    expect(r.summary.paperOnly).toBe(1);
    expect(r.summary.backtestOnly).toBe(1);
  });

  it('ambiguous: >1 trade on a single key (never silently greedy-paired)', () => {
    const paper = [
      N({ symbol: 'AAA', side: 'long', entryTs: 1, exitTs: 2, closeReason: 'tp2', pnlPct: 5 }),
      N({ symbol: 'AAA', side: 'long', entryTs: 1, exitTs: 3, closeReason: 'time_exit', pnlPct: 1 }),
    ];
    const r = reconcileTrades({ paper, backtest: [], rows: {}, pnlPctTol: 1e-3 });
    expect(r.rows[0].status).toBe('ambiguous');
    expect(r.summary.ambiguous).toBe(1);
  });
});

describe('engineTradeToNormalized — pnlPct from fillPrice, NOT realizedPnl (contract)', () => {
  it('uses side-aware fillPrice return even when realizedPnl would imply a different pct', () => {
    // long entry 100 → exit 110 = +10% on price; realizedPnl (USD, leveraged) is irrelevant to pnlPct
    const trade = { symbol: 'AAA', side: 'long', entryTs: 1, exitTs: 2, entryFillPrice: 100, exitFillPrice: 110, closeReason: 'tp2', realizedPnl: 999 } as never;
    expect(engineTradeToNormalized(trade).pnlPct).toBeCloseTo(10, 8);
    const short = { symbol: 'BBB', side: 'short', entryTs: 1, exitTs: 2, entryFillPrice: 100, exitFillPrice: 90, closeReason: 'tp2', realizedPnl: -5 } as never;
    expect(engineTradeToNormalized(short).pnlPct).toBeCloseTo(10, 8); // short profits when price falls
  });
});

describe('closeToClosePnlPct', () => {
  it('side-aware; undefined when a minute has no row', () => {
    const rows = [{ minute_ts: 1, close: 100 }, { minute_ts: 2, close: 105 }] as unknown as CanonicalRowV2[];
    expect(closeToClosePnlPct(rows, 1, 2, 'long')).toBeCloseTo(5, 8);
    expect(closeToClosePnlPct(rows, 1, 2, 'short')).toBeCloseTo(-5, 8);
    expect(closeToClosePnlPct(rows, 0, 2, 'long')).toBeUndefined(); // entryTs 0 is below the first minute → no floor row
    expect(closeToClosePnlPct([] as unknown as CanonicalRowV2[], 1, 2, 'long')).toBeUndefined();
  });
});
```

(Note: `closeToClosePnlPct(rows,1,999,'long')` floors 999 to minute 2 → defined; the genuine `undefined` cases are an empty rows array or a ts below the first minute. The empty-array assertion covers the contract.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/backtester/test/reconcile.test.ts`
Expected: FAIL — cannot find module `./helpers-reconcile`.

- [ ] **Step 3: Implement the pure core**

Create `apps/backtester/test/helpers-reconcile.ts`:

```typescript
// Strategy-agnostic paper↔backtest trade reconciliation (sub#2 scaffolding). Pure, no I/O.
// Pairs by `${symbol}|${entryTs}|${side}`; splits divergences into data-vs-engine via an
// INDEPENDENT close-to-close from CanonicalRowV2 rows (never reads the engine output). Missing
// rows ⇒ data_divergent (conservative — never blame the engine for absent data).

import type { CanonicalRowV2, StrategyModule } from '@trading/research-contracts/research';
import type { Trade } from '../src/engine/artifacts.js';
import { makeReplayModule, type PaperTrade } from './helpers-replay.js';

export type Side = 'long' | 'short';
export type ReconcileStatus =
  | 'matched' | 'engine_divergent' | 'data_divergent'
  | 'paper_only' | 'backtest_only' | 'ambiguous';

export interface NormalizedTrade {
  readonly symbol: string;
  readonly side: Side;
  readonly entryTs: number;
  readonly exitTs: number;
  readonly closeReason: string;
  readonly pnlPct: number;
}
export interface ReconcileRow {
  readonly key: string;
  readonly status: ReconcileStatus;
  readonly paper?: NormalizedTrade;
  readonly backtest?: NormalizedTrade;
  readonly deltas?: { readonly exitTsMatch: boolean; readonly closeReasonMatch: boolean; readonly pnlPctDelta: number };
  readonly note?: string;
}
export interface ReconcileSummary {
  readonly total: number; readonly matched: number;
  readonly engineDivergent: number; readonly dataDivergent: number;
  readonly paperOnly: number; readonly backtestOnly: number; readonly ambiguous: number;
  readonly matchRate: number;
}
export interface ReconcileResult { readonly rows: readonly ReconcileRow[]; readonly summary: ReconcileSummary }

const DEFAULT_TOL = 1e-3;

export function tradeKey(t: { symbol: string; entryTs: number; side: Side }): string {
  return `${t.symbol}|${t.entryTs}|${t.side}`;
}

export function paperToNormalized(t: PaperTrade): NormalizedTrade {
  return { symbol: t.symbol, side: t.side, entryTs: t.openedAtMs, exitTs: t.closedAtMs, closeReason: t.closeReason, pnlPct: Number(t.pnlPct) };
}

/** CONTRACT: pnlPct from fill prices, side-aware (same as sub#1). NEVER from realizedPnl (USD/leverage). */
export function engineTradeToNormalized(t: Trade): NormalizedTrade {
  const pnlPct = t.side === 'short'
    ? ((t.entryFillPrice - t.exitFillPrice) / t.entryFillPrice) * 100
    : ((t.exitFillPrice - t.entryFillPrice) / t.entryFillPrice) * 100;
  return { symbol: t.symbol, side: t.side, entryTs: t.entryTs, exitTs: t.exitTs, closeReason: String(t.closeReason), pnlPct };
}

function floorRow(rows: readonly CanonicalRowV2[], ts: number): CanonicalRowV2 | undefined {
  let best: CanonicalRowV2 | undefined;
  for (const r of rows) if (r.minute_ts <= ts) best = r; // rows ascending → last ≤ ts is the floor
  return best;
}

/** Independent price return from rows' closes (side-aware); undefined if a row for either minute is absent. */
export function closeToClosePnlPct(rows: readonly CanonicalRowV2[], entryTs: number, exitTs: number, side: Side): number | undefined {
  const e = floorRow(rows, entryTs);
  const x = floorRow(rows, exitTs);
  if (e === undefined || x === undefined) return undefined;
  return side === 'short'
    ? ((e.close - x.close) / e.close) * 100
    : ((x.close - e.close) / e.close) * 100;
}

function groupByKey(list: readonly NormalizedTrade[]): Map<string, NormalizedTrade[]> {
  const m = new Map<string, NormalizedTrade[]>();
  for (const t of list) {
    const k = tradeKey(t);
    const arr = m.get(k); if (arr) arr.push(t); else m.set(k, [t]);
  }
  return m;
}

export function reconcileTrades(args: {
  paper: readonly NormalizedTrade[];
  backtest: readonly NormalizedTrade[];
  rows: Readonly<Record<string, readonly CanonicalRowV2[]>>;
  pnlPctTol?: number;
}): ReconcileResult {
  const tol = args.pnlPctTol ?? DEFAULT_TOL;
  const paperByKey = groupByKey(args.paper);
  const btByKey = groupByKey(args.backtest);
  const keys = [...new Set<string>([...paperByKey.keys(), ...btByKey.keys()])].sort();
  const rows: ReconcileRow[] = [];

  for (const key of keys) {
    const ps = paperByKey.get(key) ?? [];
    const bs = btByKey.get(key) ?? [];
    if (ps.length > 1 || bs.length > 1) {
      rows.push({ key, status: 'ambiguous', note: `paper=${ps.length} backtest=${bs.length} at one key` });
      continue;
    }
    const p = ps[0]; const b = bs[0];
    if (p && !b) { rows.push({ key, status: 'paper_only', paper: p }); continue; }
    if (!p && b) { rows.push({ key, status: 'backtest_only', backtest: b }); continue; }
    const exitTsMatch = p.exitTs === b.exitTs;
    const closeReasonMatch = p.closeReason === b.closeReason;
    const pnlPctDelta = b.pnlPct - p.pnlPct;
    const deltas = { exitTsMatch, closeReasonMatch, pnlPctDelta };
    if (exitTsMatch && closeReasonMatch && Math.abs(pnlPctDelta) <= tol) {
      rows.push({ key, status: 'matched', paper: p, backtest: b, deltas });
      continue;
    }
    const c2c = closeToClosePnlPct(args.rows[p.symbol] ?? [], p.entryTs, p.exitTs, p.side);
    if (c2c === undefined) {
      rows.push({ key, status: 'data_divergent', paper: p, backtest: b, deltas, note: 'rows missing for entry/exit minute' });
    } else if (Math.abs(c2c - p.pnlPct) > tol) {
      rows.push({ key, status: 'data_divergent', paper: p, backtest: b, deltas, note: `rows c2c ${c2c.toFixed(4)} != paper ${p.pnlPct.toFixed(4)}` });
    } else {
      rows.push({ key, status: 'engine_divergent', paper: p, backtest: b, deltas });
    }
  }
  return { rows, summary: summarize(rows) };
}

function summarize(rows: readonly ReconcileRow[]): ReconcileSummary {
  const c = (s: ReconcileStatus) => rows.filter((r) => r.status === s).length;
  const total = rows.length;
  const matched = c('matched');
  return {
    total, matched,
    engineDivergent: c('engine_divergent'), dataDivergent: c('data_divergent'),
    paperOnly: c('paper_only'), backtestOnly: c('backtest_only'), ambiguous: c('ambiguous'),
    matchRate: total === 0 ? 0 : matched / total,
  };
}

/**
 * A replay strategy that, unlike sub#1's `makeReplayModule` (which exits with a fixed synthetic
 * reason), exits carrying each paper trade's recorded `closeReason` — so the reconcile match
 * criterion's closeReason dimension is exercisable end-to-end. Reuses sub#1's entry behavior.
 */
export function makeReconcileReplayModule(symbol: string, trades: readonly PaperTrade[]): StrategyModule {
  const base = makeReplayModule(symbol, [...trades]);
  const reasonByClose = new Map(trades.map((t) => [t.closedAtMs, t.closeReason]));
  return {
    ...base,
    onPositionBar: (ctx: { bar: { ts: number } }) => {
      const reason = reasonByClose.get(ctx.bar.ts);
      return reason !== undefined ? { kind: 'exit', target: reason } : { kind: 'idle' };
    },
  } as unknown as StrategyModule;
}
```

(Implementer: verify `Trade` from `../src/engine/artifacts.js` exposes `symbol`, `side`, `entryTs`, `exitTs`, `entryFillPrice`, `exitFillPrice`, `closeReason`. If `symbol` is absent on `Trade`, thread it in at the normalizer call site in Task 2 instead — the run is per-symbol there.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/backtester/test/reconcile.test.ts`
Expected: PASS (all synthetic + contract tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/test/helpers-reconcile.ts apps/backtester/test/reconcile.test.ts
git commit -m "feat(reconcile): pure reconcileTrades core + normalizers + synthetic taxonomy coverage"
```

---

## Task 2: Real end-to-end self-test + reconciliation report

**Files:**
- Modify: `apps/backtester/test/reconcile.test.ts` (append the real-data describe)
- Create: `apps/backtester/scripts/reconcile-report.mts`

**Interfaces:**
- Consumes: `reconcileTrades`, `paperToNormalized`, `engineTradeToNormalized`, `makeReconcileReplayModule` (Task 1); `tapeFromRows` + the `runBacktest` wiring from sub#1 (`helpers-replay.ts` `replayPnlPct` is the template — mirror its registry/request construction, swapping the module for `makeReconcileReplayModule` and the execution profile for the paper-match profile `SAME_BAR_NO_COST` already defined in `helpers-replay.ts`).
- Produces: a real self-test asserting `engineDivergent === 0`, `ambiguous === 0`, known data-divergent trades classified `data_divergent`; a deterministic report script.

The reference fixture is sub#1's committed slice `apps/backtester/test/fixtures/exec-validation/long-oi-time-exit.json` (`{ trades: PaperTrade[]; rowsBySymbol: Record<string, CanonicalRowV2[]> }`) — it holds the 4 in-coverage `time_exit` trades: BEATUSDT + SIRENUSDT (reproducible) and LABUSDT + REUSDT (data-divergent, per sub#1).

- [ ] **Step 1: Write the failing real-data test**

Append to `apps/backtester/test/reconcile.test.ts`:

```typescript
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paperToNormalized, engineTradeToNormalized, makeReconcileReplayModule } from './helpers-reconcile.js';
import { tapeFromRows, type PaperTrade } from './helpers-replay.js';
import type { PaperTrade as _PT } from './helpers-replay.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(HERE, 'fixtures/exec-validation/long-oi-time-exit.json'), 'utf8'),
) as { trades: PaperTrade[]; rowsBySymbol: Record<string, CanonicalRowV2[]> };

// runReconcile: run the reconcile-replay through the real engine under the paper-match profile,
// return the engine's Trades normalized. Mirror replayPnlPct's runBacktest wiring (same registry/
// request shape); module = makeReconcileReplayModule(symbol, trades); executionProfileRef = paper_match.
async function runBacktestTrades(symbol: string, rows: CanonicalRowV2[], trades: PaperTrade[]): Promise<NormalizedTrade[]> {
  // ... mirror helpers-replay.ts replayPnlPct: createModuleRegistry({strategies:[mod], riskProfiles:[DEFAULT_RISK],
  //     executionProfiles:[SAME_BAR_NO_COST]}); runBacktest(req, {registry, marketTape: tapeFromRows(symbol, rows),
  //     router: createTrustedRouter()}); take out.baseline.trades and map engineTradeToNormalized.
  //     If engine Trade lacks `symbol`, set it from the `symbol` arg here.
  throw new Error('implement by copying replayPnlPct wiring');
}

describe('reconcile — real engine self-test (sub#1 replay, paper convention)', () => {
  it('engine reproduces paper where data permits: engineDivergent===0, ambiguous===0, knowns are data_divergent', async () => {
    const bySymbol = new Map<string, PaperTrade[]>();
    for (const t of fixture.trades) {
      const arr = bySymbol.get(t.symbol) ?? []; arr.push(t); bySymbol.set(t.symbol, arr);
    }
    const backtest: NormalizedTrade[] = [];
    for (const [symbol, trades] of bySymbol) {
      const rows = fixture.rowsBySymbol[symbol];
      backtest.push(...(await runBacktestTrades(symbol, rows, trades)));
    }
    const paper = fixture.trades.map(paperToNormalized);
    const r = reconcileTrades({ paper, backtest, rows: fixture.rowsBySymbol, pnlPctTol: 1e-3 });

    expect(r.summary.ambiguous).toBe(0); // hard assertEmpty — corrupt-data sentinel
    expect(r.summary.engineDivergent).toBe(0); // engine reproduces paper where data permits
    // Known sub#1 data-divergent trades land in data_divergent (snapshot bars != paper fills)
    const dataDivergentSymbols = r.rows.filter((x) => x.status === 'data_divergent').map((x) => x.paper?.symbol);
    expect(dataDivergentSymbols).toEqual(expect.arrayContaining(['LABUSDT', 'REUSDT']));
    // Reproducible trades matched
    const matchedSymbols = r.rows.filter((x) => x.status === 'matched').map((x) => x.paper?.symbol);
    expect(matchedSymbols).toEqual(expect.arrayContaining(['BEATUSDT', 'SIRENUSDT']));
    expect(r.summary.matched + r.summary.dataDivergent).toBe(r.summary.total);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run apps/backtester/test/reconcile.test.ts`
Expected: FAIL — `runBacktestTrades` throws "implement by copying replayPnlPct wiring".

- [ ] **Step 3: Implement `runBacktestTrades` by mirroring `replayPnlPct`**

Open `apps/backtester/test/helpers-replay.ts`, read `replayPnlPct` (lines ~58-92): it builds `createModuleRegistry({ strategies:[mod], riskProfiles:[DEFAULT_RISK], executionProfiles:[SAME_BAR_NO_COST] })` and a `BacktestRunRequest` with `executionProfileRef: { id: 'paper_match', version: '1.0.0' }`, then `runBacktest(req, { registry, marketTape, router: createTrustedRouter() })`. Reproduce that exact wiring in `runBacktestTrades`, changing only: `const mod = makeReconcileReplayModule(symbol, trades)`; after the run, `return out.baseline.trades.map((t) => engineTradeToNormalized({ ...t, symbol }))` (inject `symbol` if the engine `Trade` doesn't already carry it). Import the same symbols `replayPnlPct` imports (`runBacktest`, `createModuleRegistry`, `createTrustedRouter`, `DEFAULT_RISK`, `SAME_BAR_NO_COST`, `BacktestRunRequest`) — they live in `helpers-replay.ts`; either re-import from the same source modules or export the small request-builder. Keep `runBacktestTrades` inside `reconcile.test.ts` (test-only).

- [ ] **Step 4: Run the real test to green**

Run: `npx vitest run apps/backtester/test/reconcile.test.ts`
Expected: PASS. If `engineDivergent > 0`: a reproducible trade is being flagged — check the normalizer (must use fillPrice, not realizedPnl) and that the reconcile-replay carries the paper `closeReason` (else closeReason mismatch trips divergence). If a known data-divergent symbol shows as `engine_divergent`, the c2c classifier or rows wiring is off.

- [ ] **Step 5: Add the reconciliation report script**

Create `apps/backtester/scripts/reconcile-report.mts` — model it on `apps/backtester/scripts/validate-execution.mts` (fixture load + deterministic output). It loads the fixture, runs the same `runBacktestTrades` flow per symbol, calls `reconcileTrades`, and prints:
- a per-trade table sorted by `(symbol, entryTs)`: `key | status | exitTsMatch | closeReasonMatch | pnlPctDelta | note`;
- an aggregate block: counts per status + `matchRate`.
No timestamps/random (repo canonical-output rule). Factor the per-symbol run loop so the script and the test share it (export a `runReconcileOnFixture(fixture)` from `helpers-reconcile.ts` if it avoids duplication; otherwise keep the small loop inline).

- [ ] **Step 6: Run the report + full suite**

Run: `npx tsx apps/backtester/scripts/reconcile-report.mts`
Expected: a per-trade table + aggregate; `engine_divergent` count 0; LABUSDT/REUSDT shown `data_divergent`.

Run: `pnpm test`
Expected: full suite green; goldens unchanged (this change is test/script-only — no engine/runtime touched).

- [ ] **Step 7: Commit**

```bash
git add apps/backtester/test/reconcile.test.ts apps/backtester/test/helpers-reconcile.ts apps/backtester/scripts/reconcile-report.mts
git commit -m "feat(reconcile): real engine self-test (engineDivergent=0) + deterministic reconciliation report"
```

---

## Self-Review

**Spec coverage:**
- Match criterion (symbol|entryTs|side; exit+closeReason+pnlPct≤tol) → Task 1 `reconcileTrades`. ✓
- Taxonomy incl. conservative data_divergent on missing rows + ambiguous-not-greedy → Task 1 + synthetic tests. ✓
- Non-circular data-vs-engine via independent c2c from rows → Task 1 `closeToClosePnlPct`, used in `reconcileTrades`. ✓
- Normalizer contract (fillPrice, not realizedPnl) → Task 1 `engineTradeToNormalized` + contract test. ✓
- `ambiguous` hard assertEmpty on real data → Task 2 real test (`expect(...ambiguous).toBe(0)`). ✓
- Report (deterministic) → Task 2 Step 5. ✓
- Real self-test (engineDivergent=0, LABUSDT/REUSDT data_divergent) → Task 2. ✓
- Non-goals (no port/artifact, no USD, no engine/helpers-replay change) → respected (new files; `makeReconcileReplayModule` wraps but does not modify `makeReplayModule`). ✓

**Placeholder scan:** Task 2 Step 1/3 intentionally reference "mirror `replayPnlPct`'s wiring" rather than reproducing ~30 lines of request construction that already exist in the file the implementer reads — a deliberate DRY pointer (sub#1 did the same in the realism plan), with the exact registry/request fields named. The `throw new Error('implement...')` is the RED placeholder the TDD step removes in Step 3, not a plan gap.

**Type consistency:** `NormalizedTrade` fields are identical across `paperToNormalized`, `engineTradeToNormalized`, `reconcileTrades`, and both tests. `ReconcileStatus` values match between the type, `summarize`, and every test assertion. `makeReconcileReplayModule` signature matches its Task 2 call site.
