# long_oi signal-parity (G7 Stage 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the backtester, running long_oi's REAL decision code (`LONG_OI_MODULE`) from raw 1-minute bars of a real recorded day, reproduces the trades the real bot recorded — same entry/exit bars, side, normalized close-reason, pnl% within tolerance, and no extra entries.

**Architecture:** Vendor the self-contained `long_oi` module into backtester test fixtures (with a drift guard), then extend the existing `exec-validation` harness pattern: run `LONG_OI_MODULE` through the real `runBacktest` (`createTrustedRouter()`, same-bar no-cost profile) on ESPORTSUSDT 1-minute rows from the committed `2026-06-18-real-all` срез, collect the engine-generated `Trade[]`, and match them against the recorded golden trades over a warmup-trimmed scorable window.

**Tech Stack:** TypeScript (ESM), vitest, `@trading-platform/sdk` (research-contract + historical `CanonicalRowV2`), the backtester engine (`runBacktest`, `MarketTape`).

## Global Constraints

- **Signals exact, metrics in tolerance.** Entry bar `entryTs == golden.openedAtMs` (±0), side `long`, exit bar `exitTs == golden.closedAtMs` (±0), normalized close-reason equal; only `pnl%` is compared within epsilon (default `0.05` pct-point). Never loosen a signal assertion to make pnl pass.
- **Anchor:** `trading-mock-platform/data/snapshots/fixtures/2026-06-18-real-all/ops/bundle.json`, symbol `ESPORTSUSDT`, timeframe `1m`. 9 recorded golden `long_oi` trades.
- **Warmup = `dump.lookbackMin + watch.maxMinutes = 20 + 40 = 60` minutes.** Scorable = golden trades with `openedAtMs ≥ firstRow.minute_ts + 60*60_000`. This yields **8** scorable ESPORTSUSDT trades; the excluded set MUST be exactly `{2026-06-18T00:04:00Z}` (asserted, not silently dropped).
- **No-extra-in-scorable-window:** the set of engine entries whose `entryTs` ∈ scorable window must equal the scorable golden entry set (both directions).
- **Close-reason normalization** (both engine + golden → canonical): `take_profit_final|tp1|tp2 → take_profit`; `stop_loss|sl|hard_stop → stop_loss`; `time_exit|max_hold|watch_expire → time_exit`; else `other`. `hard_stop` is the REAL `closeReasonRaw` for ESPORTSUSDT stop-loss trades. `other↔other` matches are flagged (must not silently pass).
- **Determinism:** same rows + module + seed → byte-identical trades (asserted by a two-run test).
- **tradeCount=0 is a HARD FAILURE**, never a skip.
- **Vendored module byte-identical** to `trading-lab/docs/fixtures/strategies/long-oi-code/*.ts` (itself byte-identical to `trading-platform/src/strategies/long_oi/*.ts`), locked by a checksum drift guard.
- Out of scope: Stage 2 (LLM bundle ≡ vendored module), real 3-day / live-platform parity (058). ESPORTSUSDT-only (not the other 10 symbols).
- **Tooling:** run one test file `pnpm vitest run apps/backtester/test/<file>.test.ts` from repo root; a fresh checkout needs `pnpm pretest` once (builds SDK tarball + sandbox-harness overlay + `_engine` global-setup). Typecheck `pnpm typecheck`. (`pnpm typecheck` / `pretest` can be slow — let them finish.)

---

### Task 0 (PREREQUISITE): Vendor `long_oi` into backtester test fixtures + drift guard

**Files:**
- Create: `apps/backtester/test/fixtures/strategies/long_oi/{module.ts,manifest.ts,params.ts,flat_phase.ts,position_phase.ts,signals.ts,state.ts}` (copied verbatim from `trading-lab/docs/fixtures/strategies/long-oi-code/`)
- Create: `apps/backtester/test/fixtures/strategies/long_oi/CHECKSUMS.txt`
- Create: `apps/backtester/test/fixtures/strategies/long_oi/README.md` (provenance)
- Test: `apps/backtester/test/long-oi-vendored.test.ts`

**Interfaces:**
- Produces: `import { LONG_OI_MODULE, createLongOiModule } from './fixtures/strategies/long_oi/module.ts'` resolving in a backtester test; `LONG_OI_MODULE: StrategyModule`.

- [ ] **Step 1: Copy the 7 vendored files**

Copy verbatim (bytes unchanged) from `/home/alexxxnikolskiy/projects/trading-lab/docs/fixtures/strategies/long-oi-code/` → `apps/backtester/test/fixtures/strategies/long_oi/`: `module.ts`, `manifest.ts`, `params.ts`, `flat_phase.ts`, `position_phase.ts`, `signals.ts`, `state.ts`. (`module.ts` transitively imports all 6 siblings via `./x.js` specifiers; keep them together.) Add `README.md` noting: "Vendored byte-identical from trading-platform/src/strategies/long_oi via trading-lab/docs/fixtures/strategies/long-oi-code. Do not edit; re-vendor + regenerate CHECKSUMS.txt to update."

- [ ] **Step 2: Write the failing import+drift test**

`apps/backtester/test/long-oi-vendored.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LONG_OI_MODULE, createLongOiModule } from './fixtures/strategies/long_oi/module.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(HERE, 'fixtures/strategies/long_oi');

describe('vendored long_oi module', () => {
  it('resolves and is a StrategyModule', () => {
    expect(typeof LONG_OI_MODULE.onBarClose).toBe('function');
    expect(LONG_OI_MODULE.manifest).toBeDefined();
    expect(typeof createLongOiModule).toBe('function');
    // fresh state per call (no shared mutable module state)
    expect(createLongOiModule()).not.toBe(LONG_OI_MODULE);
  });

  it('matches its committed checksums (drift guard)', () => {
    const lines = readFileSync(resolve(DIR, 'CHECKSUMS.txt'), 'utf8').trim().split('\n');
    const expected = new Map(lines.map((l) => { const [h, f] = l.split('  '); return [f, h]; }));
    const tsFiles = readdirSync(DIR).filter((f) => f.endsWith('.ts')).sort();
    for (const f of tsFiles) {
      const h = createHash('sha256').update(readFileSync(resolve(DIR, f))).digest('hex');
      expect(`${f}: ${h}`).toBe(`${f}: ${expected.get(f)}`);
    }
    // every vendored .ts is covered by the checksum manifest
    expect(tsFiles.every((f) => expected.has(f))).toBe(true);
  });
});
```

- [ ] **Step 3: Run — verify import resolution first**

Run: `pnpm vitest run apps/backtester/test/long-oi-vendored.test.ts`
Expected: the FIRST `it` FAILS only if the `./x.js`→`.ts` ESM specifier resolution doesn't work in vitest, or PASSES if it does; the checksum `it` FAILS (no CHECKSUMS.txt yet).
**If the import itself throws** (cannot resolve `./flat_phase.js`): the vendored files use `.js` import specifiers pointing at `.ts` siblings. Fix by matching the repo's convention — check how other `apps/backtester` test/src files import siblings (`.js` vs `.ts` vs extensionless). If the repo uses `.ts` specifiers, rewrite the 6 sibling import specifiers in the vendored files from `./x.js` to `./x.ts` (this is a byte change — record it in README + regenerate checksums off the adjusted files; the module logic stays identical). Do NOT change any logic. Report which convention was needed.

- [ ] **Step 4: Generate CHECKSUMS.txt**

Run (from repo root):
```bash
( cd apps/backtester/test/fixtures/strategies/long_oi && sha256sum *.ts | sort ) > apps/backtester/test/fixtures/strategies/long_oi/CHECKSUMS.txt
```
Format per line: `<sha256>  <filename>` (two spaces — `sha256sum` default). Confirm the file lists all 7 `.ts` files.

- [ ] **Step 5: Run to green + typecheck**

Run: `pnpm vitest run apps/backtester/test/long-oi-vendored.test.ts` → both PASS.
Run: `pnpm typecheck` → clean. (If new test files under `apps/backtester/test` aren't in the typecheck tsconfig scope, confirm the existing `exec-validation.test.ts` is — match its inclusion; do not widen scope beyond how existing tests are covered.)

- [ ] **Step 6: Commit**

```bash
git add apps/backtester/test/fixtures/strategies/long_oi apps/backtester/test/long-oi-vendored.test.ts
git commit -m "test(long-oi-parity): vendor long_oi module into backtester fixtures + drift guard (Task 0)"
```

---

### Task 1: `normalizeCloseReason` (pure)

**Files:**
- Create: `apps/backtester/test/long-oi-parity/normalize-close-reason.ts`
- Test: `apps/backtester/test/long-oi-parity/normalize-close-reason.test.ts`

**Interfaces:**
- Produces: `type CanonicalCloseReason = 'take_profit' | 'stop_loss' | 'time_exit' | 'other'`; `normalizeCloseReason(raw: string | null | undefined): CanonicalCloseReason`.

- [ ] **Step 1: Read the engine's CloseReason vocabulary**

Read `apps/backtester/src/engine/artifacts.ts:108` (`type CloseReason`) and list its literal values. These are what the engine `Trade.closeReason` emits and MUST be covered by the map (in addition to the golden `closeReason`/`closeReasonRaw` tokens). Record the discovered engine tokens in a comment in the impl.

- [ ] **Step 2: Write failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { normalizeCloseReason } from './normalize-close-reason.ts';

describe('normalizeCloseReason', () => {
  it('maps take-profit tokens', () => {
    for (const r of ['take_profit_final', 'tp1', 'tp2']) expect(normalizeCloseReason(r)).toBe('take_profit');
  });
  it('maps stop-loss tokens incl the real hard_stop raw', () => {
    for (const r of ['stop_loss', 'sl', 'hard_stop']) expect(normalizeCloseReason(r)).toBe('stop_loss');
  });
  it('maps time-exit tokens', () => {
    for (const r of ['time_exit', 'max_hold', 'watch_expire']) expect(normalizeCloseReason(r)).toBe('time_exit');
  });
  it('maps every engine CloseReason literal to a non-other bucket where applicable', () => {
    // ADD each engine literal discovered in Step 1 with its expected canonical bucket
    // e.g. expect(normalizeCloseReason('<engine_tp_token>')).toBe('take_profit');
  });
  it('unknown/empty → other', () => {
    for (const r of ['weird', '', null, undefined]) expect(normalizeCloseReason(r)).toBe('other');
  });
});
```
(Fill the Step-1 engine tokens into the 4th `it` before running.)

- [ ] **Step 3: Run RED**

Run: `pnpm vitest run apps/backtester/test/long-oi-parity/normalize-close-reason.test.ts` → FAIL (module not found).

- [ ] **Step 4: Implement**

```ts
export type CanonicalCloseReason = 'take_profit' | 'stop_loss' | 'time_exit' | 'other';

// Covers BOTH the golden vocabulary (mock tradesByRun closeReason/closeReasonRaw:
// take_profit_final, tp2, stop_loss, hard_stop, time_exit, other) AND the engine
// Trade.closeReason literals (from artifacts.ts:108 — Step 1). Extend the arrays with
// any engine token discovered there.
const TAKE_PROFIT = new Set(['take_profit', 'take_profit_final', 'tp', 'tp1', 'tp2']);
const STOP_LOSS = new Set(['stop_loss', 'sl', 'hard_stop']);
const TIME_EXIT = new Set(['time_exit', 'max_hold', 'watch_expire', 'timeout']);

export function normalizeCloseReason(raw: string | null | undefined): CanonicalCloseReason {
  if (!raw) return 'other';
  const r = raw.toLowerCase();
  if (TAKE_PROFIT.has(r)) return 'take_profit';
  if (STOP_LOSS.has(r)) return 'stop_loss';
  if (TIME_EXIT.has(r)) return 'time_exit';
  return 'other';
}
```
(Add each engine literal from Step 1 to the correct Set.)

- [ ] **Step 5: Green + commit**

Run: `pnpm vitest run apps/backtester/test/long-oi-parity/normalize-close-reason.test.ts` → PASS. `pnpm typecheck` → clean.
```bash
git add apps/backtester/test/long-oi-parity/normalize-close-reason.ts apps/backtester/test/long-oi-parity/normalize-close-reason.test.ts
git commit -m "test(long-oi-parity): normalizeCloseReason (incl hard_stop) (Task 1)"
```

---

### Task 2: Signal-parity golden fixture + extractor

**Files:**
- Create: `apps/backtester/scripts/extract-signal-parity-fixture.mts`
- Create: `apps/backtester/test/fixtures/exec-validation/long-oi-signal-parity.json` (generated, committed)
- Create: `apps/backtester/test/long-oi-parity/golden-types.ts`
- Test: `apps/backtester/test/long-oi-parity/golden-fixture.test.ts`

**Interfaces:**
- Produces: `interface SignalParityGoldenTrade { tradeId: string; symbol: string; side: 'long'|'short'; openedAtMs: number; closedAtMs: number; pnlPct: string; closeReason: string; closeReasonRaw: string | null; entryPrice: string | null; exitPrice: string | null }`; fixture shape `{ symbol: string; timeframe: '1m'; trades: SignalParityGoldenTrade[]; rows: CanonicalRowV2[] }`.

- [ ] **Step 1: Define the golden type**

`golden-types.ts`:
```ts
import type { CanonicalRowV2 } from '@trading-platform/sdk/historical';

// Extends the exec-validation PaperTrade shape with source evidence the mock
// tradesByRun ClosedTrade carries but the old extractor dropped.
export interface SignalParityGoldenTrade {
  tradeId: string;
  symbol: string;
  side: 'long' | 'short';
  openedAtMs: number;
  closedAtMs: number;
  pnlPct: string;
  closeReason: string;
  closeReasonRaw: string | null;
  entryPrice: string | null;
  exitPrice: string | null;
}

export interface SignalParityFixture {
  symbol: string;
  timeframe: '1m';
  trades: SignalParityGoldenTrade[];
  rows: CanonicalRowV2[];
}
```
Import `CanonicalRowV2` from the **exact specifier `helpers-replay.ts` / `exec-validation.test.ts` already use** (read one of them and copy it verbatim — the type is defined in the platform SDK's historical module, but the backtester may re-export it via a research-contract path; match the existing test, don't introduce a new specifier).

- [ ] **Step 2: Write the extractor script**

`extract-signal-parity-fixture.mts` — model on `apps/backtester/scripts/extract-validation-fixture.mts`, but: fix symbol to `ESPORTSUSDT`, keep ALL its `long_oi_strategy` trades (not just `time_exit`), preserve `closeReasonRaw`/`entryPrice`/`exitPrice`, and emit the full `CanonicalRowV2[]` for the symbol (not a 2-field projection). Source path (env-overridable `SLICE_PATH`): `../../trading-mock-platform/data/snapshots/fixtures/2026-06-18-real-all/ops/bundle.json` (resolve relative to the repo, matching the existing script's SLICE constant).
```ts
// pseudocode of the mapper — the engineer fills the read/resolve/write boilerplate
// exactly as extract-validation-fixture.mts does it:
const bundle = JSON.parse(readFileSync(SLICE_PATH, 'utf8'));
const rows: CanonicalRowV2[] = bundle.historical.rowsBySymbol['ESPORTSUSDT'];
const allTrades = Object.values(bundle.tradesByRun).flat() as any[];
const trades: SignalParityGoldenTrade[] = allTrades
  .filter((t) => t.symbol === 'ESPORTSUSDT')
  .sort((a, b) => a.openedAtMs - b.openedAtMs)
  .map((t) => ({
    tradeId: t.tradeId, symbol: t.symbol, side: t.side,
    openedAtMs: t.openedAtMs, closedAtMs: t.closedAtMs,
    pnlPct: String(t.pnlPct), closeReason: t.closeReason,
    closeReasonRaw: t.closeReasonRaw ?? null,
    entryPrice: t.entryPrice ?? null, exitPrice: t.exitPrice ?? null,
  }));
const fixture: SignalParityFixture = { symbol: 'ESPORTSUSDT', timeframe: '1m', trades, rows };
writeFileSync(OUT, JSON.stringify(fixture, null, 2));
```
Output path: `apps/backtester/test/fixtures/exec-validation/long-oi-signal-parity.json`.

- [ ] **Step 3: Generate the fixture**

Run: `pnpm tsx apps/backtester/scripts/extract-signal-parity-fixture.mts` (match how the existing `.mts` scripts are invoked — check `package.json` for a `tsx`/`node --loader` convention; use the same).
Expected: writes `long-oi-signal-parity.json` with **9 ESPORTSUSDT trades** and ~1368 rows.

- [ ] **Step 4: Write + run the fixture sanity test**

`golden-fixture.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SignalParityFixture } from './golden-types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(readFileSync(resolve(HERE, '../fixtures/exec-validation/long-oi-signal-parity.json'), 'utf8')) as SignalParityFixture;

describe('long-oi signal-parity golden fixture', () => {
  it('has 9 ESPORTSUSDT long trades with source evidence + 1-minute rows', () => {
    expect(fx.symbol).toBe('ESPORTSUSDT');
    expect(fx.trades).toHaveLength(9);
    expect(fx.trades.every((t) => t.side === 'long')).toBe(true);
    expect(fx.trades.every((t) => t.closeReasonRaw !== undefined && t.entryPrice !== undefined)).toBe(true);
    // stop-loss trades carry the hard_stop raw token (locks Task-1 mapping relevance)
    const sl = fx.trades.filter((t) => t.closeReason === 'stop_loss');
    expect(sl.length).toBeGreaterThan(0);
    expect(sl.every((t) => t.closeReasonRaw === 'hard_stop')).toBe(true);
    expect(fx.rows.length).toBeGreaterThan(1300);
    expect(fx.rows[0]!.schema_version).toBe(2);
  });
});
```
Run: `pnpm vitest run apps/backtester/test/long-oi-parity/golden-fixture.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/scripts/extract-signal-parity-fixture.mts apps/backtester/test/fixtures/exec-validation/long-oi-signal-parity.json apps/backtester/test/long-oi-parity/golden-types.ts apps/backtester/test/long-oi-parity/golden-fixture.test.ts
git commit -m "test(long-oi-parity): signal-parity golden fixture + extractor (preserves closeReasonRaw/entry/exit) (Task 2)"
```

---

### Task 3: `runLongOiOnRows` — execute the real module through the engine

**Files:**
- Create: `apps/backtester/test/long-oi-parity/run-long-oi.ts`
- Test: `apps/backtester/test/long-oi-parity/run-long-oi.test.ts`

**Interfaces:**
- Consumes: `LONG_OI_MODULE` (Task 0); `SignalParityFixture` (Task 2); engine `runBacktest`, `createTrustedRouter`, `createModuleRegistry`, `DEFAULT_RISK`, and the local `SAME_BAR_NO_COST` + `tapeFromRows` from `helpers-replay.ts`.
- Produces: `interface GeneratedTrade { entryTs: number; exitTs: number; side: 'long'|'short'; closeReason: string; entryFillPrice: number; exitFillPrice: number; pnlPct: number }`; `runLongOiOnRows(rows: CanonicalRowV2[], symbol: string): Promise<GeneratedTrade[]>`.

- [ ] **Step 1: Implement the adapter (mirror `replayPnlPct`'s wiring, swap the module)**

Read `apps/backtester/test/helpers-replay.ts` and reuse its exact wiring — `tapeFromRows`, `SAME_BAR_NO_COST`, the `BacktestRunRequest` shape, `createModuleRegistry({ strategies: [LONG_OI_MODULE], riskProfiles: [DEFAULT_RISK], executionProfiles: [SAME_BAR_NO_COST] })`, and `runBacktest(req, { registry, marketTape: tape, router: createTrustedRouter() })`. Import `tapeFromRows`/`SAME_BAR_NO_COST` from `./helpers-replay.ts` if exported; otherwise replicate them verbatim. Then map `out.baseline.trades` (engine `Trade`) → `GeneratedTrade`, computing `pnlPct` for a long as `(exitFillPrice - entryFillPrice) / entryFillPrice * 100`:
```ts
const out = await runBacktest(req, { registry, marketTape: tape, router: createTrustedRouter() });
if (out.status !== 'completed') throw new Error(`runBacktest rejected: ${JSON.stringify(out.validation)}`);
return out.baseline.trades.map((t) => ({
  entryTs: t.entryTs, exitTs: t.exitTs, side: t.side, closeReason: t.closeReason,
  entryFillPrice: t.entryFillPrice, exitFillPrice: t.exitFillPrice,
  pnlPct: ((t.exitFillPrice - t.entryFillPrice) / t.entryFillPrice) * 100,
}));
```
Derive `symbol`/`timeframe:'1m'`/`period`/`seed:1`/`metrics:['pnl']` exactly as `helpers-replay.ts` does. **`period.to` MUST be EXCLUSIVE** — use `from: new Date(rows[0].minute_ts).toISOString()`, `to: new Date(rows[rows.length - 1].minute_ts + 60_000).toISOString()` (the `+ 60_000` matches `helpers-replay.ts`; without it the LAST minute bar is dropped from the run, silently losing any trade on it).

- [ ] **Step 2: Write the smoke test (tradeCount=0 guard + ctx.market populated)**

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLongOiOnRows } from './run-long-oi.ts';
import type { SignalParityFixture } from './golden-types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(readFileSync(resolve(HERE, '../fixtures/exec-validation/long-oi-signal-parity.json'), 'utf8')) as SignalParityFixture;

describe('runLongOiOnRows', () => {
  it('generates trades from raw bars (tradeCount=0 regression guard; ctx.market/OI populated)', async () => {
    const trades = await runLongOiOnRows(fx.rows, fx.symbol);
    expect(trades.length).toBeGreaterThan(0); // 0 ⇒ 1h-regression OR MarketTape missing OI ⇒ HARD FAIL
    expect(trades.every((t) => t.side === 'long')).toBe(true);
    expect(trades.every((t) => Number.isFinite(t.entryTs) && Number.isFinite(t.exitTs))).toBe(true);
  }, 30_000);
});
```

- [ ] **Step 3: Run**

Run: `pnpm vitest run apps/backtester/test/long-oi-parity/run-long-oi.test.ts`
Expected: PASS with `trades.length > 0`.
**If `trades.length === 0`:** diagnose before proceeding — long_oi needs `ctx.market` (OI/liq). Verify `tapeFromRows`→`marketTapeFromCanonicalRows` actually populates OI/liq/taker from the `CanonicalRowV2` `oi_total_usd`/`liq_*`/`taker_*` fields (read `marketTapeFromCanonicalRows`; if it drops market kinds by default, that is the root cause — report it, do NOT hack the module). This is a Phase-1 checkpoint, not a place to force a pass.

- [ ] **Step 4: Commit**

```bash
git add apps/backtester/test/long-oi-parity/run-long-oi.ts apps/backtester/test/long-oi-parity/run-long-oi.test.ts
git commit -m "test(long-oi-parity): runLongOiOnRows executes real module via runBacktest (Task 3)"
```

---

### Task 4: warmup/scorable filter + `matchTrades` (pure)

**Files:**
- Create: `apps/backtester/test/long-oi-parity/match-trades.ts`
- Test: `apps/backtester/test/long-oi-parity/match-trades.test.ts`

**Interfaces:**
- Consumes: `SignalParityGoldenTrade` (Task 2), `GeneratedTrade` (Task 3), `normalizeCloseReason` (Task 1).
- Produces: `scorableGolden(golden: SignalParityGoldenTrade[], firstRowTs: number, warmupMs?: number): SignalParityGoldenTrade[]`; `matchTrades(golden: SignalParityGoldenTrade[], generated: GeneratedTrade[], window: {startMs: number; endMs: number}, tolPct?: number): ParityReport` where `ParityReport = { ok: boolean; matched: {goldenId: string; pnlDeltaPct: number; reasonBucket: string}[]; failures: string[]; flaggedOtherOther: string[] }`.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { scorableGolden, matchTrades } from './match-trades.ts';

const WARMUP = 60 * 60_000;
const g = (o: Partial<any> = {}) => ({ tradeId: 'g1', symbol: 'ESPORTSUSDT', side: 'long', openedAtMs: 10_000_000, closedAtMs: 10_060_000, pnlPct: '5.0', closeReason: 'take_profit_final', closeReasonRaw: 'tp2', entryPrice: '1', exitPrice: '1.05', ...o });
const gen = (o: Partial<any> = {}) => ({ entryTs: 10_000_000, exitTs: 10_060_000, side: 'long', closeReason: 'take_profit', entryFillPrice: 1, exitFillPrice: 1.05, pnlPct: 5.0, ...o });

describe('scorableGolden', () => {
  it('drops trades whose entry is within warmup of the first row', () => {
    const first = 0;
    const kept = scorableGolden([g({ openedAtMs: 30 * 60_000 }), g({ tradeId: 'g2', openedAtMs: 90 * 60_000 })], first, WARMUP);
    expect(kept.map((t) => t.tradeId)).toEqual(['g2']);
  });
});

describe('matchTrades', () => {
  const win = { startMs: 0, endMs: 1e13 };
  it('exact signals + pnl in tol → ok', () => {
    expect(matchTrades([g()], [gen()], win).ok).toBe(true);
  });
  it('shifted entry bar → fail', () => {
    expect(matchTrades([g()], [gen({ entryTs: 10_000_000 + 60_000 })], win).ok).toBe(false);
  });
  it('wrong close-reason bucket → fail', () => {
    expect(matchTrades([g()], [gen({ closeReason: 'stop_loss', pnlPct: 5.0 })], win).ok).toBe(false);
  });
  it('pnl beyond epsilon → fail', () => {
    expect(matchTrades([g()], [gen({ pnlPct: 5.2 })], win, 0.05).ok).toBe(false);
  });
  it('extra generated entry in-window (over-trigger) → fail', () => {
    expect(matchTrades([g()], [gen(), gen({ entryTs: 11_000_000, exitTs: 11_060_000 })], win).ok).toBe(false);
  });
  it('missing generated match (under-trigger) → fail', () => {
    expect(matchTrades([g()], [], win).ok).toBe(false);
  });
  it('other↔other match is flagged', () => {
    const r = matchTrades([g({ closeReason: 'weird', closeReasonRaw: null })], [gen({ closeReason: 'mystery' })], win);
    expect(r.flaggedOtherOther.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run RED** — `pnpm vitest run apps/backtester/test/long-oi-parity/match-trades.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
import { normalizeCloseReason } from './normalize-close-reason.ts';
import type { SignalParityGoldenTrade } from './golden-types.ts';
import type { GeneratedTrade } from './run-long-oi.ts';

export interface ParityReport {
  ok: boolean;
  matched: { goldenId: string; pnlDeltaPct: number; reasonBucket: string }[];
  failures: string[];
  flaggedOtherOther: string[];
}

export function scorableGolden(golden: SignalParityGoldenTrade[], firstRowTs: number, warmupMs = 60 * 60_000): SignalParityGoldenTrade[] {
  return golden.filter((t) => t.openedAtMs >= firstRowTs + warmupMs);
}

export function matchTrades(
  golden: SignalParityGoldenTrade[],
  generated: GeneratedTrade[],
  window: { startMs: number; endMs: number },
  tolPct = 0.05,
): ParityReport {
  const failures: string[] = [];
  const matched: ParityReport['matched'] = [];
  const flaggedOtherOther: string[] = [];
  const inWin = (ts: number) => ts >= window.startMs && ts <= window.endMs;

  const genByEntry = new Map(generated.map((t) => [t.entryTs, t]));
  for (const gt of golden) {
    const m = genByEntry.get(gt.openedAtMs);
    if (!m) { failures.push(`no generated entry at ${gt.openedAtMs} (golden ${gt.tradeId})`); continue; }
    if (m.side !== gt.side) failures.push(`side mismatch ${gt.tradeId}: ${m.side} != ${gt.side}`);
    if (m.exitTs !== gt.closedAtMs) failures.push(`exit bar mismatch ${gt.tradeId}: ${m.exitTs} != ${gt.closedAtMs}`);
    const gBucket = normalizeCloseReason(gt.closeReasonRaw ?? gt.closeReason); // raw-first: closeReasonRaw (tp2/hard_stop) is more specific than the generalized closeReason
    const mBucket = normalizeCloseReason(m.closeReason);
    if (gBucket !== mBucket) failures.push(`close-reason mismatch ${gt.tradeId}: ${mBucket} != ${gBucket}`);
    else if (gBucket === 'other') flaggedOtherOther.push(gt.tradeId);
    const delta = Math.abs(m.pnlPct - Number(gt.pnlPct));
    if (delta > tolPct) failures.push(`pnl% delta ${delta.toFixed(4)} > ${tolPct} (${gt.tradeId})`);
    matched.push({ goldenId: gt.tradeId, pnlDeltaPct: delta, reasonBucket: mBucket });
  }

  // over-trigger: every in-window generated entry must correspond to a golden entry
  const goldenEntry = new Set(golden.map((t) => t.openedAtMs));
  for (const m of generated) {
    if (inWin(m.entryTs) && !goldenEntry.has(m.entryTs)) failures.push(`extra generated entry at ${m.entryTs} (not in golden)`);
  }
  return { ok: failures.length === 0, matched, failures, flaggedOtherOther };
}
```

- [ ] **Step 4: Green + commit**

Run tests → PASS. `pnpm typecheck` → clean.
```bash
git add apps/backtester/test/long-oi-parity/match-trades.ts apps/backtester/test/long-oi-parity/match-trades.test.ts
git commit -m "test(long-oi-parity): scorableGolden warmup filter + matchTrades signal comparison (Task 4)"
```

---

### Task 5: Integration CI test + determinism (the acceptance)

**Files:**
- Test: `apps/backtester/test/long-oi-parity/signal-parity.test.ts`

**Interfaces:**
- Consumes: fixture (Task 2), `runLongOiOnRows` (Task 3), `scorableGolden`/`matchTrades` (Task 4).

- [ ] **Step 1: Write the integration test**

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLongOiOnRows } from './run-long-oi.ts';
import { scorableGolden, matchTrades } from './match-trades.ts';
import type { SignalParityFixture } from './golden-types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(readFileSync(resolve(HERE, '../fixtures/exec-validation/long-oi-signal-parity.json'), 'utf8')) as SignalParityFixture;
const firstTs = fx.rows[0]!.minute_ts;
const lastTs = fx.rows.at(-1)!.minute_ts;
const WARMUP = 60 * 60_000;

describe('long_oi signal-parity (G7 Stage 1)', () => {
  it('scorable window keeps exactly 8 trades; excluded set is exactly {00:04}', () => {
    const scorable = scorableGolden(fx.trades, firstTs, WARMUP);
    expect(scorable).toHaveLength(8);
    const excluded = fx.trades.filter((t) => !scorable.includes(t)).map((t) => new Date(t.openedAtMs).toISOString());
    expect(excluded).toEqual(['2026-06-18T00:04:00.000Z']);
  });

  it('backtest reproduces the 8 scorable golden trades (signals exact, pnl in tol, no extra in-window)', async () => {
    const generated = await runLongOiOnRows(fx.rows, fx.symbol);
    expect(generated.length).toBeGreaterThan(0); // tradeCount=0 hard fail
    const scorable = scorableGolden(fx.trades, firstTs, WARMUP);
    const report = matchTrades(scorable, generated, { startMs: firstTs + WARMUP, endMs: lastTs });
    if (!report.ok) console.error('parity failures:\n' + report.failures.join('\n'));
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.matched).toHaveLength(8);
    // other↔other is "flagged, not silently passed": a matched pair both normalizing to
    // 'other' is NOT a real signal-parity match. For the ESPORTSUSDT golden (all TP/SL) this
    // must be empty; a non-empty set fails acceptance even if failures[] is empty.
    expect(report.flaggedOtherOther).toEqual([]);
  }, 30_000);

  it('is deterministic (two runs → identical trades)', async () => {
    const a = await runLongOiOnRows(fx.rows, fx.symbol);
    const b = await runLongOiOnRows(fx.rows, fx.symbol);
    expect(b).toEqual(a);
  }, 30_000);
});
```

- [ ] **Step 2: Run**

Run: `pnpm vitest run apps/backtester/test/long-oi-parity/signal-parity.test.ts`
Expected: all 3 PASS.
**If the parity test fails on pnl only** (signals match, `pnl% delta > tol`): the golden pnl% was produced by the paper host's fill model (possibly with fees/slippage) while the harness uses `SAME_BAR_NO_COST`. Do NOT loosen signal assertions. First confirm entry/exit fill PRICES: compare `generated.entryFillPrice`/`exitFillPrice` to golden `entryPrice`/`exitPrice` — if prices match but pnl% differs, the golden pnl% includes costs; either raise `tolPct` to the observed cost delta (document it) or switch the run to a cost profile matching the paper host (`REALISM_EXEC` in `apps/backtester/src/engine/profiles.ts`). Record the decision in the test comment. **If entry/exit BARS differ**, that is a real signal-faithfulness finding — stop and report it (do not paper over with tolerance).

- [ ] **Step 3: Full-suite gate + commit**

Run: `pnpm test` (full backtester suite) → green (record pass count; this test is additive). `pnpm typecheck` → clean.
```bash
git add apps/backtester/test/long-oi-parity/signal-parity.test.ts
git commit -m "test(long-oi-parity): integration acceptance — long_oi backtest == recorded golden (G7 Stage 1) (Task 5)"
```

---

## Self-Review

**Spec coverage:**
- §0/§1 goal + anchor + 8 scorable → Tasks 2 (fixture), 4 (scorable), 5 (acceptance). ✅
- §2 architecture (extend exec-validation, real module via runBacktest) → Task 3. ✅
- Task 0 (module source: vendor + drift guard) → Task 0. ✅
- §3 warmup 60min + exclude {00:04} → Task 4 (`scorableGolden`) + Task 5 assertion. ✅
- §4 signal-match (entry/exit ±0, side, normalized reason, pnl tol) + no-extra → Task 4 (`matchTrades`). ✅
- §4a close-reason normalization incl `hard_stop` + other↔other flag → Task 1 + Task 4. ✅
- §4 `SignalParityGoldenTrade` preserves closeReasonRaw/entry/exit → Task 2. ✅
- §5 determinism + tradeCount=0 hard fail + offline → Task 3 (smoke) + Task 5 (determinism). ✅
- §8 risks (module source, fill divergence, exit-reason drift) → Task 0 Step 3, Task 5 Step 2, Task 1 Step 1. ✅

**Placeholder scan:** Two deliberate plan-time lookups, both fully specified with a procedure: (a) Task 1 Step 1 reads the engine `CloseReason` literals from `artifacts.ts:108` and folds them into the map (the canonical buckets + rule are given); (b) Task 0 Step 3 resolves `.js`→`.ts` specifier convention by matching sibling files (the fix procedure is given). No `TODO`/`TBD`/vague steps.

**Type consistency:** `SignalParityGoldenTrade`/`SignalParityFixture` (Task 2) consumed verbatim in Tasks 4/5. `GeneratedTrade` (Task 3) consumed in Task 4/5. `normalizeCloseReason`/`CanonicalCloseReason` (Task 1) consumed in Task 4. `scorableGolden`/`matchTrades`/`ParityReport` (Task 4) consumed in Task 5. Warmup constant `60*60_000` consistent across Task 4 default + Task 5. Fixture path `apps/backtester/test/fixtures/exec-validation/long-oi-signal-parity.json` consistent across Tasks 2/3/5.
