# E5a Novelty Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an advisory behavioral-novelty signal — daily-PnL-delta correlation of a run against a durable pool of prior runs on the same market — surfaced on `RunResultSummary.novelty`, dark-launched behind a default-OFF flag.

**Architecture:** A pure `novelty.ts` (daily-delta extraction + Pearson correlation + score) feeds a durable `NoveltyPool` store (InMemory + Pg, migration 0008). The worker finalize step, flag-gated, queries the pool (self-excluding the caller's own fingerprint), scores, then records — attaching `novelty` to the summary projection AFTER `contentRef(payload)` so `result_hash` stays byte-identical. Mirrors the E2/E4a/E1b advisory pattern exactly.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import specifiers), Vitest, `pg`, pnpm workspace, `@trading-backtester/sdk` (built with `pnpm sdk:build` before typecheck/tests).

## Global Constraints

- **Determinism invariant:** `result_hash = contentRef(payload)` MUST be byte-identical with the flag OFF. `novelty` lives ONLY on the non-hashed summary projection, attached after `contentRef`. `decideVerdict` is NOT touched.
- **Advisory + dark-launch:** `BACKTESTER_NOVELTY_ENABLED` default OFF. All new SDK fields are optional (`?`).
- **ESM imports:** every relative import ends in `.js` (e.g. `./novelty.js`). SDK types import from `@trading-backtester/sdk/contracts`.
- **Numbers are quantized** via `quantize` from `apps/backtester/src/determinism/canonical-json.js` before they enter stored/returned structures (deltas, ρ, score, maxAbsCorrelation).
- **Run from the repo root** (the worktree/checkout root, where `vitest.config.ts` lives). Single-file tests: `npx vitest run <path>`. Full suite: `npx vitest run` (its `pretest` runs `sdk:build` + overlay-harness build).
- **SDK type changes require `pnpm sdk:build`** before `tsc`/tests resolve them.
- **Comparability grouping is NOT the E2 family key:** `comparabilityKey = sha256(canonicalJson({datasetRef, symbols sorted, timeframe}))` — no `period`, no `trialFamilyHint`.

---

### Task 1: SDK contract — `Novelty` type + `RunResultSummary.novelty?`

**Files:**
- Modify: `packages/sdk/src/contracts/run.ts` (add types after the `RunDiagnostics` block ~line 92; add field to `RunResultSummary` ~line 235)
- Test: `packages/sdk/test/contracts.test.ts` (type-level smoke — the existing file compiles the contract surface)

**Interfaces:**
- Produces: `NoveltyNearest`, `Novelty` (discriminated union on `status`), `RunResultSummary.novelty?: Novelty`.

- [ ] **Step 1: Write the failing test**

Add to `packages/sdk/test/contracts.test.ts`:

```ts
import type { Novelty } from '../src/contracts/run.js';

it('Novelty union carries resolved + no_comparators shapes', () => {
  const resolved: Novelty = {
    status: 'resolved',
    score: 0.3,
    maxAbsCorrelation: 0.7,
    nearest: { ref: 'h1', runId: 'r1', correlation: 0.7, overlapDays: 40 },
    comparabilityKey: 'k',
    comparedAgainst: 2,
    behavioralDuplicate: false,
    policy: { threshold: 0.8, minOverlapDays: 30 },
  };
  const none: Novelty = {
    status: 'no_comparators',
    reason: 'empty_pool',
    comparabilityKey: 'k',
    policy: { threshold: 0.8, minOverlapDays: 30 },
  };
  expect(resolved.status).toBe('resolved');
  expect(none.status).toBe('no_comparators');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/sdk/test/contracts.test.ts`
Expected: FAIL — `Module '"../src/contracts/run.js"' has no exported member 'Novelty'` (or a tsc error surfaced by vitest).

- [ ] **Step 3: Add the types**

In `packages/sdk/src/contracts/run.ts`, immediately after the `RunDiagnostics` interface (before `BacktestRunRequest`):

```ts
// E5a — hypothesis novelty gate (advisory; NOT part of the hashed result). Behavioral distance of a
// run's daily-PnL-delta trajectory from prior runs on the same market (comparabilityKey). Doubles as
// family-identity layer L3.
export interface NoveltyNearest {
  readonly ref: string;        // resultHash — stable across replay/re-stamp; nearest tie-break key
  readonly runId: string;      // human-friendly pointer to the nearest run
  readonly correlation: number; // signed ρ of the nearest member (not abs)
  readonly overlapDays: number;
}
export type Novelty =
  | {
      readonly status: 'resolved';
      readonly score: number;            // 1 − maxAbsCorrelation; 1 = fully novel, 0 = exact twin
      readonly maxAbsCorrelation: number;
      readonly nearest: NoveltyNearest;
      readonly comparabilityKey: string;
      readonly comparedAgainst: number;  // pool members that met minOverlapDays
      readonly behavioralDuplicate: boolean; // maxAbsCorrelation ≥ threshold
      readonly policy: { readonly threshold: number; readonly minOverlapDays: number };
    }
  | {
      readonly status: 'no_comparators';
      readonly reason: 'empty_pool' | 'insufficient_overlap' | 'empty_candidate';
      readonly comparabilityKey: string;
      readonly policy: { readonly threshold: number; readonly minOverlapDays: number };
    };
```

Then add to `RunResultSummary`, after the `diagnostics?` field:

```ts
  /** E5a: advisory behavioral-novelty signal (PnL-delta correlation vs the pool); NOT covered by `resultHash`. */
  readonly novelty?: Novelty;
```

- [ ] **Step 4: Build SDK + run test to verify it passes**

Run: `pnpm sdk:build && npx vitest run packages/sdk/test/contracts.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/contracts/run.ts packages/sdk/test/contracts.test.ts
git commit -m "feat(sdk): E5a — Novelty contract type + RunResultSummary.novelty"
```

---

### Task 2: Pure `novelty.ts` — daily deltas, correlation, score

**Files:**
- Create: `apps/backtester/src/engine/novelty.ts`
- Test: `apps/backtester/test/novelty.test.ts`

**Interfaces:**
- Consumes: `Novelty` from `@trading-backtester/sdk/contracts`; `EquityPoint` from `./artifacts.js`; `quantize` from `../determinism/canonical-json.js`.
- Produces:
  - `interface DailyDelta { readonly day: string; readonly delta: number; }`
  - `interface NoveltyPoolMember { readonly ref: string; readonly runId: string; readonly dailyDeltas: readonly DailyDelta[]; }`
  - `interface NoveltyOpts { readonly minOverlapDays: number; readonly threshold: number; readonly comparabilityKey: string; }`
  - `class NoveltyConfigError extends Error` (thrown later by config)
  - `function toDailyPnlDeltas(equity: readonly EquityPoint[]): DailyDelta[]`
  - `function pnlDeltaCorrelation(a, b, minOverlapDays): { rho: number; overlapDays: number } | null`
  - `function computeNovelty(candidate: readonly DailyDelta[], pool: readonly NoveltyPoolMember[], opts: NoveltyOpts): Novelty`

- [ ] **Step 1: Write the failing test**

Create `apps/backtester/test/novelty.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { EquityPoint } from '../src/engine/artifacts.js';
import {
  toDailyPnlDeltas,
  pnlDeltaCorrelation,
  computeNovelty,
  type DailyDelta,
  type NoveltyPoolMember,
} from '../src/engine/novelty.js';

const DAY = 86_400_000;
function eq(day: number, equity: number, hourOffset = 0): EquityPoint {
  return { barIndex: day, barTs: day * DAY + hourOffset * 3_600_000, equity };
}
function deltas(days: string[], vals: number[]): DailyDelta[] {
  return days.map((day, i) => ({ day, delta: vals[i] }));
}
const OPTS = { minOverlapDays: 2, threshold: 0.8, comparabilityKey: 'k' };

describe('toDailyPnlDeltas', () => {
  it('takes the last point of each UTC day as close and diffs adjacent available days', () => {
    // day 0: two points (close=110); day 1: close=105; day 2: close=130
    const out = toDailyPnlDeltas([eq(0, 100, 1), eq(0, 110, 5), eq(1, 105), eq(2, 130)]);
    expect(out).toEqual([
      { day: '1970-01-02', delta: -5 }, // 105 − 110, labelled with the LATER day
      { day: '1970-01-03', delta: 25 }, // 130 − 105
    ]);
  });
  it('a gap produces one spanning delta, not zero-filled days', () => {
    const out = toDailyPnlDeltas([eq(0, 100), eq(3, 130)]); // 3-day gap
    expect(out).toEqual([{ day: '1970-01-04', delta: 30 }]);
  });
  it('a single close-day yields no deltas', () => {
    expect(toDailyPnlDeltas([eq(0, 100), eq(0, 105)])).toEqual([]);
  });
});

describe('pnlDeltaCorrelation', () => {
  const a = deltas(['d1', 'd2', 'd3'], [1, 2, 3]);
  it('identical series → ρ=1', () => {
    expect(pnlDeltaCorrelation(a, a, 2)).toEqual({ rho: 1, overlapDays: 3 });
  });
  it('scaled series → ρ=1 (scale-invariant)', () => {
    const b = deltas(['d1', 'd2', 'd3'], [2, 4, 6]);
    expect(pnlDeltaCorrelation(a, b, 2)?.rho).toBe(1);
  });
  it('anti-correlated → ρ=-1', () => {
    const b = deltas(['d1', 'd2', 'd3'], [3, 2, 1]);
    expect(pnlDeltaCorrelation(a, b, 2)?.rho).toBe(-1);
  });
  it('overlap below min → null', () => {
    const b = deltas(['d3', 'd4', 'd5'], [3, 9, 9]); // shares only d3
    expect(pnlDeltaCorrelation(a, b, 2)).toBeNull();
  });
  it('zero-variance series → null', () => {
    const flat = deltas(['d1', 'd2', 'd3'], [5, 5, 5]);
    expect(pnlDeltaCorrelation(a, flat, 2)).toBeNull();
  });
});

describe('computeNovelty', () => {
  const cand = deltas(['d1', 'd2', 'd3'], [1, 2, 3]);
  it('empty candidate (<2 deltas) → no_comparators:empty_candidate', () => {
    const r = computeNovelty(deltas(['d1'], [1]), [], OPTS);
    expect(r).toMatchObject({ status: 'no_comparators', reason: 'empty_candidate', comparabilityKey: 'k' });
  });
  it('empty pool → no_comparators:empty_pool', () => {
    expect(computeNovelty(cand, [], OPTS)).toMatchObject({ status: 'no_comparators', reason: 'empty_pool' });
  });
  it('members present but none meet overlap → insufficient_overlap', () => {
    const m: NoveltyPoolMember = { ref: 'h1', runId: 'r1', dailyDeltas: deltas(['x1', 'x2', 'x3'], [1, 2, 3]) };
    expect(computeNovelty(cand, [m], OPTS)).toMatchObject({ status: 'no_comparators', reason: 'insufficient_overlap' });
  });
  it('resolved: score=1−maxAbs, behavioralDuplicate at threshold, correct nearest', () => {
    const twin: NoveltyPoolMember = { ref: 'h_twin', runId: 'r_twin', dailyDeltas: cand };
    const noise: NoveltyPoolMember = { ref: 'h_noise', runId: 'r_noise', dailyDeltas: deltas(['d1', 'd2', 'd3'], [3, 1, 2]) };
    const r = computeNovelty(cand, [noise, twin], OPTS);
    expect(r).toMatchObject({
      status: 'resolved',
      score: 0,
      maxAbsCorrelation: 1,
      behavioralDuplicate: true,
      comparedAgainst: 2,
      nearest: { ref: 'h_twin', runId: 'r_twin', correlation: 1 },
    });
  });
  it('nearest ties broken by smallest ref', () => {
    const twinB: NoveltyPoolMember = { ref: 'b', runId: 'rb', dailyDeltas: cand };
    const twinA: NoveltyPoolMember = { ref: 'a', runId: 'ra', dailyDeltas: cand };
    const r = computeNovelty(cand, [twinB, twinA], OPTS);
    expect(r.status).toBe('resolved');
    if (r.status === 'resolved') expect(r.nearest.ref).toBe('a');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/backtester/test/novelty.test.ts`
Expected: FAIL — cannot find module `../src/engine/novelty.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/backtester/src/engine/novelty.ts`:

```ts
// E5a — pure hypothesis-novelty kernel: daily-PnL-delta extraction, Pearson correlation, and a
// nearest-neighbour novelty score. No I/O. The behavioral (L3) arbiter of family identity. Advisory:
// results ride the summary projection only.

import type { Novelty } from '@trading-backtester/sdk/contracts';
import type { EquityPoint } from './artifacts.js';
import { quantize } from '../determinism/canonical-json.js';

export interface DailyDelta {
  readonly day: string; // 'YYYY-MM-DD' UTC
  readonly delta: number;
}
export interface NoveltyPoolMember {
  readonly ref: string;
  readonly runId: string;
  readonly dailyDeltas: readonly DailyDelta[];
}
export interface NoveltyOpts {
  readonly minOverlapDays: number;
  readonly threshold: number;
  readonly comparabilityKey: string;
}

/** Config-layer error (thrown from loadConfig when the flag is on and a threshold is out of range). */
export class NoveltyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoveltyConfigError';
  }
}

/**
 * UTC-daily close-to-close PnL deltas. Buckets equity by UTC day, takes each day's LAST point as the
 * close, and emits `close_i − close_{i-1}` for adjacent AVAILABLE close-days (missing calendar days do
 * NOT synthesize zero deltas). Each delta is labelled with the LATER close-day (the alignment key).
 * PRECONDITION: `equity` is in ascending `barTs` order — this is an engine invariant (the equity curve
 * is emitted bar-by-bar in time order); this function relies on it and does NOT re-sort. If that
 * invariant is ever in doubt, sort upstream, not here (keeps this kernel O(n) and allocation-light).
 */
export function toDailyPnlDeltas(equity: readonly EquityPoint[]): DailyDelta[] {
  const closeByDay = new Map<string, number>();
  const order: string[] = [];
  for (const p of equity) {
    const day = new Date(p.barTs).toISOString().slice(0, 10);
    if (!closeByDay.has(day)) order.push(day);
    closeByDay.set(day, p.equity); // ascending ts ⇒ last write of a day == close
  }
  const out: DailyDelta[] = [];
  for (let i = 1; i < order.length; i++) {
    const prev = closeByDay.get(order[i - 1])!;
    const cur = closeByDay.get(order[i])!;
    out.push({ day: order[i], delta: quantize(cur - prev) });
  }
  return out;
}

function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  const n = xs.length;
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx === 0 || vy === 0) return null;
  return cov / Math.sqrt(vx * vy);
}

/** Pearson ρ over the intersection of the two series' day labels; null below minOverlap or zero-variance. */
export function pnlDeltaCorrelation(
  a: readonly DailyDelta[],
  b: readonly DailyDelta[],
  minOverlapDays: number,
): { rho: number; overlapDays: number } | null {
  const bByDay = new Map(b.map((d) => [d.day, d.delta]));
  const xs: number[] = [];
  const ys: number[] = [];
  for (const d of a) {
    const y = bByDay.get(d.day);
    if (y !== undefined) {
      xs.push(d.delta);
      ys.push(y);
    }
  }
  const overlapDays = xs.length;
  if (overlapDays < minOverlapDays) return null;
  const rho = pearson(xs, ys);
  if (rho === null) return null;
  return { rho: quantize(rho), overlapDays };
}

/** Novelty = 1 − max|ρ| over comparable pool members; status union handles the cold-start cases. */
export function computeNovelty(
  candidate: readonly DailyDelta[],
  pool: readonly NoveltyPoolMember[],
  opts: NoveltyOpts,
): Novelty {
  const policy = { threshold: opts.threshold, minOverlapDays: opts.minOverlapDays };
  const comparabilityKey = opts.comparabilityKey;
  if (candidate.length < 2) {
    return { status: 'no_comparators', reason: 'empty_candidate', comparabilityKey, policy };
  }
  if (pool.length === 0) {
    return { status: 'no_comparators', reason: 'empty_pool', comparabilityKey, policy };
  }
  const comparators: { ref: string; runId: string; rho: number; overlapDays: number }[] = [];
  for (const m of pool) {
    const c = pnlDeltaCorrelation(candidate, m.dailyDeltas, opts.minOverlapDays);
    if (c) comparators.push({ ref: m.ref, runId: m.runId, rho: c.rho, overlapDays: c.overlapDays });
  }
  if (comparators.length === 0) {
    return { status: 'no_comparators', reason: 'insufficient_overlap', comparabilityKey, policy };
  }
  let best = comparators[0];
  for (const c of comparators) {
    const ca = Math.abs(c.rho);
    const ba = Math.abs(best.rho);
    if (ca > ba || (ca === ba && c.ref < best.ref)) best = c;
  }
  const maxAbs = Math.abs(best.rho);
  return {
    status: 'resolved',
    score: quantize(1 - maxAbs),
    maxAbsCorrelation: quantize(maxAbs),
    nearest: { ref: best.ref, runId: best.runId, correlation: best.rho, overlapDays: best.overlapDays },
    comparabilityKey,
    comparedAgainst: comparators.length,
    behavioralDuplicate: maxAbs >= opts.threshold,
    policy,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/backtester/test/novelty.test.ts`
Expected: PASS (all cases)

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/engine/novelty.ts apps/backtester/test/novelty.test.ts
git commit -m "feat(research): E5a — pure novelty kernel (daily deltas + correlation + score)"
```

---

### Task 3: `NoveltyPool` store — interface, InMemory, `computeComparabilityKey`

**Files:**
- Create: `apps/backtester/src/jobs/ledger/novelty-pool.ts`
- Test: `apps/backtester/test/novelty-pool.test.ts`

**Interfaces:**
- Consumes: `DailyDelta` from `../../engine/novelty.js`; `sha256Hex` from `../../determinism/hash.js`; `canonicalJson` from `../../determinism/canonical-json.js`.
- Produces:
  - `interface PoolRecord { comparabilityKey, requestFingerprint, runId, resultHash, familyKey?, dailyDeltas, createdAtMs }`
  - `interface ComparabilityKeyInput { datasetRef: string; symbols: readonly string[]; timeframe: string }`
  - `function computeComparabilityKey(input: ComparabilityKeyInput): string`
  - `interface NoveltyPool { recordIfNew(r): Promise<boolean>; query(comparabilityKey, opts?: { excludeRequestFingerprint?: string }): Promise<readonly PoolRecord[]> }`
  - `class InMemoryNoveltyPool implements NoveltyPool`

- [ ] **Step 1: Write the failing test**

Create `apps/backtester/test/novelty-pool.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  InMemoryNoveltyPool,
  computeComparabilityKey,
  type PoolRecord,
} from '../src/jobs/ledger/novelty-pool.js';

function rec(over: Partial<PoolRecord> = {}): PoolRecord {
  return {
    comparabilityKey: 'k',
    requestFingerprint: 'fp1',
    runId: 'r1',
    resultHash: 'h1',
    dailyDeltas: [{ day: 'd1', delta: 1 }],
    createdAtMs: 1,
    ...over,
  };
}

describe('computeComparabilityKey', () => {
  it('is order-insensitive in symbols and excludes period/hint', () => {
    const a = computeComparabilityKey({ datasetRef: 'ds', symbols: ['BTC', 'ETH'], timeframe: '1m' });
    const b = computeComparabilityKey({ datasetRef: 'ds', symbols: ['ETH', 'BTC'], timeframe: '1m' });
    expect(a).toBe(b);
  });
  it('differs on datasetRef / timeframe', () => {
    const a = computeComparabilityKey({ datasetRef: 'ds', symbols: ['BTC'], timeframe: '1m' });
    const c = computeComparabilityKey({ datasetRef: 'ds', symbols: ['BTC'], timeframe: '1h' });
    expect(a).not.toBe(c);
  });
});

describe('InMemoryNoveltyPool', () => {
  it('recordIfNew dedupes on (comparabilityKey, requestFingerprint)', async () => {
    const pool = new InMemoryNoveltyPool();
    expect(await pool.recordIfNew(rec())).toBe(true);
    expect(await pool.recordIfNew(rec())).toBe(false); // same fp → no second row
    expect((await pool.query('k')).length).toBe(1);
  });
  it('different fingerprint, same key → two rows', async () => {
    const pool = new InMemoryNoveltyPool();
    await pool.recordIfNew(rec({ requestFingerprint: 'fp1', createdAtMs: 1 }));
    await pool.recordIfNew(rec({ requestFingerprint: 'fp2', runId: 'r2', createdAtMs: 2 }));
    expect((await pool.query('k')).length).toBe(2);
  });
  it('query excludes the caller’s own fingerprint', async () => {
    const pool = new InMemoryNoveltyPool();
    await pool.recordIfNew(rec({ requestFingerprint: 'fp1' }));
    await pool.recordIfNew(rec({ requestFingerprint: 'fp2', runId: 'r2', createdAtMs: 2 }));
    const others = await pool.query('k', { excludeRequestFingerprint: 'fp1' });
    expect(others.map((r) => r.requestFingerprint)).toEqual(['fp2']);
  });
  it('query returns [] for an unknown key', async () => {
    expect(await new InMemoryNoveltyPool().query('nope')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/backtester/test/novelty-pool.test.ts`
Expected: FAIL — cannot find module `../src/jobs/ledger/novelty-pool.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/backtester/src/jobs/ledger/novelty-pool.ts`:

```ts
// E5a — novelty pool: append-only, per-comparability-group record of each run's daily-PnL-delta
// trajectory. Substrate for the advisory behavioral-novelty score. Worker-time store (InMemory + Pg),
// mirroring the E2 TrialLedger. Never part of any hashed payload.

import type { DailyDelta } from '../../engine/novelty.js';
import { canonicalJson } from '../../determinism/canonical-json.js';
import { sha256Hex } from '../../determinism/hash.js';

/** Fields the comparability key is derived from. NO period, NO hint — L3 crosses families/windows. */
export interface ComparabilityKeyInput {
  readonly datasetRef: string;
  readonly symbols: readonly string[];
  readonly timeframe: string;
}

export function computeComparabilityKey(input: ComparabilityKeyInput): string {
  return sha256Hex(
    canonicalJson({
      datasetRef: input.datasetRef,
      symbols: [...input.symbols].sort(),
      timeframe: input.timeframe,
    }),
  );
}

export interface PoolRecord {
  readonly comparabilityKey: string;
  readonly requestFingerprint: string;
  readonly runId: string;
  readonly resultHash: string;
  readonly familyKey?: string; // optional — E5 is NOT coupled to E2; stored for a future L3 retro-merge
  readonly dailyDeltas: readonly DailyDelta[];
  readonly createdAtMs: number;
}

export interface NoveltyPool {
  /** Idempotent on (comparabilityKey, requestFingerprint); true iff a new row was inserted. */
  recordIfNew(r: PoolRecord): Promise<boolean>;
  /** Members of a comparability group (created_at_ms ASC, run_id ASC); optionally excluding one fingerprint. */
  query(
    comparabilityKey: string,
    opts?: { excludeRequestFingerprint?: string },
  ): Promise<readonly PoolRecord[]>;
}

export class InMemoryNoveltyPool implements NoveltyPool {
  private readonly byKey = new Map<string, Map<string, PoolRecord>>();

  async recordIfNew(r: PoolRecord): Promise<boolean> {
    let group = this.byKey.get(r.comparabilityKey);
    if (!group) {
      group = new Map();
      this.byKey.set(r.comparabilityKey, group);
    }
    if (group.has(r.requestFingerprint)) return false;
    group.set(r.requestFingerprint, r);
    return true;
  }

  async query(
    comparabilityKey: string,
    opts?: { excludeRequestFingerprint?: string },
  ): Promise<readonly PoolRecord[]> {
    const group = this.byKey.get(comparabilityKey);
    if (!group) return [];
    const rows = [...group.values()].filter(
      (r) => r.requestFingerprint !== opts?.excludeRequestFingerprint,
    );
    rows.sort((a, b) => a.createdAtMs - b.createdAtMs || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
    return rows;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/backtester/test/novelty-pool.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/jobs/ledger/novelty-pool.ts apps/backtester/test/novelty-pool.test.ts
git commit -m "feat(research): E5a — NoveltyPool store (InMemory) + comparabilityKey"
```

---

### Task 4: Pg-backed pool + migration 0008

**Files:**
- Create: `apps/backtester/migrations/0008_novelty_pool.sql`
- Create: `apps/backtester/src/jobs/ledger/pg-novelty-pool.ts`
- Test: `apps/backtester/test/pg-novelty-pool.test.ts`

**Interfaces:**
- Consumes: `NoveltyPool`, `PoolRecord` from `./novelty-pool.js`; `Pool` from `pg`.
- Produces: `class PgNoveltyPool implements NoveltyPool`.

- [ ] **Step 1: Write the migration**

Create `apps/backtester/migrations/0008_novelty_pool.sql`:

```sql
-- 0008: E5a novelty pool — append-only, per-comparability-group record of each run's daily-PnL-delta
-- trajectory. Substrate for the advisory behavioral-novelty score (family-identity layer L3). Dedupe
-- key is (comparability_key, request_fingerprint): a replay / cache hit must NOT add a duplicate
-- trajectory. comparability_key excludes period + hint so L3 crosses families and shifted windows.
CREATE TABLE IF NOT EXISTS backtest_novelty_pool (
  comparability_key   TEXT   NOT NULL,
  request_fingerprint TEXT   NOT NULL,
  run_id              TEXT   NOT NULL,
  result_hash         TEXT   NOT NULL,
  family_key          TEXT,
  daily_deltas        JSONB  NOT NULL,
  created_at_ms       BIGINT NOT NULL,
  PRIMARY KEY (comparability_key, request_fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_novelty_pool_key ON backtest_novelty_pool (comparability_key);
```

- [ ] **Step 2: Write the failing test**

Create `apps/backtester/test/pg-novelty-pool.test.ts` (uses a fake `pg.Pool` — no live DB — asserting the SQL contract + row mapping):

```ts
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { PgNoveltyPool } from '../src/jobs/ledger/pg-novelty-pool.js';
import type { PoolRecord } from '../src/jobs/ledger/novelty-pool.js';

function fakePool(calls: { sql: string; params: unknown[] }[], result: { rowCount?: number; rows?: unknown[] }): Pool {
  return {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return result;
    },
  } as unknown as Pool;
}

const rec: PoolRecord = {
  comparabilityKey: 'k',
  requestFingerprint: 'fp1',
  runId: 'r1',
  resultHash: 'h1',
  dailyDeltas: [{ day: 'd1', delta: 1 }],
  createdAtMs: 5,
};

describe('PgNoveltyPool', () => {
  it('recordIfNew INSERTs with ON CONFLICT DO NOTHING and reports insertion', async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const inserted = await new PgNoveltyPool(fakePool(calls, { rowCount: 1 })).recordIfNew(rec);
    expect(inserted).toBe(true);
    expect(calls[0].sql).toMatch(/ON CONFLICT \(comparability_key, request_fingerprint\) DO NOTHING/);
    expect(calls[0].params[0]).toBe('k');
    expect(calls[0].params[4]).toBeNull(); // family_key omitted → null
    expect(calls[0].params[5]).toBe(JSON.stringify(rec.dailyDeltas));
  });
  it('recordIfNew reports false when nothing inserted (conflict)', async () => {
    const inserted = await new PgNoveltyPool(fakePool([], { rowCount: 0 })).recordIfNew(rec);
    expect(inserted).toBe(false);
  });
  it('query without exclude has no fingerprint predicate', async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    await new PgNoveltyPool(fakePool(calls, { rows: [] })).query('k');
    expect(calls[0].sql).toContain('WHERE comparability_key = $1');
    expect(calls[0].sql).not.toContain('request_fingerprint <>');
    expect(calls[0].params).toEqual(['k']);
  });
  it('query with exclude adds the fingerprint predicate + param', async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    await new PgNoveltyPool(fakePool(calls, { rows: [] })).query('k', { excludeRequestFingerprint: 'fp1' });
    expect(calls[0].sql).toContain('request_fingerprint <> $2');
    expect(calls[0].params).toEqual(['k', 'fp1']);
  });
  it('maps rows back (bigint createdAtMs as string, null family_key omitted)', async () => {
    const row = {
      comparability_key: 'k',
      request_fingerprint: 'fp1',
      run_id: 'r1',
      result_hash: 'h1',
      family_key: null,
      daily_deltas: [{ day: 'd1', delta: 1 }],
      created_at_ms: '5',
    };
    const out = await new PgNoveltyPool(fakePool([], { rows: [row] })).query('k');
    expect(out[0]).toEqual(rec);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run apps/backtester/test/pg-novelty-pool.test.ts`
Expected: FAIL — cannot find module `../src/jobs/ledger/pg-novelty-pool.js`.

- [ ] **Step 4: Write the implementation**

Create `apps/backtester/src/jobs/ledger/pg-novelty-pool.ts`:

```ts
// E5a — Postgres-backed novelty pool (migration 0008). Mirrors PgTrialLedger. `recordIfNew` =
// INSERT … ON CONFLICT (comparability_key, request_fingerprint) DO NOTHING so replays never duplicate
// a trajectory. `query` optionally excludes the caller's own fingerprint (replay self-exclusion).

import type { Pool } from 'pg';
import type { DailyDelta } from '../../engine/novelty.js';
import type { NoveltyPool, PoolRecord } from './novelty-pool.js';

interface Row {
  comparability_key: string;
  request_fingerprint: string;
  run_id: string;
  result_hash: string;
  family_key: string | null;
  daily_deltas: DailyDelta[];
  created_at_ms: string;
}

function toRecord(r: Row): PoolRecord {
  return {
    comparabilityKey: r.comparability_key,
    requestFingerprint: r.request_fingerprint,
    runId: r.run_id,
    resultHash: r.result_hash,
    ...(r.family_key !== null ? { familyKey: r.family_key } : {}),
    dailyDeltas: r.daily_deltas,
    createdAtMs: Number(r.created_at_ms),
  };
}

export class PgNoveltyPool implements NoveltyPool {
  constructor(private readonly pool: Pool) {}

  async recordIfNew(r: PoolRecord): Promise<boolean> {
    const res = await this.pool.query(
      `INSERT INTO backtest_novelty_pool
         (comparability_key, request_fingerprint, run_id, result_hash, family_key, daily_deltas, created_at_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (comparability_key, request_fingerprint) DO NOTHING`,
      [
        r.comparabilityKey,
        r.requestFingerprint,
        r.runId,
        r.resultHash,
        r.familyKey ?? null,
        JSON.stringify(r.dailyDeltas),
        r.createdAtMs,
      ],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async query(
    comparabilityKey: string,
    opts?: { excludeRequestFingerprint?: string },
  ): Promise<readonly PoolRecord[]> {
    const exclude = opts?.excludeRequestFingerprint;
    const sql = exclude
      ? 'SELECT * FROM backtest_novelty_pool WHERE comparability_key = $1 AND request_fingerprint <> $2 ORDER BY created_at_ms ASC, run_id ASC'
      : 'SELECT * FROM backtest_novelty_pool WHERE comparability_key = $1 ORDER BY created_at_ms ASC, run_id ASC';
    const res = await this.pool.query<Row>(sql, exclude ? [comparabilityKey, exclude] : [comparabilityKey]);
    return res.rows.map(toRecord);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run apps/backtester/test/pg-novelty-pool.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/backtester/migrations/0008_novelty_pool.sql apps/backtester/src/jobs/ledger/pg-novelty-pool.ts apps/backtester/test/pg-novelty-pool.test.ts
git commit -m "feat(research): E5a — Pg novelty pool + migration 0008"
```

---

### Task 5: Config — flag + validated thresholds

**Files:**
- Modify: `apps/backtester/src/config.ts` (AppConfig fields after `diagConcentrationPct`; loadConfig fields + fail-fast block; import `NoveltyConfigError`)
- Modify: `apps/backtester/test/helpers.ts` (config literal after line 57)
- Test: `apps/backtester/test/config-novelty.test.ts`

**Interfaces:**
- Consumes: `NoveltyConfigError` from `./engine/novelty.js`.
- Produces: `AppConfig += novelty: boolean; noveltyCorrThreshold: number; noveltyMinOverlapDays: number`.

- [ ] **Step 1: Write the failing test**

Create `apps/backtester/test/config-novelty.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('novelty config (E5a)', () => {
  it('defaults off with 0.80 / 30', () => {
    const cfg = loadConfig({} as NodeJS.ProcessEnv);
    expect(cfg.novelty).toBe(false);
    expect(cfg.noveltyCorrThreshold).toBe(0.8);
    expect(cfg.noveltyMinOverlapDays).toBe(30);
  });
  it('enables only for exact "true" and parses custom values', () => {
    const cfg = loadConfig({
      BACKTESTER_NOVELTY_ENABLED: 'true',
      BACKTESTER_NOVELTY_CORR_THRESHOLD: '0.7',
      BACKTESTER_NOVELTY_MIN_OVERLAP_DAYS: '50',
    } as NodeJS.ProcessEnv);
    expect(cfg.novelty).toBe(true);
    expect(cfg.noveltyCorrThreshold).toBe(0.7);
    expect(cfg.noveltyMinOverlapDays).toBe(50);
  });
  it('fail-fast when enabled with a bad threshold or overlap', () => {
    expect(() => loadConfig({ BACKTESTER_NOVELTY_ENABLED: 'true', BACKTESTER_NOVELTY_CORR_THRESHOLD: '1.5' } as NodeJS.ProcessEnv)).toThrow(/CORR_THRESHOLD/);
    expect(() => loadConfig({ BACKTESTER_NOVELTY_ENABLED: 'true', BACKTESTER_NOVELTY_CORR_THRESHOLD: '-0.1' } as NodeJS.ProcessEnv)).toThrow(/CORR_THRESHOLD/);
    expect(() => loadConfig({ BACKTESTER_NOVELTY_ENABLED: 'true', BACKTESTER_NOVELTY_MIN_OVERLAP_DAYS: '0' } as NodeJS.ProcessEnv)).toThrow(/MIN_OVERLAP_DAYS/);
    expect(() => loadConfig({ BACKTESTER_NOVELTY_ENABLED: 'true', BACKTESTER_NOVELTY_MIN_OVERLAP_DAYS: '2.5' } as NodeJS.ProcessEnv)).toThrow(/MIN_OVERLAP_DAYS/);
  });
  it('disabled + bad values → no throw AND no NaN (normalized to defaults)', () => {
    const cfg = loadConfig({ BACKTESTER_NOVELTY_CORR_THRESHOLD: 'abc', BACKTESTER_NOVELTY_MIN_OVERLAP_DAYS: 'xyz' } as NodeJS.ProcessEnv);
    expect(cfg.novelty).toBe(false);
    expect(cfg.noveltyCorrThreshold).toBe(0.8);
    expect(cfg.noveltyMinOverlapDays).toBe(30);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/backtester/test/config-novelty.test.ts`
Expected: FAIL — `cfg.novelty` undefined / thresholds undefined.

- [ ] **Step 3: Implement config**

In `apps/backtester/src/config.ts`:

Add the import near the other engine imports (top of file):

```ts
import { NoveltyConfigError } from './engine/novelty';
```

Add to the `AppConfig` interface, after `diagConcentrationPct`:

```ts
  /** E5a: behavioral-novelty gate enabled. Default off (dark launch). */
  readonly novelty: boolean;
  /** E5a: `behavioralDuplicate` when maxAbsCorrelation ≥ this. Validated in [0,1] when enabled. Default 0.80. */
  readonly noveltyCorrThreshold: number;
  /** E5a: minimum shared UTC days for a valid Pearson. Validated integer ≥ 1 when enabled. Default 30. */
  readonly noveltyMinOverlapDays: number;
```

Add the fail-fast block in `loadConfig`, right after the holdout fail-fast block:

```ts
  // Fail-fast (E5a): thresholds only meaningful in-range; validate only when the gate is on. When off,
  // the values are normalized to defaults below (never NaN), so a bad env never poisons the config.
  const noveltyEnabled = env.BACKTESTER_NOVELTY_ENABLED === 'true';
  const noveltyThresholdRaw = Number(env.BACKTESTER_NOVELTY_CORR_THRESHOLD);
  const noveltyOverlapRaw = Number(env.BACKTESTER_NOVELTY_MIN_OVERLAP_DAYS);
  if (noveltyEnabled) {
    if (!Number.isFinite(noveltyThresholdRaw) || noveltyThresholdRaw < 0 || noveltyThresholdRaw > 1) {
      throw new NoveltyConfigError('BACKTESTER_NOVELTY_CORR_THRESHOLD must be a number in [0,1] when BACKTESTER_NOVELTY_ENABLED');
    }
    if (!Number.isInteger(noveltyOverlapRaw) || noveltyOverlapRaw < 1) {
      throw new NoveltyConfigError('BACKTESTER_NOVELTY_MIN_OVERLAP_DAYS must be an integer ≥ 1 when BACKTESTER_NOVELTY_ENABLED');
    }
  }
```

Add to the returned config object, after `diagConcentrationPct`:

```ts
    novelty: noveltyEnabled,
    noveltyCorrThreshold:
      env.BACKTESTER_NOVELTY_CORR_THRESHOLD !== undefined && Number.isFinite(noveltyThresholdRaw)
        ? noveltyThresholdRaw
        : 0.8,
    noveltyMinOverlapDays:
      env.BACKTESTER_NOVELTY_MIN_OVERLAP_DAYS !== undefined && Number.isInteger(noveltyOverlapRaw)
        ? noveltyOverlapRaw
        : 30,
```

- [ ] **Step 4: Update the test config literal**

In `apps/backtester/test/helpers.ts`, after `diagConcentrationPct: 80,`:

```ts
    novelty: false,
    noveltyCorrThreshold: 0.8,
    noveltyMinOverlapDays: 30,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run apps/backtester/test/config-novelty.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/backtester/src/config.ts apps/backtester/test/helpers.ts apps/backtester/test/config-novelty.test.ts
git commit -m "feat(research): E5a — config flag + validated novelty thresholds"
```

---

### Task 6: Worker wiring — `resolveNovelty` + finalize + app deps

**Files:**
- Modify: `apps/backtester/src/jobs/worker.ts` (imports; `WorkerDeps.novelty`; `finalizeResult` call; export `resolveNovelty`)
- Modify: `apps/backtester/src/app.ts` (construct the pool + wire deps after the diagnostics block)
- Test: `apps/backtester/test/novelty-wiring.test.ts`

**Interfaces:**
- Consumes: `computeNovelty`, `toDailyPnlDeltas` from `../engine/novelty.js`; `NoveltyPool`, `computeComparabilityKey` from `./ledger/novelty-pool.js`; `InMemoryNoveltyPool` / `PgNoveltyPool` in app.ts; `Novelty` from SDK.
- Produces: `WorkerDeps.novelty?: { enabled: boolean; threshold: number; minOverlapDays: number; pool: NoveltyPool }`; `export async function resolveNovelty(deps: WorkerDeps, claimed: JobRow, outcome: Extract<RunOutcome, { status: 'completed' }>, resultHash: string): Promise<Novelty | undefined>`.

- [ ] **Step 1: Write the failing test**

Create `apps/backtester/test/novelty-wiring.test.ts`:

```ts
// E5a — worker finalize wiring for the novelty gate. Pins: flag OFF ⇒ no field; flag ON ⇒ score
// computed vs the prior pool; query → score → record with self-exclusion under replay; empty candidate
// not recorded. resultHash invariance is structural (novelty merged onto the projection AFTER
// contentRef) + the flag-OFF goldens elsewhere.

import { describe, expect, it } from 'vitest';
import { resolveNovelty, type WorkerDeps } from '../src/jobs/worker.js';
import { InMemoryNoveltyPool, computeComparabilityKey } from '../src/jobs/ledger/novelty-pool.js';

const DAY = 86_400_000;
function equityCurve(vals: number[]) {
  return vals.map((equity, i) => ({ barIndex: i, barTs: i * DAY, equity }));
}
function outcome(vals: number[]) {
  return {
    status: 'completed',
    baseline: { trades: [], evidence: { equityCurve: equityCurve(vals) }, summary: { barsProcessed: vals.length, ordersCount: 0 } },
  } as unknown as Parameters<typeof resolveNovelty>[2];
}
function claimed(over: { requestFingerprint?: string; runId?: string } = {}) {
  return {
    runId: over.runId ?? 'r1',
    requestFingerprint: over.requestFingerprint ?? 'fp1',
    datasetRef: 'ds',
    request: { symbols: ['BTC'], timeframe: '1m' },
  } as unknown as Parameters<typeof resolveNovelty>[1];
}
function deps(over: Partial<WorkerDeps>): WorkerDeps {
  return { ...over } as unknown as WorkerDeps;
}
const KEY = computeComparabilityKey({ datasetRef: 'ds', symbols: ['BTC'], timeframe: '1m' });
// 4 equity points → 3 daily deltas, enough for minOverlapDays: 2
const SERIES = [100, 110, 105, 130];

describe('resolveNovelty — E1b-style worker wiring', () => {
  it('flag OFF ⇒ undefined', async () => {
    expect(await resolveNovelty(deps({}), claimed(), outcome(SERIES), 'h1')).toBeUndefined();
  });

  it('empty pool ⇒ no_comparators:empty_pool AND the run is recorded', async () => {
    const pool = new InMemoryNoveltyPool();
    const d = deps({ novelty: { enabled: true, threshold: 0.8, minOverlapDays: 2, pool }, clock: (() => 1) as WorkerDeps['clock'] });
    const r = await resolveNovelty(d, claimed(), outcome(SERIES), 'h1');
    expect(r).toMatchObject({ status: 'no_comparators', reason: 'empty_pool', comparabilityKey: KEY });
    expect((await pool.query(KEY)).length).toBe(1); // recorded
  });

  it('empty candidate (single close-day) ⇒ empty_candidate AND NOT recorded', async () => {
    const pool = new InMemoryNoveltyPool();
    const d = deps({ novelty: { enabled: true, threshold: 0.8, minOverlapDays: 2, pool }, clock: (() => 1) as WorkerDeps['clock'] });
    // both points on the same UTC day → 0 deltas
    const oneDay = { status: 'completed', baseline: { trades: [], evidence: { equityCurve: [{ barIndex: 0, barTs: 0, equity: 100 }, { barIndex: 1, barTs: 3_600_000, equity: 110 }] }, summary: { barsProcessed: 2, ordersCount: 0 } } } as unknown as Parameters<typeof resolveNovelty>[2];
    const r = await resolveNovelty(d, claimed(), oneDay, 'h1');
    expect(r).toMatchObject({ status: 'no_comparators', reason: 'empty_candidate' });
    expect((await pool.query(KEY)).length).toBe(0); // NOT recorded
  });

  it('seeded correlated member ⇒ resolved behavioralDuplicate; replay self-excludes', async () => {
    const pool = new InMemoryNoveltyPool();
    const d = deps({ novelty: { enabled: true, threshold: 0.8, minOverlapDays: 2, pool }, clock: (() => 1) as WorkerDeps['clock'] });
    // first run fp1 records itself
    await resolveNovelty(d, claimed({ requestFingerprint: 'fp1', runId: 'r1' }), outcome(SERIES), 'h1');
    // second run fp2, identical trajectory → duplicate of fp1
    const r2 = await resolveNovelty(d, claimed({ requestFingerprint: 'fp2', runId: 'r2' }), outcome(SERIES), 'h2');
    expect(r2).toMatchObject({ status: 'resolved', behavioralDuplicate: true });
    // replay of fp1 must NOT see itself → not a duplicate against itself
    const replay = await resolveNovelty(d, claimed({ requestFingerprint: 'fp1', runId: 'r1' }), outcome(SERIES), 'h1');
    if (replay?.status === 'resolved') expect(replay.nearest.ref).not.toBe('h1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/backtester/test/novelty-wiring.test.ts`
Expected: FAIL — `resolveNovelty` is not exported from `worker.js`.

- [ ] **Step 3: Wire the worker**

In `apps/backtester/src/jobs/worker.ts`:

Add imports near the other engine/ledger imports:

```ts
import { toDailyPnlDeltas, computeNovelty } from '../engine/novelty.js';
import { computeComparabilityKey, type NoveltyPool } from './ledger/novelty-pool.js';
```

Add to `WorkerDeps`, after the `diagnostics?` field:

```ts
  /** E5a: behavioral-novelty gate. Absent/disabled ⇒ no `novelty` field (byte-identical). */
  novelty?: { enabled: boolean; threshold: number; minOverlapDays: number; pool: NoveltyPool };
```

In `finalizeResult`, after the diagnostics block (`if (diagnostics) summary = { ...summary, diagnostics };`) and before `return { summary, ... }`:

```ts
  // E5a (advisory, flag-gated): behavioral-novelty vs the prior pool (query → score → record, self-
  // excluding this fingerprint). Non-hashed projection; flag-OFF ⇒ field absent ⇒ byte-identical.
  const novelty = await resolveNovelty(deps, claimed, outcome, resultHash);
  if (novelty) summary = { ...summary, novelty };
```

Add the exported helper next to `resolveRunDiagnostics`:

```ts
/**
 * E5a: compute the advisory novelty signal for a completed overlay/strategy run. `undefined` when the
 * gate is off. Order is query → score → record; `query` self-excludes this run's fingerprint so a
 * replay is not scored against itself (idempotent projection). A degenerate run (<2 daily deltas) is
 * scored `no_comparators:empty_candidate` and NOT recorded, so it never pollutes the pool.
 */
export async function resolveNovelty(
  deps: WorkerDeps,
  claimed: JobRow,
  outcome: Extract<RunOutcome, { status: 'completed' }>,
  resultHash: string,
): Promise<Novelty | undefined> {
  if (!deps.novelty?.enabled) return undefined;
  const candidateDeltas = toDailyPnlDeltas(outcome.baseline.evidence.equityCurve);
  const comparabilityKey = computeComparabilityKey({
    datasetRef: claimed.datasetRef,
    symbols: claimed.request.symbols,
    timeframe: claimed.request.timeframe,
  });
  const pool = await deps.novelty.pool.query(comparabilityKey, {
    excludeRequestFingerprint: claimed.requestFingerprint,
  });
  const novelty = computeNovelty(
    candidateDeltas,
    pool.map((r) => ({ ref: r.resultHash, runId: r.runId, dailyDeltas: r.dailyDeltas })),
    { minOverlapDays: deps.novelty.minOverlapDays, threshold: deps.novelty.threshold, comparabilityKey },
  );
  if (candidateDeltas.length >= 2) {
    await deps.novelty.pool.recordIfNew({
      comparabilityKey,
      requestFingerprint: claimed.requestFingerprint,
      runId: claimed.runId,
      resultHash,
      dailyDeltas: candidateDeltas,
      createdAtMs: deps.clock(), // WorkerDeps.clock is `() => number` (not an object)
    });
  }
  return novelty;
}
```

Add the `Novelty` type to the existing SDK-contracts `import type { … }` group in worker.ts (the block ending at line 14 `} from '@trading-backtester/sdk/contracts';`, which already lists `HoldoutMarker`, `RunDiagnostics`, `RunResultSummary`). `RunOutcome` is already imported (line 45, from `../engine/artifacts`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm sdk:build && npx vitest run apps/backtester/test/novelty-wiring.test.ts`
Expected: PASS

- [ ] **Step 5: Wire app.ts**

In `apps/backtester/src/app.ts`, construct the pool right after the `trialLedger` construction (~line 99) — mirror it exactly. The file's Pg pool local is named **`ownedPool`** (as used by `new PgTrialLedger(ownedPool)`):

```ts
  // E5a: construct the novelty pool only when enabled — flag-OFF stays fully inert (no Pg table dep).
  const noveltyPool = config.novelty
    ? ownedPool
      ? new PgNoveltyPool(ownedPool)
      : new InMemoryNoveltyPool()
    : undefined;
```

Add the imports:

```ts
import { InMemoryNoveltyPool } from './jobs/ledger/novelty-pool';
import { PgNoveltyPool } from './jobs/ledger/pg-novelty-pool';
```

Add to the `workerDeps` object, after the `diagnostics` spread (~line 186):

```ts
    ...(noveltyPool
      ? { novelty: { enabled: true, threshold: config.noveltyCorrThreshold, minOverlapDays: config.noveltyMinOverlapDays, pool: noveltyPool } }
      : {}),
```

- [ ] **Step 6: Typecheck + full suite (golden byte-identical, flag OFF)**

Run: `npx tsc --noEmit -p tsconfig.json && npx vitest run`
Expected: typecheck exit 0; suite fully green (all prior goldens byte-identical since the flag is OFF by default everywhere).

- [ ] **Step 7: Commit**

```bash
git add apps/backtester/src/jobs/worker.ts apps/backtester/src/app.ts apps/backtester/test/novelty-wiring.test.ts
git commit -m "feat(research): E5a — worker finalize wiring for the novelty gate (advisory, flag OFF)"
```

---

## Self-Review

**Spec coverage:**
- Pure `novelty.ts` (toDailyPnlDeltas / pnlDeltaCorrelation / computeNovelty, gap semantics, day-label, scale-invariance) → Task 2. ✓
- SDK `Novelty` contract (both variants, comparabilityKey in each, nearest with ref+runId) → Task 1. ✓
- NoveltyPool store, comparabilityKey (no period/hint), dedupe, exclude-fingerprint, order → Tasks 3 (InMemory) + 4 (Pg + migration 0008). ✓
- Config flag + validated thresholds, fail-fast-when-enabled, disabled-no-NaN → Task 5. ✓
- Worker wiring, `resolveNovelty` exported, query→score→record self-exclusion, empty_candidate not recorded, non-hashed projection → Task 6. ✓
- Determinism / flag-OFF byte-identical goldens → Task 6 Step 6 (full suite). ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; test bodies are concrete.

**Type consistency:** `computeNovelty`/`toDailyPnlDeltas`/`pnlDeltaCorrelation`/`NoveltyPoolMember` (Task 2) match their uses in Task 6. `PoolRecord`/`NoveltyPool`/`computeComparabilityKey` (Task 3) match Tasks 4 & 6. `Novelty`/`NoveltyNearest` (Task 1) match the engine + worker. `NoveltyConfigError` (Task 2) is imported by config (Task 5). `resolveNovelty(deps, claimed, outcome, resultHash)` signature is consistent between the export (Task 6 Step 3) and the finalize call (Task 6 Step 3) and the test (Task 6 Step 1). Config field names `novelty`/`noveltyCorrThreshold`/`noveltyMinOverlapDays` consistent across config.ts, helpers.ts, app.ts.

**Note for the implementer:** `resolveNovelty` takes `(deps, claimed, outcome, resultHash)` rather than the spec's `NoveltyContext` object — this is the spec's explicitly-offered alternative and matches the existing `resolveHoldoutMarker(deps, claimed)` idiom (`claimed: JobRow` already carries `request`, `requestFingerprint`, `runId`, `datasetRef`).
