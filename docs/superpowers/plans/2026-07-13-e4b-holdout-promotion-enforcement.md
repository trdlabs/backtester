# E4b Held-Out Promotion Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate signed `backtest-evidence/v2` promotion evidence on held-out OOS qualification — for a `mode:'promotion'` run, sign only when the candidate passes server-policy metric thresholds evaluated over the reserved holdout window, recording each attempt in a durable atomic ledger.

**Architecture:** A signature-gate (not a job-failure gate): the promotion decision + v2 evidence live on the post-hash summary projection / as a signed artifact, so `result_hash` and `decideVerdict`'s pass/fail semantics for non-promotion runs stay byte-identical. Two pure fns (`evaluatePromotionIntegrity` + `evaluatePromotionWindow`) do integrity, held-out structural checks, window evaluation, and verdict (single canonical order, one reason); a thin worker orchestrator interleaves the trusted-epoch resolve between them, records the attempt atomically (verdict computed before the ledger), and signs v2 iff passed (and persisted). Reuses the extracted-from-E3b pure `evaluateWindow`.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` specifiers), Vitest, `pg`, pnpm workspace, `@trading-backtester/sdk` (built with `pnpm sdk:build`).

## Global Constraints

- **Determinism:** `result_hash = contentRef(payload)` byte-identical with the flag OFF or `mode!=='promotion'`. `promotion` field + v2 evidence are post-hash (summary projection / artifact ref). `decideVerdict` is REUSED unmodified.
- **Flag default OFF:** `BACKTESTER_PROMOTION_HOLDOUT_GATE`. When OFF or `mode!=='promotion'` ⇒ NO `promotion` field at all, existing v1 evidence behavior. All new SDK fields optional (`?`).
- **Signature-gate:** enforcement = presence/absence of a valid `backtest-evidence/v2` signature. Job lifecycle unchanged (stays `completed`). Signed ONLY when the promotion verdict is `passed`.
- **Single canonical pipeline, ONE reason:** early-return on first failure ⇒ `PromotionResult` is a discriminated union whose `not_qualified` arm carries exactly one `PromotionFailureReason`. Order (orchestrated across two pure fns + worker I/O): `signing_unavailable` → `curated_unavailable` → [integrity] `gate_rejected` → `twin_divergent` → [resolve] `holdout_unavailable` → [window] `holdout_not_covered` → `warmup_insufficient` → `evaluation_insufficient` → (compute verdict) → **record attempt** (`attempt_record_failed`) → `metrics_failed` / sign (`internal_error` on any unexpected fault — sign/persist included; NEVER `passed` unless the artifact actually persisted). **Enabled + `mode:'promotion'` ALWAYS returns a `PromotionResult`** (never `undefined` — that is reserved for flag-off / non-promotion, so an operational failure is never confused with the feature being off).
- **Verdict-before-ledger, record-regardless:** compute holdout metrics + `decideVerdict` FIRST (so the verdict is stored on the attempt row), THEN record the attempt (counter advances even for `failed`), THEN return `metrics_failed` or sign.
- **Policy metrics, not request.metrics:** the gate evaluates the 4 policy metrics (`['sharpe','max_drawdown','win_rate','total_trades']`), never `request.metrics`.
- **Warmup = distinct engine equity steps:** `minWarmupBars` counts distinct `equityCurve` points with `barTs < window.from` (not calendar bars).
- **Epoch is server-derived, no request field:** `DatasetIdentityEpochResolver` — `epochId = validated datasetRef`; unknown ⇒ `holdout_unavailable`. NO new `BacktestRunRequest` field.
- **Ledger atomic:** `recordIfNewAndGetAttempt` uses an epoch-counter row + `FOR UPDATE`; dedupe on `(qualificationEpochKey, attemptIdentity)` where `attemptIdentity = sha256(requestFingerprint, datasetFingerprint)`; `attempt_number` + `verdict` persisted per row; ledger throw ⇒ `attempt_record_failed`, no signature (fail-closed). Pg `Promise.all` concurrency test mandatory.
- **ESM imports** end in `.js` (except `config.ts`/`app.ts`, extensionless). SDK types from `@trading-backtester/sdk/contracts`.
- **Run from repo root.** Single test: `npx vitest run <path>`. Full suite: `npx vitest run` (~8 min). SDK type changes need `pnpm sdk:build` first.
- **Base:** branch rebased on `origin/main` `787599e` (post #121–#124). Any `worker.ts`/`config.ts` line numbers in this plan are approximate (shifted by #123) — ALWAYS grep for the named anchor (e.g. `curatedBaselineRef !== undefined && deps.evidenceSigningKey`, the `if (novelty) summary` merge, the walkForward config fields) rather than trusting a line number. Latest migration is `0008` ⇒ E4b's is `0009`.

---

### Task 1: SDK contract — `PromotionResult`, `EvidenceBodyV2`, reasons, summary field

**Files:**
- Modify: `packages/sdk/src/contracts/run.ts` (add types after `WalkForward` ~line 92; add `promotion?` to `RunResultSummary` ~after `walkForward?` line 307)
- Test: `packages/sdk/test/contracts.test.ts`

**Interfaces:**
- Consumes: `RunPeriod` (existing).
- Produces: `PromotionFailureReason`, `PromotionResult`, `EvidenceBodyV2`, `EvidenceThresholds` (re-declared in SDK for the body), `RunResultSummary.promotion?`.

- [ ] **Step 1: Write the failing test**

Add to `packages/sdk/test/contracts.test.ts`:

```ts
import type { PromotionResult } from '../src/contracts/run.js';

it('PromotionResult carries passed + not_qualified shapes with a single reason', () => {
  const passed: PromotionResult = { verdict: 'passed', evaluatedOn: 'holdout', attemptNumber: 3, evaluationWindow: { from: 'a', to: 'b' } };
  const failed: PromotionResult = { verdict: 'not_qualified', reason: 'holdout_not_covered', evaluatedOn: 'holdout' };
  expect(passed.verdict).toBe('passed');
  expect(failed.reason).toBe('holdout_not_covered');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/sdk/test/contracts.test.ts`
Expected: FAIL — `run.js` has no exported member `PromotionResult`.

- [ ] **Step 3: Add the types**

In `packages/sdk/src/contracts/run.ts`, after the `WalkForward` block:

```ts
// E4b — held-out promotion enforcement (advisory feedback + signed-evidence gate; NOT hashed).
export type PromotionFailureReason =
  | 'signing_unavailable' | 'curated_unavailable' | 'gate_rejected' | 'twin_divergent'
  | 'holdout_unavailable' | 'holdout_not_covered' | 'warmup_insufficient'
  | 'evaluation_insufficient' | 'attempt_record_failed' | 'metrics_failed' | 'internal_error';
// Discriminated union: `passed` NEVER carries a reason and ALWAYS has attemptNumber + evaluationWindow
// (it was recorded and evaluated); `not_qualified` ALWAYS carries exactly one reason.
export type PromotionResult =
  | { readonly verdict: 'passed'; readonly reason?: never; readonly attemptNumber: number;
      readonly evaluationWindow: RunPeriod; readonly evaluatedOn: 'holdout' }
  | { readonly verdict: 'not_qualified'; readonly reason: PromotionFailureReason;
      readonly attemptNumber?: number; readonly evaluationWindow?: RunPeriod; readonly evaluatedOn: 'holdout' };
export interface EvidenceThresholdsV2 {
  readonly minSharpe: number; readonly maxDrawdown: number; readonly minWinRate: number; readonly minTrades: number;
}
// The signed promotion body. FLAT v1 fields (schema/backtesterRunId/bundleHash/verdict/datasetRef/window/
// symbols/timeframe/keyId) + the E4b held-out binding. Signed only when verdict === 'passed'.
export interface EvidenceBodyV2 {
  readonly schema: 'backtest-evidence/v2';
  readonly backtesterRunId: string;
  readonly bundleHash: string;
  readonly verdict: 'passed';
  readonly datasetRef: string;
  readonly window: { readonly fromMs: number; readonly toMs: number };  // EXECUTION window
  readonly symbols: readonly string[];
  readonly timeframe: string;
  readonly keyId: string;
  readonly mode: 'promotion';
  readonly evaluationWindow: { readonly fromMs: number; readonly toMs: number };  // holdout window
  readonly candidateHoldoutMetrics: Record<string, number>;
  readonly curatedHoldoutMetrics: Record<string, number>;
  readonly thresholds: EvidenceThresholdsV2;
  readonly attemptNumber: number;
  readonly qualificationEpochKey: string;
  readonly candidateResultHash: string;
  readonly curatedResultHash: string;
  readonly curatedBaselineRef: string;
  readonly qualification: { readonly coverage: RunPeriod; readonly fraction: number; readonly policyVersion: string; readonly datasetFingerprint: string };
}
```

Add to `RunResultSummary`, after the `walkForward?` field:

```ts
  /** E4b: advisory promotion verdict (held-out gate); NOT covered by `resultHash`. */
  readonly promotion?: PromotionResult;
```

- [ ] **Step 4: Build SDK + run test**

Run: `pnpm sdk:build && npx vitest run packages/sdk/test/contracts.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/contracts/run.ts packages/sdk/test/contracts.test.ts
git commit -m "feat(sdk): E4b — PromotionResult + EvidenceBodyV2 contract"
```

---

### Task 2: Extract shared `evaluateWindow` (byte-identical E3b refactor)

**Files:**
- Create: `apps/backtester/src/engine/window-eval.ts`
- Modify: `apps/backtester/src/engine/walk-forward-exec.ts` (replace inline anchor/filter/metrics with the helper; lines ~38-43 + ~76-83)
- Test: `apps/backtester/test/window-eval.test.ts`

**Interfaces:**
- Consumes: `EquityPoint`, `Trade`, `RunOutcome` from `./artifacts.js`; `computeMetrics` from `./metrics.js`.
- Produces:
  - `type CompletedOutcome = Extract<RunOutcome, { status: 'completed' }>`
  - `function anchoredTestEquity(equity, fromMs, toMs): EquityPoint[]`
  - `function evaluateWindow(outcome: CompletedOutcome, window: { from: string; to: string }, requestedMetrics: readonly string[]): { equity: EquityPoint[]; inTest: Trade[]; carryInClosedTradeCount: number; metrics: Record<string, number>; warmupSteps: number }`

- [ ] **Step 1: Write the failing test**

Create `apps/backtester/test/window-eval.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { EquityPoint, Trade } from '../src/engine/artifacts.js';
import { evaluateWindow, type CompletedOutcome } from '../src/engine/window-eval.js';

const DAY = 86_400_000;
function pt(day: number, equity: number): EquityPoint { return { barIndex: day, barTs: day * DAY, equity }; }
function trade(entryDay: number, exitDay: number, pnl: number): Trade {
  return { id: `t${entryDay}`, symbol: 'BTCUSDT', side: 'long', entryBarIndex: 0, entryTs: entryDay * DAY,
    entryFillPrice: 100, exitBarIndex: 1, exitTs: exitDay * DAY, exitFillPrice: 100 + pnl, size: 1, feePaid: 0,
    realizedPnl: pnl, closeReason: 'end_of_data' } as Trade;
}
function outcome(eq: EquityPoint[], tr: Trade[]): CompletedOutcome {
  return { status: 'completed', baseline: { trades: tr, evidence: { equityCurve: eq } } } as unknown as CompletedOutcome;
}
const window = { from: new Date(2 * DAY).toISOString(), to: new Date(4 * DAY).toISOString() };

describe('evaluateWindow', () => {
  it('anchors equity (last point before from) + counts warmup steps + filters fully-in-test trades', () => {
    const r = evaluateWindow(
      outcome([pt(0, 100), pt(1, 110), pt(2, 120), pt(3, 130)], [trade(2.2, 3.2, 5), trade(1, 2.5, 9)]),
      window, ['total_trades'],
    );
    // anchor = pt(1) (last < 2d); within = pt(2), pt(3) ⇒ 3 points
    expect(r.equity.map((p) => p.barIndex)).toEqual([1, 2, 3]);
    // warmup = distinct equity steps with barTs < window.from (days 0,1) ⇒ 2
    expect(r.warmupSteps).toBe(2);
    // in-test trade = entry>=2d && exit<4d ⇒ only trade(2.2,3.2); trade(1,2.5) is carry-in
    expect(r.metrics.total_trades).toBe(1);
    expect(r.carryInClosedTradeCount).toBe(1);
  });
  it('warmup counts DISTINCT barTs, not raw equity points (multi-symbol tape)', () => {
    // two equity points on the SAME pre-window barTs (day 1) ⇒ ONE warmup step, not two
    const r = evaluateWindow(
      outcome([pt(1, 100), { barIndex: 1, barTs: 1 * DAY, equity: 101 }, pt(2, 120), pt(3, 130)], []),
      window, ['total_trades'],
    );
    expect(r.warmupSteps).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/backtester/test/window-eval.test.ts`
Expected: FAIL — module `../src/engine/window-eval.js` not found.

- [ ] **Step 3: Create the shared helper**

Create `apps/backtester/src/engine/window-eval.ts`:

```ts
// E3b/E4b — pure window evaluation: anchored equity slice + fully-in-test trade filter + computeMetrics
// over a [from, to) window of a completed outcome. Extracted so both walk-forward folds (E3b) and the
// held-out promotion gate (E4b) share one implementation.

import type { EquityPoint, RunOutcome, Trade } from './artifacts.js';
import { computeMetrics } from './metrics.js';

export type CompletedOutcome = Extract<RunOutcome, { status: 'completed' }>;
const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

/** Anchored test-window equity: last point with barTs < fromMs (boundary anchor) + points in [fromMs, toMs). */
export function anchoredTestEquity(equity: readonly EquityPoint[], fromMs: number, toMs: number): EquityPoint[] {
  const within = equity.filter((p) => p.barTs >= fromMs && p.barTs < toMs);
  let anchor: EquityPoint | undefined;
  for (const p of equity) if (p.barTs < fromMs && (anchor === undefined || p.barTs > anchor.barTs)) anchor = p;
  return anchor ? [anchor, ...within] : within;
}

export function evaluateWindow(
  outcome: CompletedOutcome,
  window: { from: string; to: string },
  requestedMetrics: readonly string[],
): { equity: EquityPoint[]; inTest: Trade[]; carryInClosedTradeCount: number; metrics: Record<string, number>; warmupSteps: number } {
  const fromMs = Date.parse(window.from);
  const toMs = Date.parse(window.to);
  const allEquity = outcome.baseline.evidence.equityCurve;
  const equity = anchoredTestEquity(allEquity, fromMs, toMs);
  // DISTINCT engine timestamps before the window (multi-symbol tape can emit several equity points per
  // barTs — one engine step). Count distinct barTs, NOT raw point count.
  const warmupSteps = new Set(allEquity.filter((p) => p.barTs < fromMs).map((p) => p.barTs)).size;
  const allTrades = outcome.baseline.trades;
  const inTest = allTrades.filter((t: Trade) => t.entryTs >= fromMs && t.exitTs < toMs);
  const carryInClosedTradeCount = allTrades.filter(
    (t: Trade) => t.entryTs < fromMs && t.exitTs >= fromMs && t.exitTs < toMs,
  ).length;
  const metrics = computeMetrics(requestedMetrics, equity, inTest, { elapsedYears: (toMs - fromMs) / YEAR_MS });
  return { equity, inTest, carryInClosedTradeCount, metrics, warmupSteps };
}
```

- [ ] **Step 4: Refactor `walk-forward-exec.ts` to use it (byte-identical)**

In `apps/backtester/src/engine/walk-forward-exec.ts`: delete the private `anchoredTestEquity` (lines ~38-43) and replace the inline per-fold anchor/`inTest`/`carryInClosedTradeCount`/`computeMetrics` block (~lines 76-83) with a single `evaluateWindow(ran.outcome, fold.test, opts.requestedMetrics)` call, destructuring `{ equity, carryInClosedTradeCount, metrics }` and keeping the SAME `equity.length < 2` insufficiency check and the SAME `WalkForwardFoldResult` fields. Add `import { evaluateWindow } from './window-eval.js';` and drop the now-unused `computeMetrics`/`anchoredTestEquity` locals if no longer referenced.

- [ ] **Step 5: Run window-eval test + the full E3b suite (byte-identical proof)**

Run: `pnpm sdk:build && npx vitest run apps/backtester/test/window-eval.test.ts apps/backtester/test/walk-forward-exec.test.ts`
Expected: window-eval PASS; **all E3b `walk-forward-exec` tests still PASS unchanged** (the refactor is behavior-preserving). If any E3b test moved, the extraction changed behavior — fix it.

- [ ] **Step 6: Commit**

```bash
git add apps/backtester/src/engine/window-eval.ts apps/backtester/src/engine/walk-forward-exec.ts apps/backtester/test/window-eval.test.ts
git commit -m "refactor(research): extract shared pure evaluateWindow (E3b→shared, byte-identical)"
```

---

### Task 3: Promotion identity — family key, epoch key, resolver

**Files:**
- Create: `apps/backtester/src/jobs/promotion/identity.ts`
- Create: `apps/backtester/src/jobs/promotion/epoch-resolver.ts`
- Test: `apps/backtester/test/promotion-identity.test.ts`

**Interfaces:**
- Consumes: `sha256Hex` from `../../determinism/hash.js`; `canonicalJson` from `../../determinism/canonical-json.js`; `DataPort`/`DatasetDescriptor` (via a minimal `{ listDatasets(): Promise<readonly {datasetRef}[]> }`); `JobRow`.
- Produces:
  - `computePromotionFamilyKey(req): string` — `{ hint, datasetRef, symbols↑, timeframe }`, NO period.
  - `computeQualificationEpochKey(promotionFamilyKey, epochId, policyVersion): string`
  - `computeAttemptIdentity(requestFingerprint, datasetFingerprint): string`
  - `interface QualificationEpochResolver { resolve(claimed: JobRow): Promise<{ epochId: string } | null> }`
  - `class DatasetIdentityEpochResolver implements QualificationEpochResolver`

- [ ] **Step 1: Write the failing test**

Create `apps/backtester/test/promotion-identity.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { computePromotionFamilyKey, computeQualificationEpochKey, computeAttemptIdentity } from '../src/jobs/promotion/identity.js';
import { DatasetIdentityEpochResolver } from '../src/jobs/promotion/epoch-resolver.js';

const req = { moduleRef: { id: 'm' }, datasetRef: 'ds', symbols: ['ETH', 'BTC'], timeframe: '1m',
  period: { from: '2023-01-01T00:00:00.000Z', to: '2023-02-01T00:00:00.000Z' } };

describe('promotion identity', () => {
  it('family key excludes period (two periods, same key) and is symbol-order-insensitive', () => {
    const a = computePromotionFamilyKey(req);
    const b = computePromotionFamilyKey({ ...req, period: { from: '2024-01-01T00:00:00.000Z', to: '2024-02-01T00:00:00.000Z' } });
    const c = computePromotionFamilyKey({ ...req, symbols: ['BTC', 'ETH'] });
    expect(a).toBe(b);
    expect(a).toBe(c);
  });
  it('epoch key differs on epochId / policyVersion; attemptIdentity differs on datasetFingerprint', () => {
    expect(computeQualificationEpochKey('fam', 'e1', 'p1')).not.toBe(computeQualificationEpochKey('fam', 'e2', 'p1'));
    expect(computeQualificationEpochKey('fam', 'e1', 'p1')).not.toBe(computeQualificationEpochKey('fam', 'e1', 'p2'));
    expect(computeAttemptIdentity('fp', 'dsf1')).not.toBe(computeAttemptIdentity('fp', 'dsf2'));
    expect(computeAttemptIdentity('fp', 'dsf1')).toBe(computeAttemptIdentity('fp', 'dsf1'));
  });
});

describe('DatasetIdentityEpochResolver', () => {
  const port = { listDatasets: async () => [{ datasetRef: 'ds' }] } as any;
  it('resolves a known datasetRef to its canonical id', async () => {
    const r = await new DatasetIdentityEpochResolver(port).resolve({ datasetRef: 'ds' } as any);
    expect(r).toEqual({ epochId: 'ds' });
  });
  it('returns null for an unknown datasetRef', async () => {
    expect(await new DatasetIdentityEpochResolver(port).resolve({ datasetRef: 'nope' } as any)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/backtester/test/promotion-identity.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

Create `apps/backtester/src/jobs/promotion/identity.ts`:

```ts
// E4b — promotion identity keys. Family key is PERIOD-FREE (period-reselection must not split families);
// epoch key uses the trusted resolved epochId; attempt identity includes the data snapshot.
import { canonicalJson } from '../../determinism/canonical-json.js';
import { sha256Hex } from '../../determinism/hash.js';

export interface PromotionFamilyInput {
  readonly trialFamilyHint?: string;
  readonly moduleRef: { readonly id: string };
  readonly datasetRef: string;
  readonly symbols: readonly string[];
  readonly timeframe: string;
}
export function computePromotionFamilyKey(req: PromotionFamilyInput): string {
  return sha256Hex(canonicalJson({
    hint: req.trialFamilyHint ?? req.moduleRef.id,
    datasetRef: req.datasetRef,
    symbols: [...req.symbols].sort(),
    timeframe: req.timeframe,
  }));
}
export function computeQualificationEpochKey(promotionFamilyKey: string, epochId: string, policyVersion: string): string {
  return sha256Hex(canonicalJson({ promotionFamilyKey, epochId, policyVersion }));
}
export function computeAttemptIdentity(requestFingerprint: string, datasetFingerprint: string): string {
  return sha256Hex(canonicalJson({ requestFingerprint, datasetFingerprint }));
}
```

Create `apps/backtester/src/jobs/promotion/epoch-resolver.ts`:

```ts
// E4b — TRUSTED epoch resolver: the epoch identity is server-derived, never a client string. The
// production resolver validates the run's datasetRef against the data port and uses it as the epoch.
import type { JobRow } from '../job-store.js';

export interface QualificationEpochResolver {
  resolve(claimed: JobRow): Promise<{ epochId: string } | null>;
}

interface DatasetLister { listDatasets(): Promise<readonly { readonly datasetRef: string }[]>; }

export class DatasetIdentityEpochResolver implements QualificationEpochResolver {
  constructor(private readonly dataPort: DatasetLister) {}
  async resolve(claimed: JobRow): Promise<{ epochId: string } | null> {
    const datasets = await this.dataPort.listDatasets();
    const found = datasets.find((d) => d.datasetRef === claimed.datasetRef);
    return found ? { epochId: found.datasetRef } : null;
  }
}
```

(Confirm the `sha256Hex`/`canonicalJson` import paths against `apps/backtester/src/jobs/ledger/trial-ledger.ts`'s imports; and `JobRow` is exported from `../job-store.js`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/backtester/test/promotion-identity.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/jobs/promotion/identity.ts apps/backtester/src/jobs/promotion/epoch-resolver.ts apps/backtester/test/promotion-identity.test.ts
git commit -m "feat(research): E4b — promotion family/epoch keys + dataset-identity epoch resolver"
```

---

### Task 4: `PromotionAttemptLedger` — InMemory + Pg (atomic) + migration 0009

**Files:**
- Create: `apps/backtester/src/jobs/promotion/attempt-ledger.ts` (interface + InMemory)
- Create: `apps/backtester/src/jobs/promotion/pg-attempt-ledger.ts`
- Create: `apps/backtester/migrations/0009_promotion_attempt_ledger.sql`
- Test: `apps/backtester/test/promotion-attempt-ledger.test.ts`

**Interfaces:**
- Produces:
  - `interface PromotionAttemptRecord { qualificationEpochKey, attemptIdentity, requestFingerprint, datasetFingerprint, runId, resultHash, verdict: 'passed'|'failed', createdAtMs }`
  - `interface PromotionAttemptLedger { recordIfNewAndGetAttempt(r): Promise<{ attemptNumber: number; inserted: boolean }> }`
  - `class InMemoryPromotionAttemptLedger` / `class PgPromotionAttemptLedger`

- [ ] **Step 1: Write the migration**

Create `apps/backtester/migrations/0009_promotion_attempt_ledger.sql`:

```sql
-- 0009: E4b promotion attempt ledger. Counts held-out qualification attempts per (epoch, attempt).
-- Epoch counter row assigns a monotonic attempt_number under FOR UPDATE so concurrent attempts never
-- collide; the attempt row persists the assigned number + verdict. Dedupe axis (epoch_key,
-- attempt_identity=hash(request_fingerprint, dataset_fingerprint)) so a backfill (new snapshot) is a new
-- attempt while a true replay keeps its number.
CREATE TABLE IF NOT EXISTS backtest_promotion_epoch (
  epoch_key    TEXT    NOT NULL PRIMARY KEY,
  next_attempt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS backtest_promotion_attempt (
  epoch_key           TEXT    NOT NULL,
  attempt_identity    TEXT    NOT NULL,
  attempt_number      INTEGER NOT NULL,
  request_fingerprint TEXT    NOT NULL,
  dataset_fingerprint TEXT    NOT NULL,
  run_id              TEXT    NOT NULL,
  result_hash         TEXT    NOT NULL,
  verdict             TEXT    NOT NULL,
  created_at_ms       BIGINT  NOT NULL,
  PRIMARY KEY (epoch_key, attempt_identity)
);
```

- [ ] **Step 2: Write the failing test**

Create `apps/backtester/test/promotion-attempt-ledger.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { InMemoryPromotionAttemptLedger, type PromotionAttemptRecord } from '../src/jobs/promotion/attempt-ledger.js';

function rec(over: Partial<PromotionAttemptRecord> = {}): PromotionAttemptRecord {
  return { qualificationEpochKey: 'e', attemptIdentity: 'a1', requestFingerprint: 'fp', datasetFingerprint: 'dsf',
    runId: 'r', resultHash: 'h', verdict: 'failed', createdAtMs: 1, ...over };
}

describe('InMemoryPromotionAttemptLedger', () => {
  it('assigns monotonic attempt numbers to distinct attempts', async () => {
    const l = new InMemoryPromotionAttemptLedger();
    expect(await l.recordIfNewAndGetAttempt(rec({ attemptIdentity: 'a1' }))).toEqual({ attemptNumber: 1, inserted: true });
    expect(await l.recordIfNewAndGetAttempt(rec({ attemptIdentity: 'a2' }))).toEqual({ attemptNumber: 2, inserted: true });
  });
  it('a true replay (same identity) returns the historical number, no increment', async () => {
    const l = new InMemoryPromotionAttemptLedger();
    await l.recordIfNewAndGetAttempt(rec({ attemptIdentity: 'a1' }));
    expect(await l.recordIfNewAndGetAttempt(rec({ attemptIdentity: 'a1' }))).toEqual({ attemptNumber: 1, inserted: false });
    // next distinct attempt still gets 2 (replay did not consume the counter)
    expect(await l.recordIfNewAndGetAttempt(rec({ attemptIdentity: 'a2' }))).toEqual({ attemptNumber: 2, inserted: true });
  });
  it('a failed attempt still advances the counter (record-regardless)', async () => {
    const l = new InMemoryPromotionAttemptLedger();
    await l.recordIfNewAndGetAttempt(rec({ attemptIdentity: 'a1', verdict: 'failed' }));
    expect((await l.recordIfNewAndGetAttempt(rec({ attemptIdentity: 'a2', verdict: 'passed' }))).attemptNumber).toBe(2);
  });
  it('separate epochs count independently', async () => {
    const l = new InMemoryPromotionAttemptLedger();
    await l.recordIfNewAndGetAttempt(rec({ qualificationEpochKey: 'e1', attemptIdentity: 'a1' }));
    expect((await l.recordIfNewAndGetAttempt(rec({ qualificationEpochKey: 'e2', attemptIdentity: 'a1' }))).attemptNumber).toBe(1);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run apps/backtester/test/promotion-attempt-ledger.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement InMemory**

Create `apps/backtester/src/jobs/promotion/attempt-ledger.ts`:

```ts
// E4b — promotion attempt ledger. Atomic monotonic numbering per epoch; dedupe by (epoch, attemptIdentity).
export interface PromotionAttemptRecord {
  readonly qualificationEpochKey: string;
  readonly attemptIdentity: string;
  readonly requestFingerprint: string;
  readonly datasetFingerprint: string;
  readonly runId: string;
  readonly resultHash: string;
  readonly verdict: 'passed' | 'failed';
  readonly createdAtMs: number;
}
export interface PromotionAttemptLedger {
  recordIfNewAndGetAttempt(r: PromotionAttemptRecord): Promise<{ attemptNumber: number; inserted: boolean }>;
}

export class InMemoryPromotionAttemptLedger implements PromotionAttemptLedger {
  private readonly next = new Map<string, number>();                 // epochKey → next attempt
  private readonly attempts = new Map<string, number>();             // `${epochKey}\0${attemptIdentity}` → number
  async recordIfNewAndGetAttempt(r: PromotionAttemptRecord): Promise<{ attemptNumber: number; inserted: boolean }> {
    const key = `${r.qualificationEpochKey}\0${r.attemptIdentity}`;
    const existing = this.attempts.get(key);
    if (existing !== undefined) return { attemptNumber: existing, inserted: false };
    const n = this.next.get(r.qualificationEpochKey) ?? 1;
    this.attempts.set(key, n);
    this.next.set(r.qualificationEpochKey, n + 1);
    return { attemptNumber: n, inserted: true };
  }
}
```

- [ ] **Step 5: Run InMemory test to verify it passes**

Run: `npx vitest run apps/backtester/test/promotion-attempt-ledger.test.ts`
Expected: PASS

- [ ] **Step 6: Implement Pg (atomic transaction) + concurrency test**

Create `apps/backtester/src/jobs/promotion/pg-attempt-ledger.ts`:

```ts
// E4b — Postgres promotion attempt ledger (migration 0009). Atomic: a transaction locks the epoch
// counter row (FOR UPDATE), so concurrent distinct attempts get distinct monotonic numbers; a replay
// (same epoch+attemptIdentity) returns its stored number without incrementing. NOTE: the repo has no
// transaction helper — use pool.connect() + BEGIN/COMMIT explicitly with a finally release.
import type { Pool } from 'pg';
import type { PromotionAttemptLedger, PromotionAttemptRecord } from './attempt-ledger.js';

export class PgPromotionAttemptLedger implements PromotionAttemptLedger {
  constructor(private readonly pool: Pool) {}
  async recordIfNewAndGetAttempt(r: PromotionAttemptRecord): Promise<{ attemptNumber: number; inserted: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // 1) ensure the epoch counter row exists, then LOCK it FIRST — so concurrent same-identity calls
      //    serialize on this lock BEFORE the replay-check (else both see "no attempt" and the 2nd hits a
      //    duplicate-PK instead of returning inserted:false).
      await client.query(
        'INSERT INTO backtest_promotion_epoch (epoch_key, next_attempt) VALUES ($1, 1) ON CONFLICT (epoch_key) DO NOTHING',
        [r.qualificationEpochKey],
      );
      const locked = await client.query<{ next_attempt: number }>(
        'SELECT next_attempt FROM backtest_promotion_epoch WHERE epoch_key = $1 FOR UPDATE',
        [r.qualificationEpochKey],
      );
      // 2) replay-check UNDER the lock: a concurrent first-inserter has already committed its row by now.
      const replay = await client.query<{ attempt_number: number }>(
        'SELECT attempt_number FROM backtest_promotion_attempt WHERE epoch_key = $1 AND attempt_identity = $2',
        [r.qualificationEpochKey, r.attemptIdentity],
      );
      if ((replay.rowCount ?? 0) > 0) {
        await client.query('COMMIT');
        return { attemptNumber: Number(replay.rows[0].attempt_number), inserted: false };
      }
      // 3) assign + insert + advance the counter, all under the lock.
      const n = Number(locked.rows[0].next_attempt);
      await client.query(
        `INSERT INTO backtest_promotion_attempt
           (epoch_key, attempt_identity, attempt_number, request_fingerprint, dataset_fingerprint, run_id, result_hash, verdict, created_at_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [r.qualificationEpochKey, r.attemptIdentity, n, r.requestFingerprint, r.datasetFingerprint, r.runId, r.resultHash, r.verdict, r.createdAtMs],
      );
      await client.query('UPDATE backtest_promotion_epoch SET next_attempt = $2 WHERE epoch_key = $1', [r.qualificationEpochKey, n + 1]);
      await client.query('COMMIT');
      return { attemptNumber: n, inserted: true };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}
```

Add a Pg concurrency test to `apps/backtester/test/promotion-attempt-ledger.test.ts` (gated by `DATABASE_URL`, mirroring the repo's other Pg-gated tests — apply migration 0009 in a `beforeAll`, truncate the two tables in `beforeEach`):

```ts
import { Pool } from 'pg';
const PG = process.env.DATABASE_URL;
const d = PG ? describe : describe.skip;
d('PgPromotionAttemptLedger — Pg concurrency (mandatory)', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: PG });
    // apply migration 0009 — read the .sql and run it (mirror the repo's existing Pg-gated ledger test's migrate step)
    const sql = readFileSync(new URL('../migrations/0009_promotion_attempt_ledger.sql', import.meta.url), 'utf8');
    await pool.query(sql);
  });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => { await pool.query('TRUNCATE backtest_promotion_epoch, backtest_promotion_attempt'); });

  it('Promise.all of N DISTINCT attempts yields exactly {1..N} — no dup, no gap', async () => {
    const l = new PgPromotionAttemptLedger(pool);
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => l.recordIfNewAndGetAttempt(rec({ attemptIdentity: `a${i}` }))));
    expect(rs.every((x) => x.inserted)).toBe(true);
    expect(new Set(rs.map((x) => x.attemptNumber))).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8]));
  });

  it('concurrent replay of the SAME identity: exactly one insert, all callers see the same number', async () => {
    const l = new PgPromotionAttemptLedger(pool);
    const rs = await Promise.all(Array.from({ length: 5 }, () => l.recordIfNewAndGetAttempt(rec({ attemptIdentity: 'same' }))));
    expect(rs.filter((x) => x.inserted).length).toBe(1);           // exactly one winner inserts
    expect(new Set(rs.map((x) => x.attemptNumber))).toEqual(new Set([1])); // everyone gets number 1
    // the counter advanced exactly once → the next distinct attempt is 2
    expect((await l.recordIfNewAndGetAttempt(rec({ attemptIdentity: 'next' }))).attemptNumber).toBe(2);
  });

  it('a thrown query rolls back and releases the client (no leaked connection)', async () => {
    // Inject a pool whose connect() returns a client that throws on the INSERT to prove ROLLBACK + release.
    const released = { v: false };
    const fakeClient = { query: async (sql: string) => { if (sql.startsWith('INSERT INTO backtest_promotion_attempt')) throw new Error('boom'); return { rows: [{ next_attempt: 1 }], rowCount: 0 }; }, release: () => { released.v = true; } };
    const fakePool = { connect: async () => fakeClient } as unknown as Pool;
    await expect(new PgPromotionAttemptLedger(fakePool).recordIfNewAndGetAttempt(rec())).rejects.toThrow('boom');
    expect(released.v).toBe(true); // finally released the client even on throw
  });
});
```

(The first two tests need a live Pg — gate on `DATABASE_URL`, mirror the repo's existing Pg-gated ledger test's pool/migrate setup — `git grep -l "DATABASE_URL" apps/backtester/test/`. The third — rollback/release — runs WITHOUT a real DB via a fake pool, so it's always exercised.)

- [ ] **Step 7: Run tests + commit**

Run: `npx vitest run apps/backtester/test/promotion-attempt-ledger.test.ts` (Pg case runs iff `DATABASE_URL`)
Expected: PASS

```bash
git add apps/backtester/src/jobs/promotion/attempt-ledger.ts apps/backtester/src/jobs/promotion/pg-attempt-ledger.ts apps/backtester/migrations/0009_promotion_attempt_ledger.sql apps/backtester/test/promotion-attempt-ledger.test.ts
git commit -m "feat(research): E4b — promotion attempt ledger (InMemory + atomic Pg + migration 0009)"
```

---

### Task 5: Pure promotion gate — `evaluatePromotionIntegrity` + `evaluatePromotionWindow`

**Files:**
- Create: `apps/backtester/src/evidence/promotion-gate.ts`
- Test: `apps/backtester/test/promotion-gate.test.ts`

**Interfaces:**
- Consumes: `evaluateWindow`, `CompletedOutcome` from `../engine/window-eval.js`; `decideVerdict`, `EvidenceThresholds` from `./verdict.js`; `compareBacktestRuns` from `../engine/equivalence.js`; `RunPeriod` from SDK.
- Produces TWO pure functions (split so the worker can interleave the resolver/coverage step between them, preserving the canonical order gate→twin→holdout):
  - `evaluatePromotionIntegrity(input: { candidate: CompletedOutcome; curated: CompletedOutcome; bundleGateRejected: boolean }): { outcome: 'ok' } | { outcome: 'reject'; reason: 'gate_rejected' | 'twin_divergent' }`
  - `evaluatePromotionWindow(input: { candidate: CompletedOutcome; curated: CompletedOutcome; holdoutWindow: RunPeriod; runPeriod: RunPeriod; thresholds: EvidenceThresholds; policyMetrics: readonly string[]; minWarmupBars: number; minTrades: number }): { outcome: 'reject'; reason: 'holdout_not_covered' | 'warmup_insufficient' | 'evaluation_insufficient' } | { outcome: 'evaluated'; verdict: 'passed'|'failed'; candidateHoldoutMetrics: Record<string,number>; curatedHoldoutMetrics: Record<string,number> }`

**Split rationale (P0-3):** the canonical order is `signing` → `curated` → `gate` → `twin` → `holdout` (resolve) → `not_covered`/`warmup`/`eval` → verdict. `signing_unavailable`, `curated_unavailable`, `holdout_unavailable` (coverage/epoch resolve), the ledger (`attempt_record_failed`), and `internal_error` are the WORKER's concern (Task 7). This module owns ONLY: integrity (`gate_rejected`, `twin_divergent`) and the window step (`holdout_not_covered` → `warmup_insufficient` → `evaluation_insufficient` → verdict). The worker calls `evaluatePromotionIntegrity` FIRST, then resolves the epoch+coverage (holdout_unavailable), then calls `evaluatePromotionWindow` — so the resolver never runs before the integrity checks. `evaluatePromotionWindow` receives a non-null `holdoutWindow`.

- [ ] **Step 1: Write the failing test**

Create `apps/backtester/test/promotion-gate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { EquityPoint, Trade } from '../src/engine/artifacts.js';
import { evaluatePromotionIntegrity, evaluatePromotionWindow } from '../src/evidence/promotion-gate.js';
import type { CompletedOutcome } from '../src/engine/window-eval.js';

const DAY = 86_400_000;
const pt = (d: number, e: number): EquityPoint => ({ barIndex: d, barTs: d * DAY, equity: e });
function oc(eq: EquityPoint[], tr: Trade[] = []): CompletedOutcome {
  return { status: 'completed', baseline: { trades: tr, evidence: { equityCurve: eq } } } as unknown as CompletedOutcome;
}
const THRESH = { minSharpe: 0, maxDrawdown: 1, minWinRate: 0, minTrades: 1 };
const POLICY = ['sharpe', 'max_drawdown', 'win_rate', 'total_trades'];
const holdout = { from: new Date(6 * DAY).toISOString(), to: new Date(10 * DAY).toISOString() };
const runPeriod = { from: new Date(0).toISOString(), to: new Date(10 * DAY).toISOString() };
const warmEquity = [pt(1, 100), pt(3, 105), pt(5, 108), pt(7, 120), pt(8, 118), pt(9, 130)]; // 3 pre-holdout steps
const trd = (entryDay: number, exitDay: number, pnl: number): Trade => ({ id: `t${entryDay}`, symbol: 'X', side: 'long', entryBarIndex: 0, entryTs: entryDay * DAY, entryFillPrice: 1, exitBarIndex: 1, exitTs: exitDay * DAY, exitFillPrice: 1 + pnl, size: 1, feePaid: 0, realizedPnl: pnl, closeReason: 'end_of_data' } as Trade);
const win = { holdoutWindow: holdout, runPeriod, thresholds: THRESH, policyMetrics: POLICY, minWarmupBars: 2, minTrades: 1 };

describe('evaluatePromotionIntegrity', () => {
  it('gate_rejected wins first', () => {
    expect(evaluatePromotionIntegrity({ bundleGateRejected: true, candidate: oc(warmEquity), curated: oc(warmEquity) }))
      .toEqual({ outcome: 'reject', reason: 'gate_rejected' });
  });
  it('twin_divergent when candidate != curated', () => {
    expect(evaluatePromotionIntegrity({ bundleGateRejected: false, candidate: oc(warmEquity, [trd(7, 8, 1)]), curated: oc(warmEquity) }))
      .toMatchObject({ outcome: 'reject', reason: 'twin_divergent' });
  });
  it('ok when valid + equivalent', () => {
    expect(evaluatePromotionIntegrity({ bundleGateRejected: false, candidate: oc(warmEquity), curated: oc(warmEquity) }))
      .toEqual({ outcome: 'ok' });
  });
});

describe('evaluatePromotionWindow', () => {
  it('holdout_not_covered when window not inside run period', () => {
    const shortRun = { from: new Date(0).toISOString(), to: new Date(7 * DAY).toISOString() };
    expect(evaluatePromotionWindow({ ...win, runPeriod: shortRun, candidate: oc(warmEquity), curated: oc(warmEquity) }))
      .toEqual({ outcome: 'reject', reason: 'holdout_not_covered' });
  });
  it('warmup_insufficient below minWarmupBars distinct pre-window steps', () => {
    const thin = [pt(5, 100), pt(7, 120), pt(9, 130)]; // only 1 distinct step < 6d
    expect(evaluatePromotionWindow({ ...win, candidate: oc(thin), curated: oc(thin) }))
      .toEqual({ outcome: 'reject', reason: 'warmup_insufficient' });
  });
  it('evaluation_insufficient when the holdout slice has < 2 points', () => {
    const noOos = [pt(1, 100), pt(3, 105), pt(5, 108)]; // nothing in [6d,10d), anchor pt(5) ⇒ 1 point
    expect(evaluatePromotionWindow({ ...win, candidate: oc(noOos), curated: oc(noOos) }))
      .toEqual({ outcome: 'reject', reason: 'evaluation_insufficient' });
  });
  it('evaluated → passed when holdout metrics pass thresholds', () => {
    const eq = oc(warmEquity, [trd(7, 8, 5)]);
    const r = evaluatePromotionWindow({ ...win, candidate: eq, curated: eq });
    expect(r.outcome).toBe('evaluated');
    if (r.outcome === 'evaluated') expect(r.verdict).toBe('passed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/backtester/test/promotion-gate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/backtester/src/evidence/promotion-gate.ts`:

```ts
// E4b — pure promotion gate, split so the worker interleaves the epoch/coverage resolve between the two
// (canonical order gate→twin→holdout). No I/O — ledger/sign/resolver live in the worker (Task 7).
import { compareBacktestRuns } from '../engine/equivalence.js';
import { evaluateWindow, type CompletedOutcome } from '../engine/window-eval.js';
import { decideVerdict, type EvidenceThresholds } from './verdict.js';
import type { RunPeriod } from '@trading-backtester/sdk/contracts';

export function evaluatePromotionIntegrity(input: {
  readonly candidate: CompletedOutcome; readonly curated: CompletedOutcome; readonly bundleGateRejected: boolean;
}): { outcome: 'ok' } | { outcome: 'reject'; reason: 'gate_rejected' | 'twin_divergent' } {
  if (input.bundleGateRejected) return { outcome: 'reject', reason: 'gate_rejected' };
  if (!compareBacktestRuns(input.curated, input.candidate).equivalent) return { outcome: 'reject', reason: 'twin_divergent' };
  return { outcome: 'ok' };
}

export function evaluatePromotionWindow(input: {
  readonly candidate: CompletedOutcome; readonly curated: CompletedOutcome;
  readonly holdoutWindow: RunPeriod;   // non-null: the worker handled holdout_unavailable already
  readonly runPeriod: RunPeriod; readonly thresholds: EvidenceThresholds;
  readonly policyMetrics: readonly string[]; readonly minWarmupBars: number; readonly minTrades: number;
}):
  | { outcome: 'reject'; reason: 'holdout_not_covered' | 'warmup_insufficient' | 'evaluation_insufficient' }
  | { outcome: 'evaluated'; verdict: 'passed' | 'failed'; candidateHoldoutMetrics: Record<string, number>; curatedHoldoutMetrics: Record<string, number> } {
  const w = input.holdoutWindow;
  const wFrom = Date.parse(w.from), wTo = Date.parse(w.to);
  const pFrom = Date.parse(input.runPeriod.from), pTo = Date.parse(input.runPeriod.to);
  if (!(pFrom <= wFrom && wTo <= pTo)) return { outcome: 'reject', reason: 'holdout_not_covered' };
  const evalC = evaluateWindow(input.candidate, w, input.policyMetrics);
  if (evalC.warmupSteps < input.minWarmupBars) return { outcome: 'reject', reason: 'warmup_insufficient' };
  if (evalC.equity.length < 2 || evalC.inTest.length < input.minTrades) return { outcome: 'reject', reason: 'evaluation_insufficient' };
  const evalCur = evaluateWindow(input.curated, w, input.policyMetrics);
  const verdict = decideVerdict(evalC.metrics, input.thresholds);
  return { outcome: 'evaluated', verdict, candidateHoldoutMetrics: evalC.metrics, curatedHoldoutMetrics: evalCur.metrics };
}
```

(Confirm `compareBacktestRuns` returns `{ equivalent }` — `apps/backtester/src/engine/equivalence.ts:71` — and `decideVerdict`/`EvidenceThresholds` exports from `./verdict.js`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm sdk:build && npx vitest run apps/backtester/test/promotion-gate.test.ts`
Expected: PASS (adjust fixture timestamps, not assertions, if a boundary misaligns.)

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/evidence/promotion-gate.ts apps/backtester/test/promotion-gate.test.ts
git commit -m "feat(research): E4b — pure promotion gate (single canonical order, one reason)"
```

---

### Task 6: `backtest-evidence/v2` body builder + sign

**Files:**
- Create: `apps/backtester/src/evidence/body-v2.ts`
- Test: `apps/backtester/test/evidence-body-v2.test.ts`

**Interfaces:**
- Consumes: `signEvidence` from `./signing.js` (generic `signEvidence<T>(body, privateKey)`); `EvidenceBodyV2` from SDK.
- Produces: `function buildEvidenceBodyV2(input): EvidenceBodyV2` — assembles the flat v1 fields + held-out binding (symbols sorted, `verdict: 'passed'`).

- [ ] **Step 1: Write the failing test**

Create `apps/backtester/test/evidence-body-v2.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildEvidenceBodyV2 } from '../src/evidence/body-v2.js';

describe('buildEvidenceBodyV2', () => {
  it('assembles a flat schema:v2 body with sorted symbols + held-out binding', () => {
    const body = buildEvidenceBodyV2({
      backtesterRunId: 'run-1', bundleHash: 'sha256:b', keyId: 'k',
      datasetRef: 'ds', executionWindow: { fromMs: 0, toMs: 100 }, symbols: ['ETH', 'BTC'], timeframe: '1m',
      evaluationWindow: { fromMs: 60, toMs: 100 },
      candidateHoldoutMetrics: { sharpe: 2 }, curatedHoldoutMetrics: { sharpe: 2 },
      thresholds: { minSharpe: 0, maxDrawdown: 1, minWinRate: 0, minTrades: 1 },
      attemptNumber: 3, qualificationEpochKey: 'ek',
      candidateResultHash: 'sha256:c', curatedResultHash: 'sha256:cu', curatedBaselineRef: { id: 'base', version: '1' } as any,
      qualification: { coverage: { from: 'a', to: 'b' }, fraction: 0.4, policyVersion: 'p1', datasetFingerprint: 'dsf' },
    });
    expect(body.schema).toBe('backtest-evidence/v2');
    expect(body.verdict).toBe('passed');
    expect(body.symbols).toEqual(['BTC', 'ETH']); // sorted
    expect(body.window).toEqual({ fromMs: 0, toMs: 100 });
    expect(body.evaluationWindow).toEqual({ fromMs: 60, toMs: 100 });
    expect(body.attemptNumber).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/backtester/test/evidence-body-v2.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/backtester/src/evidence/body-v2.ts`:

```ts
// E4b — build the flat backtest-evidence/v2 promotion body (v1 fields + held-out binding). Signed only
// when verdict === 'passed', so this builder hardcodes verdict:'passed'.
import type { EvidenceBodyV2 } from '@trading-backtester/sdk/contracts';

export function buildEvidenceBodyV2(input: {
  readonly backtesterRunId: string; readonly bundleHash: string; readonly keyId: string;
  readonly datasetRef: string; readonly executionWindow: { fromMs: number; toMs: number };
  readonly symbols: readonly string[]; readonly timeframe: string;
  readonly evaluationWindow: { fromMs: number; toMs: number };
  readonly candidateHoldoutMetrics: Record<string, number>; readonly curatedHoldoutMetrics: Record<string, number>;
  readonly thresholds: EvidenceBodyV2['thresholds']; readonly attemptNumber: number; readonly qualificationEpochKey: string;
  readonly candidateResultHash: string; readonly curatedResultHash: string;
  readonly curatedBaselineRef: { readonly id: string; readonly version: string };
  readonly qualification: EvidenceBodyV2['qualification'];
}): EvidenceBodyV2 {
  return {
    schema: 'backtest-evidence/v2',
    backtesterRunId: input.backtesterRunId,
    bundleHash: input.bundleHash,
    verdict: 'passed',
    datasetRef: input.datasetRef,
    window: input.executionWindow,
    symbols: [...input.symbols].sort(),
    timeframe: input.timeframe,
    keyId: input.keyId,
    mode: 'promotion',
    evaluationWindow: input.evaluationWindow,
    candidateHoldoutMetrics: input.candidateHoldoutMetrics,
    curatedHoldoutMetrics: input.curatedHoldoutMetrics,
    thresholds: input.thresholds,
    attemptNumber: input.attemptNumber,
    qualificationEpochKey: input.qualificationEpochKey,
    candidateResultHash: input.candidateResultHash,
    curatedResultHash: input.curatedResultHash,
    curatedBaselineRef: `${input.curatedBaselineRef.id}@${input.curatedBaselineRef.version}`,
    qualification: input.qualification,
  };
}
```

(Signing uses the existing generic `signEvidence(body, key.privateKey)` from `./signing.js` in Task 7 — `signEvidence<T>` already accepts any body shape.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm sdk:build && npx vitest run apps/backtester/test/evidence-body-v2.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/evidence/body-v2.ts apps/backtester/test/evidence-body-v2.test.ts
git commit -m "feat(research): E4b — backtest-evidence/v2 body builder"
```

---

### Task 7: Worker orchestration `resolvePromotionGate` + config flag

**Files:**
- Modify: `apps/backtester/src/config.ts` (flag `walkForward`-adjacent) + `apps/backtester/test/helpers.ts`
- Create: `apps/backtester/src/jobs/promotion/resolve-promotion.ts`
- Test: `apps/backtester/test/resolve-promotion.test.ts` + `apps/backtester/test/config-promotion.test.ts`

**Interfaces:**
- Consumes: `evaluatePromotionIntegrity`/`evaluatePromotionWindow` (Task 5), `buildEvidenceBodyV2` (Task 6), `signEvidence` + `serializeArtifact`/`artifactRef` (`../../evidence/signing.js`/evidence modules), the identity helpers + `QualificationEpochResolver` (Task 3), `PromotionAttemptLedger` (Task 4), `computeHoldoutWindow`/`HoldoutConfigError` (`../../engine/holdout.js`), `DEFAULT_THRESHOLDS` (`../../evidence/verdict.js`), `platformContractContext`+`validateBundle` (for `bundleGateRejected`), `sha256BundleRef` (bundle hash), `contentRef` (candidate/curated result hashes).
- Produces:
  - `function buildPromotionPolicy(cfg: { holdoutFraction: number }): { policyVersion: string; thresholds; metrics; minWarmupBars; minTrades; fraction }` — `fraction = cfg.holdoutFraction` (the SAME E4a config field, NOT a hardcoded 0.2); `thresholds = DEFAULT_THRESHOLDS`; `metrics = ['sharpe','max_drawdown','win_rate','total_trades']`; `minWarmupBars = 1`; `minTrades = 1`; `policyVersion = sha256(canonicalJson({ fraction, thresholds, minWarmupBars, minTrades }))` — DERIVED so any policy change auto-bumps the epoch regime.
  - `export type PromotionPolicy = ReturnType<typeof buildPromotionPolicy>` (used by `WorkerDeps.promotion` in Task 8).
  - `interface PromotionDeps { enabled: boolean; ledger: PromotionAttemptLedger; epochResolver: QualificationEpochResolver; policy: PromotionPolicy }` (the run clock is passed per-call via `ctx.clock`).
  - `async function resolvePromotionGate(deps: PromotionDeps, claimed: JobRow, ctx): Promise<{ promotion: PromotionResult; evidenceRef?: ArtifactReference } | undefined>` — `undefined` ONLY for flag-off / non-promotion; for enabled+promotion it ALWAYS returns a `PromotionResult` (never undefined — an operational fault becomes a typed `not_qualified` reason, never confused with flag-off). `passed` is returned ⟺ the v2 artifact PERSISTED (resolvePromotionGate owns the write via `ctx.writeArtifact`, so `passed` always has an `evidenceRef`). `ctx = { candidate: CompletedOutcome; curated: CompletedOutcome | null; signingKey?: SigningKey; bundle; bundleBytes; engineRequest; datasetFingerprint: string; coverage: RunPeriod | null; runId; writeArtifact: (artifact) => Promise<string> }` (`curated:null` = missing `curatedBaselineRef` or a failed curated run; `coverage:null` = dataset coverage not found).

- [ ] **Step 1: Write the config failing test**

Create `apps/backtester/test/config-promotion.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
const ON = { BACKTESTER_PROMOTION_HOLDOUT_GATE: 'true', BACKTESTER_HOLDOUT_ENABLED: 'true', BACKTESTER_HOLDOUT_FRACTION: '0.2' };
describe('promotion-gate config (E4b)', () => {
  it('defaults off', () => { expect(loadConfig({} as NodeJS.ProcessEnv).promotionHoldoutGate).toBe(false); });
  it('enables only for exact "true" (with holdout enabled)', () => {
    expect(loadConfig(ON as NodeJS.ProcessEnv).promotionHoldoutGate).toBe(true);
    expect(loadConfig({ ...ON, BACKTESTER_PROMOTION_HOLDOUT_GATE: '1' } as NodeJS.ProcessEnv).promotionHoldoutGate).toBe(false);
  });
  it('fail-fast: enabling the gate REQUIRES holdout enabled + a valid fraction', () => {
    expect(() => loadConfig({ BACKTESTER_PROMOTION_HOLDOUT_GATE: 'true' } as NodeJS.ProcessEnv)).toThrow(/holdout/i);
    expect(() => loadConfig({ BACKTESTER_PROMOTION_HOLDOUT_GATE: 'true', BACKTESTER_HOLDOUT_ENABLED: 'true' } as NodeJS.ProcessEnv)).toThrow(/fraction|holdout/i);
  });
});
```

- [ ] **Step 2: Config RED → GREEN**

Run: `npx vitest run apps/backtester/test/config-promotion.test.ts` (RED). Add to `AppConfig` (after the walkForward fields) `readonly promotionHoldoutGate: boolean;`. In `loadConfig`, compute `const promotionHoldoutGate = env.BACKTESTER_PROMOTION_HOLDOUT_GATE === 'true';` and **fail-fast BEFORE returning** (so E4b never runs with a mismatched holdout policy — the promotion window MUST be the SAME window E4a's config produces):

```ts
  if (promotionHoldoutGate) {
    if (env.BACKTESTER_HOLDOUT_ENABLED !== 'true') {
      throw new Error('BACKTESTER_PROMOTION_HOLDOUT_GATE requires BACKTESTER_HOLDOUT_ENABLED=true (the gate reuses the E4a holdout policy)');
    }
    const f = Number(env.BACKTESTER_HOLDOUT_FRACTION);
    if (!Number.isFinite(f) || f <= 0 || f >= 1) {
      throw new Error('BACKTESTER_PROMOTION_HOLDOUT_GATE requires a valid BACKTESTER_HOLDOUT_FRACTION in (0,1)');
    }
  }
```

(The existing E4a holdout fail-fast already validates the fraction when `BACKTESTER_HOLDOUT_ENABLED`; this adds the cross-requirement.) Add `promotionHoldoutGate,` to the returned object. Add `promotionHoldoutGate: false,` to `apps/backtester/test/helpers.ts`. Run again (GREEN) + `npx tsc --noEmit -p tsconfig.json`.

- [ ] **Step 3: Write the orchestrator failing test**

Create `apps/backtester/test/resolve-promotion.test.ts` — drive `resolvePromotionGate` with injected candidate/curated outcomes, an in-memory ledger, and a stub resolver (no Docker/DB). Contract to assert:

```ts
// flag OFF or mode!=='promotion' ⇒ undefined (the ONLY undefined cases).
// enabled+promotion ALWAYS returns { promotion } (never undefined). Specifically:
// no signing key ⇒ verdict='not_qualified', reason='signing_unavailable', no evidenceRef.
// curated === null ⇒ reason='curated_unavailable'.
// integrity reject (twin_divergent via a divergent candidate) ⇒ that reason, NO ledger write (spy untouched).
// resolver→null OR coverage===null ⇒ reason='holdout_unavailable'.
// window reject (window not covered by runPeriod) ⇒ 'holdout_not_covered', evaluationWindow set, NO ledger write.
// evaluated verdict 'failed' ⇒ ledger RECORDED (spy called; row verdict 'failed'), reason='metrics_failed', attemptNumber set, no evidenceRef.
// evaluated verdict 'passed' ⇒ ledger recorded, ctx.writeArtifact CALLED, verdict='passed', evidenceRef present (artifactType 'backtest-evidence/v2'), attemptNumber+evaluationWindow set.
// ledger.recordIfNewAndGetAttempt throws ⇒ reason='attempt_record_failed', no evidenceRef.
// ctx.writeArtifact throws (persist fails) ⇒ reason='internal_error', NOT passed, no evidenceRef.
```

(Build concrete fixtures from Task 5's outcomes; `deps.ledger` = `InMemoryPromotionAttemptLedger` with a `vi.spyOn` to assert recorded-or-not; `deps.epochResolver` = a fake returning `{epochId:'e'}` or null; `deps.policy = buildPromotionPolicy({ holdoutFraction: 0.4 })`; `ctx.writeArtifact = vi.fn(async () => 'sha256:art')`; use a real Ed25519 `SigningKey` fixture as the repo's evidence tests do, or a stub key whose `signEvidence` path is exercised. Assert `passed ⟺ evidenceRef present ⟺ writeArtifact called`.)

- [ ] **Step 4: Run to verify it fails**

Run: `npx vitest run apps/backtester/test/resolve-promotion.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 5: Implement the orchestrator**

Create `apps/backtester/src/jobs/promotion/resolve-promotion.ts` with `buildPromotionPolicy` and
`resolvePromotionGate`. The canonical order is `signing → curated → integrity → resolve(holdout) →
window → (verdict) → record → metrics_failed / sign(persist)`, and the enabled+promotion path ALWAYS
returns a `PromotionResult` (`nq(reason, extra?)` helper builds the `not_qualified` arm; `passed` only
after the artifact persists):

```ts
export function buildPromotionPolicy(cfg: { holdoutFraction: number }) {
  const thresholds = DEFAULT_THRESHOLDS;
  const metrics = ['sharpe', 'max_drawdown', 'win_rate', 'total_trades'] as const;
  const minWarmupBars = 1, minTrades = 1, fraction = cfg.holdoutFraction;
  const policyVersion = sha256Hex(canonicalJson({ fraction, thresholds, minWarmupBars, minTrades }));
  return { policyVersion, thresholds, metrics: [...metrics], minWarmupBars, minTrades, fraction };
}

export async function resolvePromotionGate(deps, claimed, ctx) {
  if (!deps.enabled || claimed.request.mode !== 'promotion') return undefined;
  const nq = (reason, extra = {}) => ({ promotion: { verdict: 'not_qualified', reason, evaluatedOn: 'holdout', ...extra } });
  try {
    if (!ctx.signingKey) return nq('signing_unavailable');
    if (ctx.curated === null) return nq('curated_unavailable');           // missing curatedBaselineRef or failed curated run
    const integrity = evaluatePromotionIntegrity({ candidate: ctx.candidate, curated: ctx.curated,
      bundleGateRejected: bundleRejected(ctx.bundle) });                   // validateBundle acceptance
    if (integrity.outcome === 'reject') return nq(integrity.reason);
    const epoch = await deps.epochResolver.resolve(claimed);
    if (!epoch || ctx.coverage === null) return nq('holdout_unavailable');
    let window;
    try { window = computeHoldoutWindow(ctx.coverage, deps.policy.fraction); }
    catch { return nq('holdout_unavailable'); }                            // HoldoutConfigError
    const w = evaluatePromotionWindow({ candidate: ctx.candidate, curated: ctx.curated, holdoutWindow: window,
      runPeriod: claimed.request.period, thresholds: deps.policy.thresholds, policyMetrics: deps.policy.metrics,
      minWarmupBars: deps.policy.minWarmupBars, minTrades: deps.policy.minTrades });
    if (w.outcome === 'reject') return nq(w.reason, { evaluationWindow: window }); // NO ledger write on a reject
    // verdict-before-ledger: record REGARDLESS of pass/fail (counter advances for failed too)
    const epochKey = computeQualificationEpochKey(computePromotionFamilyKey(claimed.request), epoch.epochId, deps.policy.policyVersion);
    const attemptIdentity = computeAttemptIdentity(claimed.requestFingerprint, ctx.datasetFingerprint);
    let rec;
    try {
      rec = await deps.ledger.recordIfNewAndGetAttempt({ qualificationEpochKey: epochKey, attemptIdentity,
        requestFingerprint: claimed.requestFingerprint, datasetFingerprint: ctx.datasetFingerprint,
        runId: ctx.runId, resultHash: contentRef(ctx.candidate), verdict: w.verdict, createdAtMs: ctx.clock() });
    } catch { return nq('attempt_record_failed', { evaluationWindow: window }); }
    if (w.verdict === 'failed') return nq('metrics_failed', { attemptNumber: rec.attemptNumber, evaluationWindow: window });
    // passed → sign v2 + PERSIST; passed is returned ONLY if the artifact actually saved
    try {
      const body = buildEvidenceBodyV2({ backtesterRunId: ctx.runId, bundleHash: sha256BundleRef(ctx.bundleBytes),
        keyId: ctx.signingKey.keyId, datasetRef: claimed.request.datasetRef, executionWindow: periodToMs(claimed.request.period),
        symbols: claimed.request.symbols, timeframe: claimed.request.timeframe, evaluationWindow: periodToMs(window),
        candidateHoldoutMetrics: w.candidateHoldoutMetrics, curatedHoldoutMetrics: w.curatedHoldoutMetrics,
        thresholds: deps.policy.thresholds, attemptNumber: rec.attemptNumber, qualificationEpochKey: epochKey,
        candidateResultHash: contentRef(ctx.candidate), curatedResultHash: contentRef(ctx.curated),
        curatedBaselineRef: claimed.request.curatedBaselineRef, qualification: { coverage: ctx.coverage,
          fraction: deps.policy.fraction, policyVersion: deps.policy.policyVersion, datasetFingerprint: ctx.datasetFingerprint } });
      const artifact = signEvidence(body, ctx.signingKey.privateKey);
      const artifactId = await ctx.writeArtifact(artifact);
      return { promotion: { verdict: 'passed', attemptNumber: rec.attemptNumber, evaluationWindow: window, evaluatedOn: 'holdout' },
        evidenceRef: { artifactId, artifactType: 'backtest-evidence/v2', availability: 'available' } };
    } catch {
      return nq('internal_error', { attemptNumber: rec.attemptNumber, evaluationWindow: window }); // sign/persist failed → NOT passed
    }
  } catch {
    return nq('internal_error');  // any unexpected fault: enabled+promotion NEVER returns undefined
  }
}
```

Fill in the small helpers: `bundleRejected(bundle)` = `validateBundle(bundle, platformContractContext([bundle.manifest.id])).status === 'rejected'` (mirror `produceStrategyEvidence` step 1); `periodToMs(p)` = `{ fromMs: Date.parse(p.from), toMs: Date.parse(p.to) }`. Import `sha256Hex`/`canonicalJson`/`contentRef`/`computeHoldoutWindow`/`signEvidence`/`sha256BundleRef` + the Task-3/5/6 helpers from their real modules. The run clock is `ctx.clock` (`() => number`).

- [ ] **Step 6: Run orchestrator test to verify it passes**

Run: `pnpm sdk:build && npx vitest run apps/backtester/test/resolve-promotion.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS + tsc clean.

- [ ] **Step 7: Commit**

```bash
git add apps/backtester/src/config.ts apps/backtester/test/helpers.ts apps/backtester/src/jobs/promotion/resolve-promotion.ts apps/backtester/test/config-promotion.test.ts apps/backtester/test/resolve-promotion.test.ts
git commit -m "feat(research): E4b — promotion gate orchestrator + config flag"
```

---

### Task 8: Worker wiring + determinism gate

**Files:**
- Modify: `apps/backtester/src/jobs/worker.ts` (strategy-evidence block ~864-898: call `resolvePromotionGate` for promotion, write v2 artifact, thread `promotion` to `finalizeResult`; add `promotion` param to `finalizeResult` + merge post-hash ~after the novelty block); `WorkerDeps` (+ `promotion?` deps)
- Modify: `apps/backtester/src/app.ts` (construct the ledger + resolver + deps from config)
- Test: `apps/backtester/test/promotion-wiring.test.ts` + full-suite determinism gate

**Interfaces:**
- Consumes: `resolvePromotionGate` (Task 7).
- Produces: `WorkerDeps.promotion?: { enabled; ledger; epochResolver }`; `finalizeResult(..., promotion?: PromotionResult)` merges `promotion` onto the summary post-hash.

- [ ] **Step 1: Write the wiring failing test**

Create `apps/backtester/test/promotion-wiring.test.ts`: drive a `mode:'promotion'` strategy run through the worker (or a focused harness around the strategy-evidence block) with the flag ON and injected candidate/curated + in-memory ledger + stub resolver (spy `resolvePromotionGate` via a `workerInternals` seam, mirroring E3b's pattern). Assert: flag OFF ⇒ no `promotion` field + existing v1 evidence behavior; flag ON + promotion + qualified ⇒ `summary.promotion.verdict='passed'` + a v2 `evidenceRef` (artifactType `'backtest-evidence/v2'`); flag ON + promotion + not-covered ⇒ `summary.promotion.verdict='not_qualified'`, reason `'holdout_not_covered'`, NO evidenceRef; non-promotion mode ⇒ unchanged. (Model the harness on the closest existing strategy-evidence / worker end-to-end test.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run apps/backtester/test/promotion-wiring.test.ts`
Expected: FAIL.

- [ ] **Step 3: Wire the worker**

In `apps/backtester/src/jobs/worker.ts` (line numbers are post-#123; the strategy-evidence block is the `if (claimed.request.curatedBaselineRef !== undefined && deps.evidenceSigningKey !== undefined)` at ~L867, `finalizeResult(deps,'strategy',…)` at ~L904 — grep to confirm):
- Add `promotion?: { enabled: boolean; ledger: PromotionAttemptLedger; epochResolver: QualificationEpochResolver; policy: PromotionPolicy }` to `WorkerDeps` after `walkForward?`; add `PromotionResult` to the SDK-contracts import group; import `resolvePromotionGate` (expose via `workerInternals` for the test seam).
- **Promotion runs on ALL enabled `mode:'promotion'` strategy runs, OUTSIDE the v1 `if(curatedBaselineRef && signingKey)` block** (so a promotion run missing curated/key still emits a `not_qualified` verdict, not nothing). Add, in the strategy branch after `outcome` is produced:
  ```ts
  let promotionResult: PromotionResult | undefined;
  if (deps.promotion?.enabled && claimed.request.mode === 'promotion') {
    // run curated iff a baseline ref is present; else curated:null → curated_unavailable
    let curated: CompletedOutcome | null = null;
    if (claimed.request.curatedBaselineRef !== undefined) {
      try {
        const c = await runOverlayBacktest({ ...engineRequest, moduleRef: claimed.request.curatedBaselineRef }, { registry: buildTrustedRegistry(), marketTape });
        curated = c.status === 'completed' ? c : null;
      } catch { curated = null; }
    }
    const bundleBytes = claimed.request.curatedBaselineRef !== undefined && sandboxBundle ? readFileSync(join(sandboxBundle.bundle.bundleDir, sandboxBundle.bundle.descriptor.entryPoint)) : new Uint8Array();
    const coverage = (await deps.dataPort.listDatasets().catch(() => [])).find((d) => d.datasetRef === claimed.datasetRef)?.period ?? null;
    try {
      const pr = await workerInternals.resolvePromotionGate(deps.promotion, claimed, {
        candidate: outcome, curated, signingKey: deps.evidenceSigningKey, bundle: sandboxBundle?.bundle,
        bundleBytes, engineRequest, datasetFingerprint: dsFingerprint, coverage, runId,
        writeArtifact: (a) => deps.artifactStore.write(a), clock: deps.clock,
      });
      promotionResult = pr?.promotion;
      if (pr?.evidenceRef) evidenceRef = pr.evidenceRef;   // v2 evidenceRef (artifactType 'backtest-evidence/v2')
    } catch {
      // resolvePromotionGate is internally fault-tolerant, but belt-and-suspenders: a fault must yield a
      // typed verdict, NEVER a missing field (which would look like flag-off). Never fails the run.
      promotionResult = { verdict: 'not_qualified', reason: 'internal_error', evaluatedOn: 'holdout' };
    }
  }
  ```
  For a `mode:'promotion'`-gated run, SKIP the existing v1 `produceStrategyEvidence` block (it signs a v1 body on full-period metrics — the promotion path replaces it with v2). Guard the v1 block with `&& !(deps.promotion?.enabled && claimed.request.mode === 'promotion')` so non-promotion runs keep the exact v1 path.
- Pass `promotionResult` to `finalizeResult` (new last optional param) and merge post-hash: `if (promotion) summary = { ...summary, promotion };` right after the novelty block (`if (novelty) summary = …`, ~L385), before the return.

- [ ] **Step 4: Wire `app.ts`**

Construct, gated on `config.promotionHoldoutGate`:
```ts
const promotionLedger = ownedPool ? new PgPromotionAttemptLedger(ownedPool) : new InMemoryPromotionAttemptLedger();
const promotionPolicy = buildPromotionPolicy({ holdoutFraction: config.holdoutFraction }); // SAME fraction as E4a
```
and spread into `workerDeps`:
```ts
...(config.promotionHoldoutGate
  ? { promotion: { enabled: true, ledger: promotionLedger, epochResolver: new DatasetIdentityEpochResolver(dataPort), policy: promotionPolicy } }
  : {}),
```
(`config.holdoutFraction` is guaranteed valid here — the Task-7 config fail-fast rejects enabling the gate without it.)

- [ ] **Step 5: Run wiring test + tsc**

Run: `pnpm sdk:build && npx vitest run apps/backtester/test/promotion-wiring.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS + tsc clean.

- [ ] **Step 6: Full-suite determinism gate**

Run: `npx vitest run`
Expected: fully green. Every prior golden `result_hash` byte-identical (flag OFF everywhere; `promotion` non-hashed; v1 evidence path untouched for non-promotion). If any golden moved, STOP — something leaked into the hashed payload or changed the non-promotion evidence path.

- [ ] **Step 7: Commit**

```bash
git add apps/backtester/src/jobs/worker.ts apps/backtester/src/app.ts apps/backtester/test/promotion-wiring.test.ts
git commit -m "feat(research): E4b — worker wiring for held-out promotion gate (advisory, flag OFF)"
```

---

## Self-Review

**Spec coverage:**
- Signature-gate / v2 / result_hash byte-identical → Tasks 1, 6, 8 (post-hash merge; flag-OFF gate). ✓
- Shared `evaluateWindow` extraction (E3b byte-identical) → Task 2. ✓
- Period-free family key + epoch key + attemptIdentity + trusted DatasetIdentity resolver → Task 3. ✓
- Atomic ledger — epoch-counter + **FOR UPDATE acquired BEFORE the replay-check** (P0-2 race fixed), dedupe `(epochKey, attemptIdentity=hash(fp,dsf))` incl. datasetFingerprint (backfill = new attempt), persisted number+verdict, **Pg `Promise.all` concurrency test for BOTH distinct {1..N} AND concurrent same-identity** + rollback/release → Task 4. ✓
- **Split canonical pipeline** (P0-3): `signing → curated → integrity(gate→twin) → resolve(holdout) → window(not_covered→warmup→eval) → verdict → record → metrics_failed/sign` — Task 5 (two pure fns: integrity + window) + Task 7 (orchestrator interleaves resolve BETWEEN them). Verdict-before-ledger; policy metrics; warmup = DISTINCT barTs (Set). ✓
- v2 flat body (v1 fields + held-out binding) + sign → Tasks 1 (type) + 6 (builder) + 7 (sign+persist). ✓
- **Discriminated union** `PromotionResult` (P1-4: passed⇒no reason+attemptNumber+window; not_qualified⇒reason) → Task 1. ✓
- **Never-vanish** (P1-5): enabled+promotion ALWAYS returns a `PromotionResult` (undefined only flag-off/non-promotion); operational faults → typed reason (`curated_unavailable`/`attempt_record_failed`/`internal_error`); `passed` ⟺ artifact persisted → Tasks 7 (orchestrator owns write) + 8 (catch → internal_error). ✓
- **Policy from E4a config** (P1-7): `fraction = config.holdoutFraction` (not hardcoded), `policyVersion` derived from the policy values, config fail-fast when the gate is enabled without holdout → Tasks 7 (buildPromotionPolicy + config fail-fast) + 8 (app wiring). ✓
- Config flag + worker wiring + determinism gate + never-fail-the-run → Tasks 7 + 8. ✓
- Rollout preconditions (platform v2 + requirePromotionEvidence + Outcome-Embargo) → operational, not code.

**Placeholder scan:** The Pg concurrency harness (Task 4), the orchestrator test (Task 7 Step 3), and the wiring test (Task 8 Step 1) give the exact assertion CONTRACT and name the nearest existing Pg-gated / strategy-evidence test to model on — every assertion spelled out. Task 7 Step 5's orchestrator body is explicit ordered code with every branch named. No TBD/TODO.

**Type consistency:** `CompletedOutcome`/`evaluateWindow` (Task 2) reused in Tasks 5, 7. `evaluatePromotionIntegrity`/`evaluatePromotionWindow` (Task 5) consumed by Task 7. `PromotionAttemptLedger`/`recordIfNewAndGetAttempt` (Task 4) consumed by Task 7. `EvidenceBodyV2`/`buildEvidenceBodyV2` (Tasks 1, 6) consumed by Task 7. `PromotionResult` discriminated union (Task 1) produced by Task 7, merged by Task 8. Identity helpers + `QualificationEpochResolver` (Task 3) consumed by Task 7. `buildPromotionPolicy` + `type PromotionPolicy = ReturnType<typeof buildPromotionPolicy>` (Task 7) used by `WorkerDeps.promotion` (Task 8) + `app.ts`. `promotionHoldoutGate` config (Task 7) → `app.ts` (Task 8).

**Note for the implementer:** the promotion path REPLACES the v1 `produceStrategyEvidence` call for a `mode:'promotion'` gated run (v2 evidence instead of v1) — it does not run both. Non-promotion (research/review) runs keep the exact v1 path. Confirm the strategy-evidence block branches cleanly on `mode==='promotion' && deps.promotion?.enabled`.
