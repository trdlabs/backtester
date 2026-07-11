# Bar-major execution flip (Slice A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in bar-major execution mode where a multi-symbol run processes all symbols per union-timestamp (instead of symbol-major), each symbol on its own per-symbol `Portfolio`, aggregated into one equal-weight-basket result.

**Architecture:** `simulateTarget` branches on a new `barMajor` flag. For N>1 it runs `runBarMajor`, which builds one `BarEnv` per symbol (own `Portfolio` + own `RunAccumulators`), interleaves the existing `preBarStages`/`processBar` steps across a sorted union timeline (tie-break `request.symbols` order), then aggregates the N per-symbol accumulators into one via pure functions (temporal-sum equity, deterministic merge). Symbol-major and N=1 paths are byte-identical.

**Tech Stack:** TypeScript, Vitest, existing engine (`runner.ts`, `portfolio.ts`, `metrics.ts`), config via env vars.

## Global Constraints

- `INITIAL_EQUITY = 10_000` (from `apps/backtester/src/engine/metrics.ts`). Each symbol's portfolio starts here.
- Flag `BACKTESTER_BAR_MAJOR` default **OFF**; bar-major engages ONLY when `barMajor === true && request.symbols.length > 1`.
- `BACKTESTER_BAR_MAJOR` + `BACKTESTER_BAR_BATCHING` both true → **fail-fast at `loadConfig`** with a stable error string.
- Deterministic `result_hash`. The symbol-major default path AND any N=1 run stay **byte-identical** to today.
- Reuse `preBarStages` / `processBar` **unchanged**. The bar-major driver only changes which `BarEnv` they run against and in what order.
- Tie-break contract: iterate `unionTs` ASC; within a timestamp, symbols in strict `request.symbols` order.
- `t_local` = the symbol's own candle index, advanced only when that symbol has a candle at the current ts.
- Aggregation = equal-weight basket: per-symbol 10k accounts; aggregate equity = temporal sum with absent-symbol carry-forward (default 10k before a symbol's first bar).
- Shared multi-position portfolio (Variant B) is OUT OF SCOPE.

Spec: `docs/superpowers/specs/2026-07-07-bar-major-execution-flip-design.md`.

---

### Task 1: Config flag + mutual-exclusion fail-fast

**Files:**
- Modify: `apps/backtester/src/config.ts` (`AppConfig` interface ~line 115; `loadConfig` ~line 278)
- Test: `apps/backtester/test/config-bar-major.test.ts`

**Interfaces:**
- Produces: `AppConfig.barMajor: boolean`; `loadConfig` throws on the mutex violation.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/backtester/test/config-bar-major.test.ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('BACKTESTER_BAR_MAJOR config', () => {
  it('defaults barMajor to false', () => {
    const cfg = loadConfig({});
    expect(cfg.barMajor).toBe(false);
  });

  it('parses barMajor=true', () => {
    const cfg = loadConfig({ BACKTESTER_BAR_MAJOR: 'true' });
    expect(cfg.barMajor).toBe(true);
  });

  it('fails fast when bar-major AND bar-batching are both enabled', () => {
    expect(() => loadConfig({ BACKTESTER_BAR_MAJOR: 'true', BACKTESTER_BAR_BATCHING: 'true' })).toThrow(
      'BACKTESTER_BAR_MAJOR and BACKTESTER_BAR_BATCHING cannot both be enabled',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/backtester/test/config-bar-major.test.ts`
Expected: FAIL (`cfg.barMajor` is `undefined`; no throw).

Note: `loadConfig`'s parameter is the env object. Confirm its exact call shape by reading `config.ts` first; adapt the test's `loadConfig({...})` call to match the real signature (it may read `process.env` — if so, set/reset env vars in the test instead of passing an arg).

- [ ] **Step 3: Add the field and validation**

In `AppConfig` (near `readonly barBatching: boolean;`):

```typescript
  readonly barMajor: boolean;
```

In `loadConfig`, near `barBatching: env.BACKTESTER_BAR_BATCHING === 'true',` add:

```typescript
    barMajor: env.BACKTESTER_BAR_MAJOR === 'true',
```

And immediately after the object is built (or before returning), add the mutex guard:

```typescript
  if (env.BACKTESTER_BAR_MAJOR === 'true' && env.BACKTESTER_BAR_BATCHING === 'true') {
    throw new Error('BACKTESTER_BAR_MAJOR and BACKTESTER_BAR_BATCHING cannot both be enabled');
  }
```

Place the guard so it runs during `loadConfig` (fail-fast) regardless of the resolved object.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/backtester/test/config-bar-major.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/config.ts apps/backtester/test/config-bar-major.test.ts
git commit -m "feat(config): BACKTESTER_BAR_MAJOR flag + bar-batching mutual-exclusion fail-fast"
```

---

### Task 2: Pure aggregation module (temporal-sum equity + deterministic merge)

**Files:**
- Create: `apps/backtester/src/engine/bar-major-aggregate.ts`
- Modify: `apps/backtester/src/engine/runner.ts` — add `export` to the `RunAccumulators` interface (~line 138) so the aggregate module and tests can import it.
- Test: `apps/backtester/test/bar-major-aggregate.test.ts`

**Interfaces:**
- Consumes: `RunAccumulators` (from `runner.ts`), `EquityPoint`/`Trade` (from `artifacts.ts`), `INITIAL_EQUITY` (from `metrics.ts`).
- Produces:
  - `aggregateEquityCurve(perSymbolCurves: readonly (readonly EquityPoint[])[]): EquityPoint[]`
  - `mergeAccumulators(perSymbol: readonly RunAccumulators[]): RunAccumulators` — index order IS `request.symbols` order.

- [ ] **Step 1: Export `RunAccumulators`**

In `apps/backtester/src/engine/runner.ts`, change `interface RunAccumulators {` to `export interface RunAccumulators {`.

- [ ] **Step 2: Write the failing test**

```typescript
// apps/backtester/test/bar-major-aggregate.test.ts
import { describe, expect, it } from 'vitest';
import type { EquityPoint } from '../src/engine/artifacts.js';
import type { RunAccumulators } from '../src/engine/runner.js';
import { aggregateEquityCurve, mergeAccumulators } from '../src/engine/bar-major-aggregate.js';

const P = (barIndex: number, barTs: number, equity: number): EquityPoint => ({ barIndex, barTs, equity });

describe('aggregateEquityCurve (temporal sum, carry-forward)', () => {
  it('sums two fully-aligned symbols point-wise', () => {
    const a = [P(0, 100, 10_100), P(1, 200, 10_050)];
    const b = [P(0, 100, 9_900), P(1, 200, 9_800)];
    expect(aggregateEquityCurve([a, b])).toEqual([
      { barIndex: 0, barTs: 100, equity: 20_000 },
      { barIndex: 1, barTs: 200, equity: 19_850 },
    ]);
  });

  it('carries forward: absent-before-first is INITIAL_EQUITY, absent-after-last holds last', () => {
    // symbol A: bars at ts 100,200. symbol B: bar only at ts 200.
    const a = [P(0, 100, 10_100), P(1, 200, 10_200)];
    const b = [P(0, 200, 9_500)];
    // ts=100: A=10_100, B not started → 10_000 ⇒ 20_100
    // ts=200: A=10_200, B=9_500 ⇒ 19_700
    expect(aggregateEquityCurve([a, b])).toEqual([
      { barIndex: 0, barTs: 100, equity: 20_100 },
      { barIndex: 1, barTs: 200, equity: 19_700 },
    ]);
  });

  it('carries a symbol that ends early at its last equity', () => {
    const a = [P(0, 100, 10_100)]; // ends at ts 100
    const b = [P(0, 100, 9_900), P(1, 200, 9_700)];
    // ts=100: 10_100 + 9_900 = 20_000; ts=200: A holds 10_100 + B 9_700 = 19_800
    expect(aggregateEquityCurve([a, b])).toEqual([
      { barIndex: 0, barTs: 100, equity: 20_000 },
      { barIndex: 1, barTs: 200, equity: 19_800 },
    ]);
  });
});

describe('mergeAccumulators (deterministic ordering)', () => {
  const emptyAcc = (): RunAccumulators => ({
    decisionRecords: [], orders: [], fills: [], riskDecisions: [],
    trades: [], equityCurve: [], fundingLedger: [], validationIssues: [],
  });

  it('merges trades by exitTs asc then request.symbols order', () => {
    const accA = emptyAcc();
    const accB = emptyAcc();
    (accA.trades as unknown[]).push({ symbol: 'A', exitTs: 200, id: 'a2' }, { symbol: 'A', exitTs: 100, id: 'a1' });
    (accB.trades as unknown[]).push({ symbol: 'B', exitTs: 100, id: 'b1' });
    const merged = mergeAccumulators([accA, accB]);
    expect(merged.trades.map((t) => (t as { id: string }).id)).toEqual(['a1', 'b1', 'a2']);
  });

  it('aggregates equityCurve via temporal sum', () => {
    const accA = emptyAcc();
    const accB = emptyAcc();
    (accA.equityCurve as EquityPoint[]).push(P(0, 100, 10_100));
    (accB.equityCurve as EquityPoint[]).push(P(0, 100, 9_900));
    const merged = mergeAccumulators([accA, accB]);
    expect(merged.equityCurve).toEqual([{ barIndex: 0, barTs: 100, equity: 20_000 }]);
  });

  it('merges orders by decisionBarIndex asc, then request.symbols order on ties', () => {
    const accA = emptyAcc();
    const accB = emptyAcc();
    (accA.orders as unknown[]).push({ id: 'oa0', decisionBarIndex: 0 }, { id: 'oa2', decisionBarIndex: 2 });
    (accB.orders as unknown[]).push({ id: 'ob0', decisionBarIndex: 0 }, { id: 'ob1', decisionBarIndex: 1 });
    const merged = mergeAccumulators([accA, accB]);
    // idx0: A before B (symbolIndex tie-break) → oa0, ob0; then idx1 ob1; then idx2 oa2
    expect(merged.orders.map((o) => (o as { id: string }).id)).toEqual(['oa0', 'ob0', 'ob1', 'oa2']);
  });

  it('concatenates key-less validationIssues in request.symbols order', () => {
    const accA = emptyAcc();
    const accB = emptyAcc();
    (accA.validationIssues as unknown[]).push({ code: 'a1' }, { code: 'a2' });
    (accB.validationIssues as unknown[]).push({ code: 'b1' });
    const merged = mergeAccumulators([accA, accB]);
    expect(merged.validationIssues.map((v) => (v as { code: string }).code)).toEqual(['a1', 'a2', 'b1']);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run apps/backtester/test/bar-major-aggregate.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement the aggregation module**

```typescript
// apps/backtester/src/engine/bar-major-aggregate.ts
import type { EquityPoint } from './artifacts.js';
import type { RunAccumulators } from './runner.js';
import { INITIAL_EQUITY } from './metrics.js';

/**
 * Temporal-sum aggregate equity across per-symbol curves (index order = request.symbols order).
 * At each union timestamp, aggregate = Σ each symbol's equity at the greatest bar ≤ ts, or
 * INITIAL_EQUITY before that symbol's first bar (absent-symbol carry-forward).
 */
export function aggregateEquityCurve(perSymbolCurves: readonly (readonly EquityPoint[])[]): EquityPoint[] {
  const tsSet = new Set<number>();
  for (const curve of perSymbolCurves) for (const p of curve) tsSet.add(p.barTs);
  const unionTs = [...tsSet].sort((a, b) => a - b);
  const ptr = perSymbolCurves.map(() => 0);
  const last = perSymbolCurves.map(() => INITIAL_EQUITY);
  const out: EquityPoint[] = [];
  for (let u = 0; u < unionTs.length; u += 1) {
    const ts = unionTs[u];
    let sum = 0;
    for (let s = 0; s < perSymbolCurves.length; s += 1) {
      const curve = perSymbolCurves[s];
      while (ptr[s] < curve.length && curve[ptr[s]].barTs <= ts) {
        last[s] = curve[ptr[s]].equity;
        ptr[s] += 1;
      }
      sum += last[s];
    }
    out.push({ barIndex: u, barTs: ts, equity: sum });
  }
  return out;
}

/** Stable temporal merge: primary numeric key asc, then symbol (list) index, then per-list index. */
function mergeByKey<T>(lists: readonly (readonly T[])[], keyOf: (item: T) => number): T[] {
  const tagged = lists.flatMap((list, symbolIndex) => list.map((item, origIndex) => ({ item, symbolIndex, origIndex })));
  tagged.sort((a, b) => keyOf(a.item) - keyOf(b.item) || a.symbolIndex - b.symbolIndex || a.origIndex - b.origIndex);
  return tagged.map((t) => t.item);
}

/** Concat per-symbol in request.symbols (index) order, preserving each list's own order. */
function concatBySymbol<T>(lists: readonly (readonly T[])[]): T[] {
  return lists.flatMap((list) => [...list]);
}

/**
 * Merge N per-symbol accumulators (index order = request.symbols order) into one.
 * Every list with a stable numeric key is sorted by (key asc, symbolIndex, per-symbol index);
 * ONLY a genuinely key-less list (validationIssues) falls back to deterministic per-symbol concat.
 * Confirmed field keys (from artifacts.ts / runner.ts):
 *   equityCurve  → temporal sum (special)
 *   trades       → Trade.exitTs           (real ts)
 *   decisionRecords → DecisionRecord.barTs (real ts)
 *   fills        → SimulatedFill.fillTs    (real ts)
 *   fundingLedger → FundingLedgerEntry.ts  (real ts)
 *   orders       → MutableOrder.decisionBarIndex (per-symbol bar index — no ts on the type)
 *   riskDecisions → RiskDecision.barIndex  (per-symbol bar index — no ts on the type)
 *   validationIssues → { code, severity, path?, message } — no numeric key → concat per symbol
 */
export function mergeAccumulators(perSymbol: readonly RunAccumulators[]): RunAccumulators {
  return {
    equityCurve: aggregateEquityCurve(perSymbol.map((a) => a.equityCurve)),
    trades: mergeByKey(perSymbol.map((a) => a.trades), (t) => t.exitTs),
    decisionRecords: mergeByKey(perSymbol.map((a) => a.decisionRecords), (r) => r.barTs),
    fills: mergeByKey(perSymbol.map((a) => a.fills), (f) => f.fillTs),
    fundingLedger: mergeByKey(perSymbol.map((a) => a.fundingLedger), (f) => f.ts),
    orders: mergeByKey(perSymbol.map((a) => a.orders), (o) => o.decisionBarIndex),
    riskDecisions: mergeByKey(perSymbol.map((a) => a.riskDecisions), (r) => r.barIndex),
    validationIssues: concatBySymbol(perSymbol.map((a) => a.validationIssues)),
  };
}
```

The keys above are verified against the real interfaces. `mergeByKey`'s stable tertiary sort (per-symbol original index) keeps ties deterministic where a numeric key repeats across symbols (e.g. `decisionBarIndex` is per-symbol-local, so index N exists for every symbol — the symbolIndex tie-break then orders them by `request.symbols`).

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run apps/backtester/test/bar-major-aggregate.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/backtester/src/engine/bar-major-aggregate.ts apps/backtester/test/bar-major-aggregate.test.ts apps/backtester/src/engine/runner.ts
git commit -m "feat(engine): bar-major result aggregation (temporal-sum equity + deterministic merge)"
```

---

### Task 3: Refactor `runSymbol` — extract per-symbol setup + teardown (byte-identical)

**Files:**
- Modify: `apps/backtester/src/engine/runner.ts` (`runSymbol` ~lines 503-582)

**Interfaces:**
- Produces (module-private, used by Task 4):
  - `async function buildBarEnv(symbol, candles, builder, strategy, overlays, portfolio, engine, acc, marketTape, barBatching): Promise<BarEnv>` — constructs `BarEnv` and calls `strategyExec.initStrategy?.` (the setup half of today's `runSymbol`).
  - `async function finalizeSymbol(env: BarEnv): Promise<void>` — the end-of-data half: `expirePending` + order status fix, `forcedMtmClose`, `disposeStrategy?.`.

This is a **refactor-first** step (no behavior change). `runSymbol` becomes `buildBarEnv` → existing per-bar loop → `finalizeSymbol`. All existing goldens must stay byte-identical.

- [ ] **Step 1: Extract `buildBarEnv` and `finalizeSymbol`**

Move the setup lines from `runSymbol` (`gridMinutes`/`fundingCol`/`gridTs`/`module`/`strategyExec` derivation, the `initStrategy` call, and the `env` construction) into `buildBarEnv`, returning the `env`.

**Empty-candles contract:** the `if (candles.length === 0) return;` early-return **stays in `runSymbol`** (before `buildBarEnv`), so a data-less symbol still does NO init — byte-identical to today. `buildBarEnv` and `finalizeSymbol` may therefore assume `candles.length >= 1`. `runBarMajor` (Task 4) enforces the same by `continue`-ing past empty symbols in Phase 1, so it never inits a data-less symbol either.

Move the end-of-data block (`expirePending` + order-status fix, `forcedMtmClose`, `disposeStrategy`) into `finalizeSymbol(env)`, reading `n = env.candles.length`, `last = env.candles[n-1]`, etc.

Rewrite `runSymbol` as:

```typescript
async function runSymbol(
  symbol: string,
  candles: readonly Readonly<Bar>[],
  builder: PointInTimeContextBuilder,
  strategy: ResolvedStrategy,
  overlays: OverlaySplit,
  portfolio: Portfolio,
  engine: SimEngine,
  acc: RunAccumulators,
  marketTape: MarketTapeDataset | undefined,
  barBatching: { readonly maxBars: number } | undefined,
): Promise<void> {
  if (candles.length === 0) return;
  const env = await buildBarEnv(symbol, candles, builder, strategy, overlays, portfolio, engine, acc, marketTape, barBatching);
  const n = candles.length;
  for (let t = 0; t < n; t += 1) {
    // ... existing per-bar loop body UNCHANGED (preBarStages / batch branch / processBar) ...
  }
  await finalizeSymbol(env);
}
```

Keep the per-bar loop body exactly as today.

- [ ] **Step 2: Run the full engine suite to verify byte-identity**

Run: `npx vitest run apps/backtester/test/ -t "golden|result_hash|equivalence|runner|simulate"`
Expected: PASS with no golden hash changes. If any golden differs, the extraction changed behavior — revert and redo so `runSymbol` is a pure re-expression.

(If unsure which suites cover goldens, run the broader `npx vitest run apps/backtester/test/` and confirm all previously-green tests stay green.)

- [ ] **Step 3: Commit**

```bash
git add apps/backtester/src/engine/runner.ts
git commit -m "refactor(engine): extract buildBarEnv/finalizeSymbol from runSymbol (byte-identical)"
```

---

### Task 4: `runBarMajor` driver + `simulateTarget` branch

**Files:**
- Modify: `apps/backtester/src/engine/runner.ts` (`RunDeps` ~line 61; `simulateTarget` ~lines 585-642; `runBacktest` call sites ~lines 824/838; new `runBarMajor`)
- Test: `apps/backtester/test/bar-major-runner.test.ts`

**Interfaces:**
- Consumes: `buildBarEnv`, `finalizeSymbol` (Task 3); `preBarStages`, `processBar`, `stateAt`, `firstDecision`, `splitOverlays`, `createSeededRng`, `PointInTimeContextBuilder` (existing); `mergeAccumulators` (Task 2).
- Produces: `RunDeps.barMajor?: boolean`; `simulateTarget(..., barMajor: boolean)`.

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/backtester/test/bar-major-runner.test.ts
import { describe, expect, it } from 'vitest';
// Build a minimal 2-symbol trusted run via the same harness the existing runner/golden tests use.
// Reuse an existing multi-symbol fixture + RunDeps builder from a sibling runner test
// (e.g. the universe or simulate golden test) — import its helpers rather than re-deriving.
import { runBacktest } from '../src/engine/runner.js';
import { makeMultiSymbolDeps, makeRequest, resultHash } from './helpers/bar-major-fixture.js';

describe('bar-major execution flip', () => {
  it('N=1 is byte-identical to symbol-major (flag has no effect on one symbol)', async () => {
    const req = makeRequest(['BTCUSDT']);
    const off = await runBacktest(req, makeMultiSymbolDeps({ barMajor: false }));
    const on = await runBacktest(req, makeMultiSymbolDeps({ barMajor: true }));
    expect(resultHash(on)).toBe(resultHash(off));
  });

  it('N>1 bar-major is deterministic across two identical runs', async () => {
    const req = makeRequest(['BTCUSDT', 'ETHUSDT']);
    const a = await runBacktest(req, makeMultiSymbolDeps({ barMajor: true }));
    const b = await runBacktest(req, makeMultiSymbolDeps({ barMajor: true }));
    expect(resultHash(a)).toBe(resultHash(b));
  });

  it('N>1 bar-major differs from symbol-major (semantics changed, as designed)', async () => {
    const req = makeRequest(['BTCUSDT', 'ETHUSDT']);
    const major = await runBacktest(req, makeMultiSymbolDeps({ barMajor: true }));
    const symbolMajor = await runBacktest(req, makeMultiSymbolDeps({ barMajor: false }));
    expect(resultHash(major)).not.toBe(resultHash(symbolMajor));
  });
});
```

Create `apps/backtester/test/helpers/bar-major-fixture.js`(`.ts`) that assembles a deterministic 2-symbol dataset + trusted `RunDeps`. **First check** for an existing multi-symbol fixture/deps builder in `apps/backtester/test/` (the universe or simulate golden suites) and reuse it; only author a new tiny fixture if none exists. `resultHash` should hash the completed `RunOutcome.baseline` the same way the existing golden tests do (reuse that helper).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/backtester/test/bar-major-runner.test.ts`
Expected: FAIL (`barMajor` not accepted / no branch yet).

- [ ] **Step 3: Thread `barMajor` and add the branch**

Add to `RunDeps`:

```typescript
  readonly barMajor?: boolean;
```

Add a `barMajor: boolean` parameter to `simulateTarget` (after `barBatching`). At both `simulateTarget(...)` call sites in `runBacktest`, pass `deps.barMajor === true`.

In `simulateTarget`, replace the `for (const symbol of request.symbols) { ... await runSymbol(...) }` block with a branch:

```typescript
  let barsProcessed = 0;
  if (barMajor && request.symbols.length > 1) {
    barsProcessed = await runBarMajor(target, request, dataset, engine, acc, params, overlays, marketTape);
  } else {
    for (const symbol of request.symbols) {
      // ... today's per-symbol setup + await runSymbol(...) UNCHANGED ...
      barsProcessed += candles.length;
    }
  }
```

Note: today's symbol-major branch shares one `portfolio`/`acc`. Keep that block verbatim (byte-identical). `runBarMajor` builds its OWN per-symbol portfolios + accs and writes into the outer `acc` via aggregation.

- [ ] **Step 4: Implement `runBarMajor`**

```typescript
/** Bar-major driver: per-symbol Portfolio, interleaved by union timestamp, aggregated into `acc`. */
async function runBarMajor(
  target: RunTarget,
  request: BacktestRunRequest,
  dataset: CandleDataset,
  engine: SimEngine,
  acc: RunAccumulators,
  params: Record<string, unknown>,
  overlays: OverlaySplit,
  marketTape: MarketTapeDataset | undefined,
): Promise<number> {
  const envs: BarEnv[] = [];
  const perAcc: RunAccumulators[] = [];
  const finalized = new Set<BarEnv>();
  try {
    // Phase 1 — setup: one BarEnv (own Portfolio + own acc) per NON-EMPTY symbol.
    for (const symbol of request.symbols) {
      const candles = dataset.candles(symbol);
      if (candles.length === 0) continue; // parity with runSymbol's `n===0` early return — no init for a data-less symbol
      const builder = new PointInTimeContextBuilder({
        run: { runId: target.runId, mode: request.mode, seed: request.seed },
        params, symbol, candles, rng: createSeededRng(request.seed),
        ...(marketTape !== undefined ? { marketTape } : {}),
      });
      const symbolStrategy = target.strategy.moduleFactory !== undefined
        ? { ...target.strategy, module: target.strategy.moduleFactory(params) }
        : target.strategy;
      const symAcc: RunAccumulators = {
        decisionRecords: [], orders: [], fills: [], riskDecisions: [],
        trades: [], equityCurve: [], fundingLedger: [], validationIssues: [],
      };
      const portfolio = new Portfolio(INITIAL_EQUITY);
      // barBatching is undefined in bar-major (flags mutually exclusive).
      const env = await buildBarEnv(symbol, candles, builder, symbolStrategy, overlays, portfolio, engine, symAcc, marketTape, undefined);
      envs.push(env);
      perAcc.push(symAcc);
    }

    // Phase 2 — bar-major loop over the sorted union timeline; per-symbol cursor.
    const cursor = envs.map(() => 0);
    const tsSet = new Set<number>();
    for (const env of envs) for (const c of env.candles) tsSet.add(c.ts);
    const unionTs = [...tsSet].sort((a, b) => a - b);
    for (const ts of unionTs) {
      for (let s = 0; s < envs.length; s += 1) {   // request.symbols order (envs built in that order)
        const env = envs[s];
        const t = cursor[s];
        if (env.candles[t]?.ts !== ts) continue;   // symbol absent at this ts
        preBarStages(env, t);
        const ctx = env.builder.build(t, stateAt(env.portfolio, env.candles[t].close));
        const base = firstDecision(await env.strategyExec.executeStrategyHook(env.module, 'onBarClose', ctx));
        await processBar(env, t, base);
        cursor[s] += 1;
      }
    }

    // Phase 3 — teardown per symbol in request.symbols order.
    let barsProcessed = 0;
    for (const env of envs) {
      await finalizeSymbol(env);
      finalized.add(env);
      barsProcessed += env.candles.length;
    }

    // Phase 4 — aggregate N per-symbol accs into the outer acc.
    const merged = mergeAccumulators(perAcc);
    acc.decisionRecords.push(...merged.decisionRecords);
    acc.orders.push(...merged.orders);
    acc.fills.push(...merged.fills);
    acc.riskDecisions.push(...merged.riskDecisions);
    acc.trades.push(...merged.trades);
    acc.equityCurve.push(...merged.equityCurve);
    acc.fundingLedger.push(...merged.fundingLedger);
    acc.validationIssues.push(...merged.validationIssues);
    return barsProcessed;
  } finally {
    // Best-effort teardown of any env built but not finalized (setup/loop threw mid-way): bar-major
    // holds N live module instances at once, so a partial failure must not leak per-symbol resources.
    // Sandbox container sessions are also closed by runBacktest's `finally { router.closeAll(); }`;
    // this covers the trusted `module.dispose` seam and is idempotent-safe via the `finalized` guard.
    for (const env of envs) {
      if (finalized.has(env)) continue;
      try {
        await env.strategyExec.disposeStrategy?.(
          env.module,
          env.builder.build(env.candles.length - 1, stateAt(env.portfolio, env.candles[env.candles.length - 1].close)),
        );
      } catch {
        /* best-effort cleanup — swallow so the original error propagates */
      }
    }
  }
}
```

`BarEnv.portfolio`/`BarEnv.acc` are `readonly` but reference the per-symbol objects created here (each env gets its own). Confirm `buildBarEnv` accepts and stores the passed `portfolio`/`acc` (it does — that mirrors `runSymbol` today). The outer `acc` is the target's accumulator that `assembleResult` reads.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run apps/backtester/test/bar-major-runner.test.ts`
Expected: PASS (N=1 identity, N>1 determinism, N>1 ≠ symbol-major).

- [ ] **Step 6: Run the full suite (guard byte-identity of default path)**

Run: `npx vitest run apps/backtester/test/`
Expected: all previously-green tests still green (symbol-major goldens unchanged).

- [ ] **Step 7: Commit**

```bash
git add apps/backtester/src/engine/runner.ts apps/backtester/test/bar-major-runner.test.ts apps/backtester/test/helpers/
git commit -m "feat(engine): bar-major execution driver (per-symbol portfolio, union-timeline interleave)"
```

---

### Task 5: Capital-model metadata (backtester-local, bar-major only)

**Files:**
- Modify: `apps/backtester/src/engine/artifacts.ts` (`RunEvidence` ~line 177)
- Modify: `apps/backtester/src/engine/runner.ts` (`assembleResult` + `simulateTarget`/`runBarMajor`)
- Test: extend `apps/backtester/test/bar-major-runner.test.ts`

**Interfaces:**
- Produces: optional `RunEvidence.capitalModel?: { model: 'equal_weight_per_symbol'; perSymbolInitialEquity: number; symbolCount: number; aggregateBaseline: number }`.

**Note:** This adds the field to the **backtester-local** `RunEvidence` only. Mirroring it into the SDK contract (`packages/sdk/src/contracts/run.ts`) is a deliberate **follow-up** (SDK version bump), out of this slice. The field is omitted on the symbol-major path → default/N=1 stays byte-identical.

- [ ] **Step 1: Write the failing test (append to bar-major-runner.test.ts)**

```typescript
  it('emits capitalModel metadata for bar-major N>1 and omits it for symbol-major', async () => {
    const req = makeRequest(['BTCUSDT', 'ETHUSDT']);
    const major = await runBacktest(req, makeMultiSymbolDeps({ barMajor: true }));
    const symbolMajor = await runBacktest(req, makeMultiSymbolDeps({ barMajor: false }));
    if (major.status !== 'completed' || symbolMajor.status !== 'completed') throw new Error('expected completed');
    expect(major.baseline.evidence.capitalModel).toEqual({
      model: 'equal_weight_per_symbol',
      perSymbolInitialEquity: 10_000,
      symbolCount: 2,
      aggregateBaseline: 20_000,
    });
    expect(symbolMajor.baseline.evidence.capitalModel).toBeUndefined();
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run apps/backtester/test/bar-major-runner.test.ts -t capitalModel`
Expected: FAIL (`capitalModel` undefined on bar-major).

- [ ] **Step 3: Add the optional field + thread it**

In `artifacts.ts` `RunEvidence`, add:

```typescript
  /** Bar-major (Slice A) only: how N per-symbol accounts were capitalised + aggregated. Omitted for symbol-major. */
  readonly capitalModel?: {
    readonly model: 'equal_weight_per_symbol';
    readonly perSymbolInitialEquity: number;
    readonly symbolCount: number;
    readonly aggregateBaseline: number;
  };
```

Give `assembleResult` an optional `capitalModel?` param and spread it into `evidence` conditionally (mirror the existing `...(coverage !== undefined ? { coverage } : {})` pattern):

```typescript
    ...(capitalModel !== undefined ? { capitalModel } : {}),
```

In `simulateTarget`, when the bar-major branch runs, build:

```typescript
  const capitalModel = (barMajor && request.symbols.length > 1)
    ? { model: 'equal_weight_per_symbol' as const, perSymbolInitialEquity: INITIAL_EQUITY, symbolCount: request.symbols.length, aggregateBaseline: INITIAL_EQUITY * request.symbols.length }
    : undefined;
```

and pass it to `assembleResult`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run apps/backtester/test/bar-major-runner.test.ts`
Expected: PASS (including the byte-identity N=1 test — `capitalModel` is undefined there).

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/engine/artifacts.ts apps/backtester/src/engine/runner.ts apps/backtester/test/bar-major-runner.test.ts
git commit -m "feat(engine): emit capitalModel metadata on bar-major results (backtester-local)"
```

---

### Task 6: Freeze N>1 golden + twin-equivalence (Docker-gated)

> **Ordering constraint:** this task MUST run **after Task 5**. The `capitalModel` evidence field
> (Task 5) is part of the bar-major result, so the frozen golden hash below must be captured with that
> field present. Do not freeze the golden before Task 5 lands.

**Files:**
- Test: `apps/backtester/test/bar-major-golden.test.ts`

**Interfaces:**
- Consumes: the committed multi-symbol fixture + deps from Task 4's helper.

- [ ] **Step 1: Write the golden test with a placeholder hash**

```typescript
// apps/backtester/test/bar-major-golden.test.ts
import { describe, expect, it } from 'vitest';
import { runBacktest } from '../src/engine/runner.js';
import { makeMultiSymbolDeps, makeRequest, resultHash } from './helpers/bar-major-fixture.js';

const BAR_MAJOR_GOLDEN = '__FILL_ME__';

describe('bar-major N>1 golden (new semantics)', () => {
  it('produces the committed bar-major result_hash on the fixture', async () => {
    const out = await runBacktest(makeRequest(['BTCUSDT', 'ETHUSDT']), makeMultiSymbolDeps({ barMajor: true }));
    expect(resultHash(out)).toBe(BAR_MAJOR_GOLDEN);
  });
});
```

- [ ] **Step 2: Run once to capture the hash**

Run: `npx vitest run apps/backtester/test/bar-major-golden.test.ts`
Expected: FAIL, printing the actual hash. Copy it into `BAR_MAJOR_GOLDEN`.

- [ ] **Step 3: Re-run to verify the frozen golden**

Run: `npx vitest run apps/backtester/test/bar-major-golden.test.ts`
Expected: PASS. This is the committed golden for the new bar-major semantics (NOT compared to symbol-major).

- [ ] **Step 4: Add a Docker-gated twin-equivalence test**

Add a test that runs the SAME fixture through the sandbox/universe executor and asserts its `result_hash` equals `BAR_MAJOR_GOLDEN`. Gate it behind the repo's existing Docker guard (the same `describe.skipIf(...)`/env check the universe golden tests use — reuse that helper; it skips on WSL2/CI without Docker and runs on the VPS). Report skip honestly (`ctx.skip()` / `describe.skipIf`), never a silent pass.

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/test/bar-major-golden.test.ts
git commit -m "test(engine): freeze bar-major N>1 golden + Docker-gated twin-equivalence"
```

---

### Task 7: Wire `barMajor` from config into app + worker

**Files:**
- Modify: `apps/backtester/src/app.ts` (`buildApp` ~line 156, near `barBatching: config.barBatching`)
- Modify: `apps/backtester/src/jobs/worker.ts` (`WorkerDeps` ~line 97; `processNextQueued` ~line 557)
- Test: extend an existing app/worker deps test, or add `apps/backtester/test/bar-major-wiring.test.ts`

**Interfaces:**
- Consumes: `AppConfig.barMajor` (Task 1), `RunDeps.barMajor` (Task 4).

- [ ] **Step 1: Write the failing test**

Assert that with `BACKTESTER_BAR_MAJOR=true` the worker/run path threads `barMajor: true` into the `RunDeps` passed to `runBacktest`. Model it on the existing `barBatching` wiring test if one exists; otherwise spy on the deps assembled in `processNextQueued`.

```typescript
// apps/backtester/test/bar-major-wiring.test.ts  (shape; adapt to existing deps-assembly seam)
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
// import the seam that maps AppConfig/WorkerDeps → RunDeps and assert barMajor flows through.
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run apps/backtester/test/bar-major-wiring.test.ts`
Expected: FAIL.

- [ ] **Step 3: Thread the flag**

- In `buildApp` (`app.ts`), where `barBatching: config.barBatching` is passed, add `barMajor: config.barMajor,` into the same deps object.
- In `worker.ts`: add `barMajor?: boolean;` to `WorkerDeps`; in `processNextQueued`, where `barBatching` is folded into the run deps, add `...(deps.barMajor === true ? { barMajor: true } : {}),`.
- Ensure the `AppConfig.barMajor` value reaches `WorkerDeps.barMajor` at the construction site (mirror how `barBatching` is passed).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run apps/backtester/test/bar-major-wiring.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/app.ts apps/backtester/src/jobs/worker.ts apps/backtester/test/bar-major-wiring.test.ts
git commit -m "feat: wire BACKTESTER_BAR_MAJOR from config into app + worker run deps"
```

---

### Task 8: Universe interleaving trace test (mandatory, low-level)

**Files:**
- Test: `apps/backtester/test/sandbox-session-universe-interleave.test.ts`

**Interfaces:**
- Consumes: the universe `SandboxSession` + `ScriptedDriver` harness from `apps/backtester/test/sandbox-session-universe.test.ts` (reuse its driver/bundle/ctx helpers).

This proves the universe session behaves correctly under the interleaved call order bar-major produces (`A0, B0, A1, B1, …`) — exercised for the first time.

- [ ] **Step 1: Write the test**

Drive a universe `SandboxSession` with interleaved per-symbol `callHook('onBarClose', ctx)` calls in the order `A@bar0, B@bar0, A@bar1, B@bar1`, scripting an `ok` reply per init + per hook (mirror the executor-universe harness). Capture, via the `RecordingWritable` stdin spy, the sequence of sent `hook` envelopes. Assert:

```typescript
// 1. The hook-call order is exactly the bar-major interleave.
expect(sentHookSymbols).toEqual(['A', 'B', 'A', 'B']);
// 2. Each symbol's newBar/barIndex bookkeeping is monotonic per symbol.
expect(barIndexBySymbol.get('A')).toEqual([0, 1]);
expect(barIndexBySymbol.get('B')).toEqual([0, 1]);
```

Extract the per-symbol bar index from each sent `hook` envelope's `snapshot`/`newBar` payload (inspect the envelope shape via the existing universe test to pick the right field). The point is a low-level trace assertion, not just a final-hash check.

- [ ] **Step 2: Run to verify (RED if a real interleave bug exists; GREEN confirms the session handles it)**

Run: `npx vitest run apps/backtester/test/sandbox-session-universe-interleave.test.ts`
Expected: PASS if per-symbol bookkeeping is interleave-safe. If it FAILS, that is a genuine universe-session bug surfaced by bar-major — fix it in `sandbox-session.ts` (per-symbol `readBookkeeping`/`writeBookkeeping` slot) before proceeding, with the failing trace as the regression.

- [ ] **Step 3: Commit**

```bash
git add apps/backtester/test/sandbox-session-universe-interleave.test.ts
git commit -m "test(sandbox): universe session bookkeeping is correct under bar-major interleave"
```

---

## Final verification

- [ ] Run the full suite: `npx vitest run apps/backtester/test/` — all green (Docker-gated twin-equivalence reported as skipped on WSL2, not failed).
- [ ] Typecheck: `npx tsc --noEmit -p tsconfig.json` — clean.
- [ ] Update `docs/ROADMAP.md` 17c/bar-major note: Slice A (execution flip) shipped; Slice B (sandbox transport collapse) is the remaining perf win. Commit.
