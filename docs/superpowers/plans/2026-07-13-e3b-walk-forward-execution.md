# E3b Walk-Forward Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute each walk-forward fold's out-of-sample window as a backtest and attach an advisory, non-hashed `RunResultSummary.walkForward` OOS-stability summary — dark-launched behind a default-OFF flag, canonical run byte-identical.

**Architecture:** A pure orchestrator (`walk-forward-exec.ts`) splits the period (E3a `splitWalkForward`), runs each fold via an injected `runFold`, evaluates the TEST window post-hoc (boundary-anchored equity slice + fully-in-test trade filter + E1a `computeMetrics`), and reduces to a `resolved | partial | unavailable` status union. The worker builds the production `runFold` from the **already-built `engineRequest` (correct `effectiveSeed`, submit-only fields stripped) and the already-loaded outer `sandboxBundle`** — both created before the dedup gate, so they exist on the miss AND hit paths — and merges the result onto `finalized.summary` in `processNextQueued`, **after the result-cache is populated** and after `contentRef`, immediately before the terminal `store.transition('completed')`. So both paths get it, `result_hash` never changes, and a crash during folds still leaves the canonical result cached for the retry.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` specifiers), Vitest, pnpm workspace, `@trading-backtester/sdk` (built with `pnpm sdk:build`).

## Global Constraints

- **Determinism:** `result_hash = contentRef(payload)` is byte-identical with the flag OFF. `walkForward` lives ONLY on the non-hashed summary projection, merged AFTER `contentRef`. `decideVerdict` is NOT touched.
- **Advisory / fail-open:** a walk-forward fault NEVER fails the canonical run. The enabled path never throws and never returns `undefined` (unexpected error → `unavailable: internal_error`); `undefined` is returned ONLY for the gate (flag OFF / no scheme / momentum).
- **Flag default OFF:** `BACKTESTER_WALK_FORWARD_ENABLED`. All new SDK fields optional (`?`).
- **Fingerprint is config-independent AND byte-identical for absent-scheme requests:** `walkForward` is folded into the request fingerprint via a CONDITIONAL spread (present ⇒ included; absent ⇒ key omitted entirely, so a request without a scheme keeps its exact pre-E3b fingerprint). It is a pure function of the request, never gated on the flag. This mirrors how `curatedBaselineRef` is folded in `normalize()` (PR #119).
- **Continuous-state warmup:** each fold runs the engine over `[train.from, test.to]`; metrics are computed over the TEST window only, using an anchored equity slice (`[last point before test.from] ++ points in [test.from, test.to)`) and trades fully in-test (`entryTs >= test.from && exitTs < test.to`). Carry-in closed trades are excluded from ALL trade-based metrics and counted in `carryInClosedTradeCount`.
- **Normalized failure codes:** `WalkForwardFailureCode = 'validation_error' | 'missing_dataset' | 'sandbox_failure' | 'timeout' | 'runner_failure' | 'budget_exhausted'`.
- **ESM imports:** relative imports end in `.js` (except `config.ts` and `app.ts`, which use EXTENSIONLESS relative imports — match each file's own convention). SDK types import from `@trading-backtester/sdk/contracts`.
- **Run from the repo root** (worktree root, where `vitest.config.ts` lives). Single-file test: `npx vitest run <path>`. Full suite: `npx vitest run` (~8 min; `pretest` builds SDK + overlay harness). **SDK type changes require `pnpm sdk:build`** before `tsc`/tests resolve them.

---

### Task 1: SDK contract — `WalkForward` types + request/summary fields

**Files:**
- Modify: `packages/sdk/src/contracts/run.ts` (add types after the existing E3a `WalkForwardAggregate` at line ~43; add `walkForward?` to `BacktestRunRequest` ~line 121 and `RunResultSummary` after line 264)
- Test: `packages/sdk/test/contracts.test.ts`

**Interfaces:**
- Consumes (E3a, already present): `WalkForwardScheme`, `RunPeriod`, `WalkForwardAggregate { foldCount, metrics }`.
- Produces: `WalkForwardFailureCode`, `WalkForwardFailure`, `WalkForwardFoldResult`, `WalkForwardExecAggregate`, `WalkForward`; `BacktestRunRequest.walkForward?: WalkForwardScheme`; `RunResultSummary.walkForward?: WalkForward`.

- [ ] **Step 1: Write the failing test**

Add to `packages/sdk/test/contracts.test.ts`:

```ts
import type { WalkForward } from '../src/contracts/run.js';

it('WalkForward union carries resolved / partial / unavailable shapes', () => {
  const agg = {
    foldCount: 2, metrics: {}, requestedFoldCount: 3, completedFoldCount: 2, insufficientFolds: [],
  };
  const resolved: WalkForward = {
    status: 'partial',
    scheme: { folds: 3, mode: 'rolling' },
    folds: [{ index: 0, train: { from: 'a', to: 'b' }, test: { from: 'b', to: 'c' }, foldOutcomeHash: 'h', metrics: { sharpe: 1 }, carryInClosedTradeCount: 0 }],
    aggregate: agg,
    failedFolds: [{ index: 2, code: 'sandbox_failure' }],
  };
  const none: WalkForward = {
    status: 'unavailable', scheme: { folds: 3, mode: 'rolling' }, reason: 'all_folds_failed',
    failedFolds: [{ index: 0, code: 'runner_failure' }], insufficientFolds: [],
  };
  expect(resolved.status).toBe('partial');
  expect(none.status).toBe('unavailable');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/sdk/test/contracts.test.ts`
Expected: FAIL — `run.js` has no exported member `WalkForward`.

- [ ] **Step 3: Add the types**

In `packages/sdk/src/contracts/run.ts`, immediately after the `WalkForwardAggregate` interface (line ~43):

```ts
// E3b — walk-forward EXECUTION result (advisory; NOT part of the hashed result). Per-fold OOS metrics
// over each fold's test window (engine executed over [train.from, test.to] for continuous-state warmup).
export type WalkForwardFailureCode =
  | 'validation_error' | 'missing_dataset' | 'sandbox_failure' | 'timeout'
  | 'runner_failure' | 'budget_exhausted';
export interface WalkForwardFailure {
  readonly index: number;
  readonly code: WalkForwardFailureCode;
}
export interface WalkForwardFoldResult {
  readonly index: number;
  readonly train: RunPeriod;
  readonly test: RunPeriod;
  readonly foldOutcomeHash: string;
  readonly metrics: Record<string, number>;
  readonly carryInClosedTradeCount: number;
}
export interface WalkForwardExecAggregate extends WalkForwardAggregate {
  readonly requestedFoldCount: number;
  readonly completedFoldCount: number;
  readonly insufficientFolds: readonly number[];
}
export type WalkForward =
  | {
      readonly status: 'resolved' | 'partial';
      readonly scheme: WalkForwardScheme;
      readonly folds: readonly WalkForwardFoldResult[];
      readonly aggregate: WalkForwardExecAggregate;
      readonly failedFolds: readonly WalkForwardFailure[];
    }
  | {
      readonly status: 'unavailable';
      readonly scheme: WalkForwardScheme;
      readonly reason: 'split_error' | 'all_folds_failed' | 'folds_exceeds_max' | 'insufficient_folds' | 'internal_error';
      readonly failedFolds: readonly WalkForwardFailure[];
      readonly insufficientFolds: readonly number[];
    };
```

Add to `BacktestRunRequest` (after `trialFamilyHint?`):

```ts
  /** E3b: per-request walk-forward scheme. Part of the request fingerprint; executed only when the flag is ON. */
  readonly walkForward?: WalkForwardScheme;
```

Add to `RunResultSummary` (after the `novelty?` field, line ~264):

```ts
  /** E3b: advisory per-fold walk-forward OOS-stability summary; NOT covered by `resultHash`. */
  readonly walkForward?: WalkForward;
```

- [ ] **Step 4: Build SDK + run test**

Run: `pnpm sdk:build && npx vitest run packages/sdk/test/contracts.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/contracts/run.ts packages/sdk/test/contracts.test.ts
git commit -m "feat(sdk): E3b — WalkForward execution contract + request/summary fields"
```

---

### Task 2: Request fingerprint — fold scheme is run-affecting

**Files:**
- Modify: `apps/backtester/src/jobs/fingerprint.ts` (the `normalize()` whitelist, lines 14-32)
- Test: `apps/backtester/test/fingerprint-walkforward.test.ts`

**Interfaces:**
- Produces: `normalize()` now folds `walkForward` into the hashed object, so `requestFingerprint` / `storedRequestFingerprint` include it. Config-independent.

- [ ] **Step 1: Write the failing test**

Create `apps/backtester/test/fingerprint-walkforward.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { RunSubmitRequest } from '@trading-backtester/sdk/contracts';
import { requestFingerprint } from '../src/jobs/fingerprint.js';

const base = {
  mode: 'research', moduleRef: { id: 'm', version: '1' }, datasetRef: 'ds', symbols: ['BTCUSDT'],
  timeframe: '1m', period: { from: '2023-01-01T00:00:00.000Z', to: '2023-01-02T00:00:00.000Z' },
  seed: 1, metrics: ['sharpe'],
} as unknown as RunSubmitRequest;

describe('requestFingerprint — walkForward is run-affecting but absent-safe', () => {
  it('an absent scheme keeps a byte-identical fingerprint (golden pin)', () => {
    // BASELINE: run `requestFingerprint(base)` on the CURRENT code BEFORE adding walkForward to
    // normalize(), copy the printed hash here. After the change this MUST stay equal (conditional
    // spread ⇒ absent key ⇒ unchanged canonical JSON). Fill GOLDEN from the pre-change run.
    const GOLDEN = '<paste the pre-change requestFingerprint(base) here>';
    expect(requestFingerprint({ ...base } as RunSubmitRequest)).toBe(GOLDEN);
  });
  it('differs when only the walkForward scheme differs', () => {
    const a = requestFingerprint({ ...base, walkForward: { folds: 3, mode: 'rolling' } } as RunSubmitRequest);
    const b = requestFingerprint({ ...base, walkForward: { folds: 5, mode: 'rolling' } } as RunSubmitRequest);
    expect(a).not.toBe(b);
  });
  it('an absent scheme equals an explicit-undefined scheme', () => {
    expect(requestFingerprint({ ...base } as RunSubmitRequest))
      .toBe(requestFingerprint({ ...base, walkForward: undefined } as RunSubmitRequest));
  });
});
```

**To capture GOLDEN:** before editing `normalize()`, add a throwaway `console.log(requestFingerprint(base))` (or run the golden-pin test once and read the "expected" from the failure), paste the value, remove the log. The pin then guards byte-identity across the change.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/backtester/test/fingerprint-walkforward.test.ts`
Expected: FAIL — the two schemes hash equal (walkForward not in `normalize()`).

- [ ] **Step 3: Implement**

In `apps/backtester/src/jobs/fingerprint.ts`, add a CONDITIONAL spread to the `normalize()` return object, right after the existing `curatedBaselineRef` conditional spread — NOT a plain `?? null` (that would add a key to every request and change all fingerprints):

```ts
    ...(req.walkForward !== undefined ? { walkForward: req.walkForward } : {}),
```

- [ ] **Step 4: Run test**

Run: `npx vitest run apps/backtester/test/fingerprint-walkforward.test.ts`
Expected: PASS (different schemes differ; absent stays null → equal)

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/jobs/fingerprint.ts apps/backtester/test/fingerprint-walkforward.test.ts
git commit -m "feat(research): E3b — fold scheme is run-affecting (in request fingerprint)"
```

---

### Task 3: Submit-time structural validation → HTTP 400

**Files:**
- Modify: `apps/backtester/src/jobs/submit.ts` (inside `validate(req)`, after the seed check ~line 166)
- Test: `apps/backtester/test/submit-validate.test.ts` (existing file — extend)

**Interfaces:**
- Consumes: `SubmitError(status, category, message)` (submit.ts:13-19); `validate(req)` throws it with `400, 'validation_error'`.

- [ ] **Step 1: Write the failing test**

Add to `apps/backtester/test/submit-validate.test.ts` (reuse its existing valid-body helper; if none, construct a minimal valid `RunSubmitRequest`). Call the same entry the file already uses to trigger `validate` (e.g. `submitRun(deps, body)` or `validate(body)` — match the file's existing pattern):

```ts
it('rejects a walkForward with folds < 1 (400)', async () => {
  await expect(submitBad({ walkForward: { folds: 0, mode: 'rolling' } }))
    .rejects.toMatchObject({ status: 400, category: 'validation_error' });
});
it('rejects a non-integer folds (400)', async () => {
  await expect(submitBad({ walkForward: { folds: 2.5, mode: 'rolling' } }))
    .rejects.toMatchObject({ status: 400 });
});
it('rejects an unknown walkForward mode (400)', async () => {
  await expect(submitBad({ walkForward: { folds: 2, mode: 'bogus' } }))
    .rejects.toMatchObject({ status: 400 });
});
// Arbitrary inbound JSON — walkForward is `unknown` at runtime; the object guard must run FIRST so a
// non-object never dereferences `.folds`.
it('rejects walkForward: null (400, not a crash)', async () => {
  await expect(submitBad({ walkForward: null })).rejects.toMatchObject({ status: 400 });
});
it('rejects walkForward as a string (400)', async () => {
  await expect(submitBad({ walkForward: 'nope' })).rejects.toMatchObject({ status: 400 });
});
it('rejects walkForward as an array (400)', async () => {
  await expect(submitBad({ walkForward: [1, 2] })).rejects.toMatchObject({ status: 400 });
});
it('accepts a valid walkForward scheme', async () => {
  await expect(submitOk({ walkForward: { folds: 3, mode: 'expanding' } })).resolves.toBeDefined();
});
```

(`submitBad`/`submitOk` are thin wrappers over the file's existing submit-invocation helper with the field merged into an otherwise-valid body — model them on the tests already present in this file. `submitBad` passes a raw object cast to the request type so runtime-invalid values reach `validate`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/backtester/test/submit-validate.test.ts`
Expected: FAIL — invalid schemes are accepted (no validation).

- [ ] **Step 3: Implement**

In `apps/backtester/src/jobs/submit.ts`, inside `validate(req)` after the seed check (~line 158; NOTE `VALID_MODES` there is the RUN mode `research|review|promotion`, unrelated to the walk-forward `mode`), add. Treat `walkForward` as `unknown` — the object guard MUST run before any field access:

```ts
  if (req.walkForward !== undefined) {
    const wf = req.walkForward as unknown;
    if (typeof wf !== 'object' || wf === null || Array.isArray(wf)) {
      throw new SubmitError(400, 'validation_error', 'walkForward must be an object { folds, mode }');
    }
    const { folds, mode } = wf as { folds?: unknown; mode?: unknown };
    if (!Number.isSafeInteger(folds) || (folds as number) < 1) {
      throw new SubmitError(400, 'validation_error', 'walkForward.folds must be an integer >= 1');
    }
    if (mode !== 'rolling' && mode !== 'expanding') {
      throw new SubmitError(400, 'validation_error', "walkForward.mode must be 'rolling' or 'expanding'");
    }
  }
```

- [ ] **Step 4: Run test**

Run: `npx vitest run apps/backtester/test/submit-validate.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/jobs/submit.ts apps/backtester/test/submit-validate.test.ts
git commit -m "feat(research): E3b — submit-time walkForward shape validation (400)"
```

---

### Task 4: Config — flag + max-folds

**Files:**
- Modify: `apps/backtester/src/config.ts` (AppConfig fields + loadConfig, after the novelty fields); `apps/backtester/test/helpers.ts` (config literal)
- Test: `apps/backtester/test/config-walkforward.test.ts`

**Interfaces:**
- Produces: `AppConfig += walkForward: boolean; walkForwardMaxFolds: number`.

- [ ] **Step 1: Write the failing test**

Create `apps/backtester/test/config-walkforward.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('walk-forward config (E3b)', () => {
  it('defaults off with maxFolds 20', () => {
    const cfg = loadConfig({} as NodeJS.ProcessEnv);
    expect(cfg.walkForward).toBe(false);
    expect(cfg.walkForwardMaxFolds).toBe(20);
  });
  it('enables only for exact "true" and parses a safe-int max', () => {
    const cfg = loadConfig({ BACKTESTER_WALK_FORWARD_ENABLED: 'true', BACKTESTER_WALK_FORWARD_MAX_FOLDS: '8' } as NodeJS.ProcessEnv);
    expect(cfg.walkForward).toBe(true);
    expect(cfg.walkForwardMaxFolds).toBe(8);
  });
  it('falls back to 20 on a non-integer / <1 max', () => {
    expect(loadConfig({ BACKTESTER_WALK_FORWARD_MAX_FOLDS: '2.5' } as NodeJS.ProcessEnv).walkForwardMaxFolds).toBe(20);
    expect(loadConfig({ BACKTESTER_WALK_FORWARD_MAX_FOLDS: '0' } as NodeJS.ProcessEnv).walkForwardMaxFolds).toBe(20);
    expect(loadConfig({ BACKTESTER_WALK_FORWARD_MAX_FOLDS: 'abc' } as NodeJS.ProcessEnv).walkForwardMaxFolds).toBe(20);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/backtester/test/config-walkforward.test.ts`
Expected: FAIL — `cfg.walkForward` undefined.

- [ ] **Step 3: Implement config**

In `apps/backtester/src/config.ts`, add to `AppConfig` (after the novelty fields):

```ts
  /** E3b: walk-forward per-fold execution enabled. Default off (dark launch). */
  readonly walkForward: boolean;
  /** E3b: policy cap on fold count (safe integer >= 1). Default 20. */
  readonly walkForwardMaxFolds: number;
```

Add to the returned object in `loadConfig` (after the novelty fields):

```ts
    walkForward: env.BACKTESTER_WALK_FORWARD_ENABLED === 'true',
    walkForwardMaxFolds: (() => {
      const n = Number(env.BACKTESTER_WALK_FORWARD_MAX_FOLDS);
      return Number.isSafeInteger(n) && n >= 1 ? n : 20;
    })(),
```

- [ ] **Step 4: Update the test config literal**

In `apps/backtester/test/helpers.ts`, after the novelty fields:

```ts
    walkForward: false,
    walkForwardMaxFolds: 20,
```

- [ ] **Step 5: Run test**

Run: `npx vitest run apps/backtester/test/config-walkforward.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/backtester/src/config.ts apps/backtester/test/helpers.ts apps/backtester/test/config-walkforward.test.ts
git commit -m "feat(research): E3b — config flag + max-folds"
```

---

### Task 5: Pure orchestrator — `src/engine/walk-forward-exec.ts`

**Files:**
- Create: `apps/backtester/src/engine/walk-forward-exec.ts`
- Test: `apps/backtester/test/walk-forward-exec.test.ts`

**Interfaces:**
- Consumes: `splitWalkForward`, `aggregateFolds`, `WalkForwardConfigError` from `./walk-forward.js`; `computeMetrics` from `./metrics.js`; `EquityPoint`, `Trade`, `RunOutcome` from `./artifacts.js`; SDK `WalkForward`, `WalkForwardScheme`, `FoldWindow`, `RunPeriod`, `WalkForwardFailureCode`.
- Produces:
  - `class WalkForwardFoldError extends Error { code: WalkForwardFailureCode }`
  - `type CompletedOutcome = Extract<RunOutcome, { status: 'completed' }>`
  - `type RunFold = (fold: FoldWindow) => Promise<{ outcome: CompletedOutcome; hash: string }>`
  - `interface WalkForwardExecInput { scheme, period, requestedMetrics, maxFolds, deadlineExceeded }`
  - `function runWalkForward(input: WalkForwardExecInput, runFold: RunFold): Promise<WalkForward>`

- [ ] **Step 1: Write the failing test**

Create `apps/backtester/test/walk-forward-exec.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { EquityPoint, Trade } from '../src/engine/artifacts.js';
import {
  runWalkForward, WalkForwardFoldError, type CompletedOutcome, type RunFold,
} from '../src/engine/walk-forward-exec.js';

const DAY = 86_400_000;
// A 4-day period → folds partition it. Fixture outcomes are built to land inside each fold's test window.
const PERIOD = { from: new Date(0).toISOString(), to: new Date(4 * DAY).toISOString() };

function outcome(equity: EquityPoint[], trades: Trade[]): CompletedOutcome {
  return { status: 'completed', baseline: { trades, evidence: { equityCurve: equity } } } as unknown as CompletedOutcome;
}
function pt(dayFrac: number, equity: number): EquityPoint {
  return { barIndex: Math.round(dayFrac * 24), barTs: Math.round(dayFrac * DAY), equity };
}
function trade(entryDay: number, exitDay: number, pnl: number): Trade {
  return {
    id: `t${entryDay}`, symbol: 'BTCUSDT', side: 'long',
    entryBarIndex: 0, entryTs: entryDay * DAY, entryFillPrice: 100,
    exitBarIndex: 1, exitTs: exitDay * DAY, exitFillPrice: 100 + pnl,
    size: 1, feePaid: 0, realizedPnl: pnl, closeReason: 'end_of_data',
  } as Trade;
}
const input = (over = {}) => ({
  scheme: { folds: 2, mode: 'rolling' as const }, period: PERIOD,
  requestedMetrics: ['returns_count'], maxFolds: 20, deadlineExceeded: () => false, ...over,
});
// An outcome rich enough that every fold's test slice has >= 2 anchored points.
const richOutcome = outcome(
  [pt(0.5, 100), pt(1.5, 110), pt(2.5, 120), pt(3.5, 130)],
  [trade(1.2, 1.8, 5)],
);
const okRunFold: RunFold = async () => ({ outcome: richOutcome, hash: 'h' });

describe('runWalkForward', () => {
  it('all folds complete ⇒ resolved with matching counts', async () => {
    const wf = await runWalkForward(input(), okRunFold);
    expect(wf.status).toBe('resolved');
    if (wf.status === 'resolved') {
      expect(wf.folds.length).toBe(2);
      expect(wf.aggregate.requestedFoldCount).toBe(2);
      expect(wf.aggregate.completedFoldCount).toBe(2);
      expect(wf.failedFolds).toEqual([]);
    }
  });
  it('one fold throws a coded error ⇒ partial + normalized code', async () => {
    let n = 0;
    const rf: RunFold = async () => { if (n++ === 0) throw new WalkForwardFoldError('sandbox_failure', 'boom'); return { outcome: richOutcome, hash: 'h' }; };
    const wf = await runWalkForward(input(), rf);
    expect(wf.status).toBe('partial');
    if (wf.status !== 'unavailable') expect(wf.failedFolds).toEqual([{ index: 0, code: 'sandbox_failure' }]);
  });
  it('an un-coded throw maps to runner_failure', async () => {
    const rf: RunFold = async () => { throw new Error('plain'); };
    const wf = await runWalkForward(input(), rf);
    expect(wf.status).toBe('unavailable');
    if (wf.status === 'unavailable') {
      expect(wf.reason).toBe('all_folds_failed');
      expect(wf.failedFolds.every((f) => f.code === 'runner_failure')).toBe(true);
    }
  });
  it('folds > maxFolds ⇒ unavailable folds_exceeds_max (empty arrays)', async () => {
    const wf = await runWalkForward(input({ maxFolds: 1 }), okRunFold);
    expect(wf).toMatchObject({ status: 'unavailable', reason: 'folds_exceeds_max', failedFolds: [], insufficientFolds: [] });
  });
  it('a fold whose anchored test slice has <2 points ⇒ insufficientFolds, excluded', async () => {
    const thin = outcome([pt(3.9, 100)], []); // one point, no anchor before an early test window
    const wf = await runWalkForward(input(), async () => ({ outcome: thin, hash: 'h' }));
    expect(wf.status).toBe('unavailable');
    if (wf.status === 'unavailable') expect(wf.reason).toBe('insufficient_folds');
  });
  it('deadline flips true after fold 0 ⇒ remaining folds budget_exhausted, partial', async () => {
    let calls = 0;
    const wf = await runWalkForward(input({ deadlineExceeded: () => calls > 0 }), async () => { calls++; return { outcome: richOutcome, hash: 'h' }; });
    expect(wf.status).toBe('partial');
    if (wf.status !== 'unavailable') expect(wf.failedFolds).toEqual([{ index: 1, code: 'budget_exhausted' }]);
  });
  it('split error (bad scheme) ⇒ unavailable split_error', async () => {
    const wf = await runWalkForward(input({ scheme: { folds: 0, mode: 'rolling' } }), okRunFold);
    // maxFolds check passes (0 <= 20); splitWalkForward throws on folds < 1
    expect(wf).toMatchObject({ status: 'unavailable', reason: 'split_error' });
  });
});

describe('runWalkForward — test-window evaluation', () => {
  it('excludes carry-in trades from trade metrics but counts them', async () => {
    // test window of fold 0 (rolling, 2 folds over 4 days): boundaries at 0,1.33,2.67,4 →
    // fold0 test ≈ [1.33d, 2.67d). Carry-in trade enters at 1.0d (train), exits 2.0d (in test).
    const carry = outcome(
      [pt(1.0, 100), pt(1.5, 105), pt(2.0, 108), pt(2.5, 112)],
      [trade(1.0, 2.0, 8)], // entryTs before test.from ⇒ carry-in, excluded from trade metrics
    );
    const wf = await runWalkForward(input({ requestedMetrics: ['total_trades'] }), async () => ({ outcome: carry, hash: 'h' }));
    if (wf.status !== 'unavailable') {
      const f0 = wf.folds.find((f) => f.index === 0)!;
      expect(f0.carryInClosedTradeCount).toBe(1);
      expect(f0.metrics.total_trades).toBe(0); // the carry-in trade is not an in-test trade
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/backtester/test/walk-forward-exec.test.ts`
Expected: FAIL — module `../src/engine/walk-forward-exec.js` not found.

- [ ] **Step 3: Write the implementation**

Create `apps/backtester/src/engine/walk-forward-exec.ts`:

```ts
// E3b — pure walk-forward execution orchestrator. Splits the period (E3a), runs each fold via an
// injected runFold over [train.from, test.to], evaluates the TEST window post-hoc (anchored equity
// slice + fully-in-test trades + E1a computeMetrics), and reduces to a resolved|partial|unavailable
// status union. No I/O; runFold is the only side-effecting seam and it is injected. Advisory: the
// result rides the summary projection only, never fails the canonical run.

import type {
  RunPeriod, WalkForward, WalkForwardFailure, WalkForwardFailureCode, WalkForwardFoldResult,
  WalkForwardScheme, FoldWindow,
} from '@trading-backtester/sdk/contracts';
import type { EquityPoint, RunOutcome, Trade } from './artifacts.js';
import { computeMetrics } from './metrics.js';
import { aggregateFolds, splitWalkForward } from './walk-forward.js';

export type CompletedOutcome = Extract<RunOutcome, { status: 'completed' }>;

/** A fold execution failed with a classified reason. runFold throws this; an un-coded throw ⇒ runner_failure. */
export class WalkForwardFoldError extends Error {
  constructor(readonly code: WalkForwardFailureCode, message: string) {
    super(message);
    this.name = 'WalkForwardFoldError';
  }
}

export type RunFold = (fold: FoldWindow) => Promise<{ outcome: CompletedOutcome; hash: string }>;

export interface WalkForwardExecInput {
  readonly scheme: WalkForwardScheme;
  readonly period: RunPeriod;
  readonly requestedMetrics: readonly string[];
  readonly maxFolds: number;
  readonly deadlineExceeded: () => boolean;
}

const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

/** Anchored test-window equity: last point before test.from (boundary anchor) + points in [from,to). */
function anchoredTestEquity(equity: readonly EquityPoint[], fromMs: number, toMs: number): EquityPoint[] {
  const within = equity.filter((p) => p.barTs >= fromMs && p.barTs < toMs);
  let anchor: EquityPoint | undefined;
  for (const p of equity) if (p.barTs < fromMs && (anchor === undefined || p.barTs > anchor.barTs)) anchor = p;
  return anchor ? [anchor, ...within] : within;
}

export async function runWalkForward(input: WalkForwardExecInput, runFold: RunFold): Promise<WalkForward> {
  const { scheme, period, requestedMetrics, maxFolds, deadlineExceeded } = input;
  try {
    if (scheme.folds > maxFolds) {
      return { status: 'unavailable', scheme, reason: 'folds_exceeds_max', failedFolds: [], insufficientFolds: [] };
    }
    let windows: FoldWindow[];
    try {
      windows = splitWalkForward(period, scheme);
    } catch {
      return { status: 'unavailable', scheme, reason: 'split_error', failedFolds: [], insufficientFolds: [] };
    }

    const folds: WalkForwardFoldResult[] = [];
    const failedFolds: WalkForwardFailure[] = [];
    const insufficientFolds: number[] = [];
    let budgetCut = false;

    for (const fold of windows) {
      if (budgetCut || deadlineExceeded()) {
        budgetCut = true;
        failedFolds.push({ index: fold.index, code: 'budget_exhausted' });
        continue;
      }
      let ran: { outcome: CompletedOutcome; hash: string };
      try {
        ran = await runFold(fold);
      } catch (err) {
        const code = err instanceof WalkForwardFoldError ? err.code : 'runner_failure';
        failedFolds.push({ index: fold.index, code });
        continue;
      }
      const fromMs = Date.parse(fold.test.from);
      const toMs = Date.parse(fold.test.to);
      const equity = anchoredTestEquity(ran.outcome.baseline.evidence.equityCurve, fromMs, toMs);
      if (equity.length < 2) {
        insufficientFolds.push(fold.index);
        continue;
      }
      const allTrades = ran.outcome.baseline.trades;
      const inTest = allTrades.filter((t: Trade) => t.entryTs >= fromMs && t.exitTs < toMs);
      const carryInClosedTradeCount = allTrades.filter(
        (t: Trade) => t.entryTs < fromMs && t.exitTs >= fromMs && t.exitTs < toMs,
      ).length;
      const metrics = computeMetrics(requestedMetrics, equity, inTest, { elapsedYears: (toMs - fromMs) / YEAR_MS });
      folds.push({ index: fold.index, train: fold.train, test: fold.test, foldOutcomeHash: ran.hash, metrics, carryInClosedTradeCount });
    }

    if (folds.length === 0) {
      const reason = failedFolds.length > 0 ? 'all_folds_failed' : 'insufficient_folds';
      return { status: 'unavailable', scheme, reason, failedFolds, insufficientFolds };
    }
    const agg = aggregateFolds(folds.map((f) => ({ index: f.index, metrics: f.metrics })));
    const aggregate = { ...agg, requestedFoldCount: scheme.folds, completedFoldCount: folds.length, insufficientFolds };
    const status = folds.length === scheme.folds ? 'resolved' : 'partial';
    return { status, scheme, folds, aggregate, failedFolds };
  } catch {
    return { status: 'unavailable', scheme, reason: 'internal_error', failedFolds: [], insufficientFolds: [] };
  }
}
```

- [ ] **Step 4: Run test**

Run: `pnpm sdk:build && npx vitest run apps/backtester/test/walk-forward-exec.test.ts`
Expected: PASS (all cases). If a fold-window boundary makes a fixture land wrong, adjust the fixture
timestamps (not the assertions) so each test's intent holds — the fold math is E3a's, verified there.

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/engine/walk-forward-exec.ts apps/backtester/test/walk-forward-exec.test.ts
git commit -m "feat(research): E3b — pure walk-forward execution orchestrator"
```

---

### Task 6: Worker gate + merge (injectable runFold, no Docker)

**Files:**
- Modify: `apps/backtester/src/jobs/worker.ts` (add `WalkForward` import; `WorkerDeps.walkForward?`; export `resolveWalkForward`; add `makeWalkForwardRunFold` to `workerInternals` as a Task-6 stub; call the merge in `processNextQueued` AFTER the cache-populate block and after both hit/miss set `finalized`, immediately BEFORE the terminal `store.transition('completed')` at ~line 813)
- Modify: `apps/backtester/src/app.ts` (wire `deps.walkForward` from config)
- Test: `apps/backtester/test/walk-forward-wiring.test.ts`

**Interfaces:**
- Consumes: `runWalkForward`, `RunFold`, `CompletedOutcome` from `../engine/walk-forward-exec.js`; `WalkForward` from SDK.
- Produces:
  - `WorkerDeps.walkForward?: { enabled: boolean; maxFolds: number }`
  - `export async function resolveWalkForward(deps: WorkerDeps, claimed: JobRow, engine: Engine, ctx: { engineRequest: BacktestRunRequest; sandboxBundle?: SandboxBundleHandle }, runFoldOverride?: RunFold): Promise<WalkForward | undefined>` — gate (undefined for flag-off / no scheme / momentum); otherwise builds the production runFold via `workerInternals.makeWalkForwardRunFold(deps, engine, ctx.engineRequest, ctx.sandboxBundle)` (Task 7) unless `runFoldOverride` is supplied, then calls `runWalkForward`. **`ctx.engineRequest` and `ctx.sandboxBundle` are the ALREADY-BUILT ones from `processNextQueued` (correct `effectiveSeed`, stripped fields; the single outer bundle whose `cleanup()` the worker already calls) — NOT rebuilt/reloaded here, so no leak and no wrong seed.**
  - `workerInternals.makeWalkForwardRunFold` — the spy seam the integration test overrides (no new global-mutable field).

- [ ] **Step 1: Write the failing test**

Create `apps/backtester/test/walk-forward-wiring.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveWalkForward, type WorkerDeps } from '../src/jobs/worker.js';
import type { RunFold, CompletedOutcome } from '../src/engine/walk-forward-exec.js';

const DAY = 86_400_000;
function co(): CompletedOutcome {
  return { status: 'completed', baseline: { trades: [], evidence: { equityCurve: [
    { barIndex: 0, barTs: 0, equity: 100 }, { barIndex: 1, barTs: DAY, equity: 110 },
    { barIndex: 2, barTs: 2 * DAY, equity: 120 }, { barIndex: 3, barTs: 3 * DAY, equity: 130 },
  ] } } } as unknown as CompletedOutcome;
}
const okFold: RunFold = async () => ({ outcome: co(), hash: 'h' });
function claimed(over: object = {}) {
  return {
    runId: 'r1', datasetRef: 'ds', requestFingerprint: 'fp',
    request: { symbols: ['BTCUSDT'], timeframe: '1m', metrics: ['returns_count'],
      period: { from: new Date(0).toISOString(), to: new Date(4 * DAY).toISOString() },
      walkForward: { folds: 2, mode: 'rolling' } },
    runDeadlineMs: 10 * DAY, ...over,
  } as unknown as Parameters<typeof resolveWalkForward>[1];
}
function deps(over: Partial<WorkerDeps>): WorkerDeps {
  return { clock: () => 0, ...over } as unknown as WorkerDeps;
}
// A dummy exec-context; when a runFold override is passed, engineRequest/sandboxBundle are unused.
const ctx = { engineRequest: { period: { from: new Date(0).toISOString(), to: new Date(4 * DAY).toISOString() } } } as unknown as Parameters<typeof resolveWalkForward>[3];
const on = { walkForward: { enabled: true, maxFolds: 20 } };

describe('resolveWalkForward — gate + orchestration', () => {
  it('flag OFF ⇒ undefined', async () => {
    expect(await resolveWalkForward(deps({}), claimed(), 'overlay', ctx, okFold)).toBeUndefined();
  });
  it('no scheme ⇒ undefined even when enabled', async () => {
    const c = claimed({ request: { symbols: ['BTCUSDT'], timeframe: '1m', metrics: [], period: { from: 'a', to: 'b' } } });
    expect(await resolveWalkForward(deps(on), c, 'overlay', ctx, okFold)).toBeUndefined();
  });
  it('momentum ⇒ undefined', async () => {
    expect(await resolveWalkForward(deps(on), claimed(), 'momentum', ctx, okFold)).toBeUndefined();
  });
  it('enabled + scheme + overlay ⇒ resolved via the injected runFold', async () => {
    const wf = await resolveWalkForward(deps(on), claimed(), 'overlay', ctx, okFold);
    expect(wf?.status).toBe('resolved');
  });
  it('never throws — an injected runFold that always throws ⇒ unavailable, not a rejection', async () => {
    const bad: RunFold = async () => { throw new Error('boom'); };
    const wf = await resolveWalkForward(deps(on), claimed(), 'overlay', ctx, bad);
    expect(wf?.status).toBe('unavailable');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/backtester/test/walk-forward-wiring.test.ts`
Expected: FAIL — `resolveWalkForward` not exported.

- [ ] **Step 3: Implement the gate + merge**

In `apps/backtester/src/jobs/worker.ts`:

Add `WalkForward` to the SDK-contracts `import type { … }` group (the block ending `} from '@trading-backtester/sdk/contracts';`). Add:

```ts
import { runWalkForward, type RunFold } from '../engine/walk-forward-exec.js';
```

Add to `WorkerDeps` (after the `novelty?` field):

```ts
  /** E3b: walk-forward per-fold execution. Absent/disabled ⇒ no `walkForward` field (byte-identical). */
  walkForward?: { enabled: boolean; maxFolds: number };
```

Import `WalkForwardFoldError` too (add to the same import):

```ts
import { runWalkForward, WalkForwardFoldError, type RunFold } from '../engine/walk-forward-exec.js';
```

Add the exported helper next to `resolveNovelty`:

```ts
/**
 * E3b: run the advisory walk-forward folds for a completed overlay/strategy run. `undefined` ONLY for
 * the gate (flag off / no scheme / momentum); when enabled-with-scheme it always resolves to a
 * WalkForward (fail-open — a fault becomes `unavailable: internal_error`, never a rejection). The
 * production runFold (built from the outer engineRequest + sandboxBundle) executes one FRESH sandbox
 * session per fold; tests pass `runFoldOverride`.
 */
export async function resolveWalkForward(
  deps: WorkerDeps,
  claimed: JobRow,
  engine: Engine,
  ctx: { engineRequest: BacktestRunRequest; sandboxBundle?: SandboxBundleHandle },
  runFoldOverride?: RunFold,
): Promise<WalkForward | undefined> {
  if (!deps.walkForward?.enabled) return undefined;
  if (engine !== 'overlay' && engine !== 'strategy') return undefined;
  const scheme = claimed.request.walkForward;
  if (scheme === undefined) return undefined;
  try {
    const runFold = runFoldOverride ?? workerInternals.makeWalkForwardRunFold(deps, engine, ctx.engineRequest, ctx.sandboxBundle);
    const deadlineMs = claimed.runDeadlineMs;
    return await runWalkForward(
      {
        scheme,
        period: claimed.request.period,
        requestedMetrics: claimed.request.metrics ?? [],
        maxFolds: deps.walkForward.maxFolds,
        deadlineExceeded: () => deadlineMs !== undefined && deps.clock() >= deadlineMs,
      },
      runFold,
    );
  } catch {
    return { status: 'unavailable', scheme, reason: 'internal_error', failedFolds: [], insufficientFolds: [] };
  }
}
```

`makeWalkForwardRunFold` is implemented in Task 7 and lives on `workerInternals` (the existing spy seam
— NOT a new global-mutable override). For THIS task add a compiling stub to `workerInternals`:

```ts
// worker.ts already has: export const workerInternals = { sandboxBundleFor, executorFor, overlayRouterFor };
// Add makeWalkForwardRunFold to it. Task-6 stub (replaced in Task 7):
function makeWalkForwardRunFold(_deps: WorkerDeps, _engine: Engine, _engineRequest: BacktestRunRequest, _bundle?: SandboxBundleHandle): RunFold {
  // Until Task 7, any real (non-overridden) fold errors — safe because the feature flag defaults OFF.
  return async () => { throw new WalkForwardFoldError('runner_failure', 'production runFold not yet wired (Task 7)'); };
}
export const workerInternals = { sandboxBundleFor, executorFor, overlayRouterFor, makeWalkForwardRunFold };
```

Add the merge in `processNextQueued` — NOT in `finalizeResult`. Insert it after the cache-populate block
(`if (dedupOn) { … }`, ~line 810) and after both the hit and miss branches have set `finalized`,
immediately BEFORE the terminal `store.transition(runId, 'running', 'completed', …)` at ~line 813. At
that point `engineRequest` (built at ~line 560 from `materialized`, i.e. correct `effectiveSeed`, stripped)
and `sandboxBundle` (loaded at ~line 530) are in scope on BOTH paths:

```ts
  // E3b (advisory, flag-gated): per-fold walk-forward OOS stability. Runs on both the canonical miss AND
  // hit paths and AFTER the result-cache is populated (a crash mid-folds still leaves the canonical result
  // cached for the retry). Merged onto the summary projection ⇒ result_hash byte-identical when OFF.
  const walkForward = await resolveWalkForward(deps, claimed, engineOf(claimed), { engineRequest, sandboxBundle });
  if (walkForward) finalized = { ...finalized, summary: { ...finalized.summary, walkForward } };
```

(`engineOf(claimed)` is the existing helper that returns `'overlay' | 'strategy' | 'momentum'`; use it —
or reuse the `engine` local if one is already in scope at that point.)

- [ ] **Step 4: Wire app.ts**

In `apps/backtester/src/app.ts`, add to the `workerDeps` object (after the novelty spread):

```ts
    ...(config.walkForward ? { walkForward: { enabled: true, maxFolds: config.walkForwardMaxFolds } } : {}),
```

- [ ] **Step 5: Run test + typecheck**

Run: `pnpm sdk:build && npx vitest run apps/backtester/test/walk-forward-wiring.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: wiring test PASS; tsc exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/backtester/src/jobs/worker.ts apps/backtester/src/app.ts apps/backtester/test/walk-forward-wiring.test.ts
git commit -m "feat(research): E3b — worker gate + finalize merge for walk-forward (injectable runFold)"
```

---

### Task 7: Production `runFold` + durability/isolation + determinism gate

**Files:**
- Modify: `apps/backtester/src/jobs/worker.ts` (replace the Task-6 `makeWalkForwardRunFold` stub with the real per-fold executor)
- Test: `apps/backtester/test/walk-forward-integration.test.ts` (durability + isolation, no Docker via the injected seam); the full-suite determinism gate

**Interfaces:**
- Consumes: `buildOverlayDataset` (`../engine/data-adapter.js`), `overlayTapeCache`/`tapeCacheKey`, `overlayRouterFor`, `assertSandboxClean`, `buildInlineOverlayRegistry`, `buildTrustedRegistry`, `runOverlayBacktest`, `runStrategyBacktest`, `contentRef`, `RunnerError` — all already in worker.ts (reuse; do not duplicate imports).
- Produces: `makeWalkForwardRunFold(deps, engine, engineRequest, sandboxBundle?, io?): RunFold` (SYNC — no bundle load; the bundle is passed in). It reuses the OUTER `engineRequest` (correct seed, stripped) and OUTER `sandboxBundle` (no reload → the worker's single `sandboxBundle?.cleanup()` at ~line 856 still owns it), overriding only `period` per fold. The I/O collaborators are injected via `io` (default = real) so the factory is unit-testable without Docker:
  ```ts
  interface WalkForwardFoldIO {
    buildTape(period: RunPeriod): Promise<MarketTapeDataset>;
    makeRouter(): ExecutorRouter;
    runEngine(request: BacktestRunRequest, tape: MarketTapeDataset, router: ExecutorRouter): Promise<RunOutcome>;
  }
  ```

- [ ] **Step 1: Write the factory unit test (injected io — proves lifecycle + error mapping, no Docker)**

Create `apps/backtester/test/walk-forward-runfold.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { ExecutorRouter } from '../src/engine/sandbox/executor-router.js'; // adjust to the real path
import { RunnerError } from '../src/engine/errors.js'; // adjust to the real RunnerError module
import { workerInternals, type WorkerDeps } from '../src/jobs/worker.js';
import type { FoldWindow } from '@trading-backtester/sdk/contracts';

const DAY = 86_400_000;
const fold = (i: number): FoldWindow => ({
  index: i,
  train: { from: new Date(i * DAY).toISOString(), to: new Date((i + 1) * DAY).toISOString() },
  test: { from: new Date((i + 1) * DAY).toISOString(), to: new Date((i + 2) * DAY).toISOString() },
});
function fakeRouter(errors: unknown[] = []) {
  return { closeAll: vi.fn(), errors: () => errors } as unknown as ExecutorRouter;
}
const goodOutcome = { status: 'completed', baseline: { trades: [], evidence: { equityCurve: [] } } } as any;
const deps = {} as unknown as WorkerDeps;
const engineRequest = { symbols: ['BTCUSDT'], period: { from: 'x', to: 'y' } } as any;

describe('makeWalkForwardRunFold — per-fold resource lifecycle + error mapping', () => {
  it('builds a FRESH router per fold and closeAll()s it on success', async () => {
    const routers = [fakeRouter(), fakeRouter()];
    let n = 0;
    const io = { buildTape: vi.fn(async () => ({} as any)), makeRouter: () => routers[n++], runEngine: vi.fn(async () => goodOutcome) };
    const rf = workerInternals.makeWalkForwardRunFold(deps, 'overlay', engineRequest, undefined, io);
    await rf(fold(0));
    await rf(fold(1));
    expect(io.makeRouter as unknown as ReturnType<typeof vi.fn>).toBeDefined();
    expect(routers[0].closeAll).toHaveBeenCalledTimes(1);
    expect(routers[1].closeAll).toHaveBeenCalledTimes(1);
  });
  it('closeAll()s the router even when the engine throws', async () => {
    const router = fakeRouter();
    const io = { buildTape: async () => ({} as any), makeRouter: () => router, runEngine: async () => { throw new Error('x'); } };
    const rf = workerInternals.makeWalkForwardRunFold(deps, 'overlay', engineRequest, undefined, io);
    await expect(rf(fold(0))).rejects.toBeDefined();
    expect(router.closeAll).toHaveBeenCalledTimes(1);
  });
  it('maps a RunnerError sandbox code to sandbox_failure', async () => {
    const io = { buildTape: async () => ({} as any), makeRouter: () => fakeRouter(), runEngine: async () => { throw new RunnerError('sandbox_error', 'boom'); } };
    const rf = workerInternals.makeWalkForwardRunFold(deps, 'overlay', engineRequest, undefined, io);
    await expect(rf(fold(0))).rejects.toMatchObject({ code: 'sandbox_failure' });
  });
  it('a dirty sandbox (assertSandboxClean throws) ⇒ sandbox_failure', async () => {
    const io = { buildTape: async () => ({} as any), makeRouter: () => fakeRouter([{ err: 'dirty' }]), runEngine: async () => goodOutcome };
    const rf = workerInternals.makeWalkForwardRunFold(deps, 'overlay', engineRequest, undefined, io);
    await expect(rf(fold(0))).rejects.toMatchObject({ code: 'sandbox_failure' });
  });
  it('a tape build failure ⇒ missing_dataset', async () => {
    const io = { buildTape: async () => { throw new Error('no rows'); }, makeRouter: () => fakeRouter(), runEngine: async () => goodOutcome };
    const rf = workerInternals.makeWalkForwardRunFold(deps, 'overlay', engineRequest, undefined, io);
    await expect(rf(fold(0))).rejects.toMatchObject({ code: 'missing_dataset' });
  });
});
```

(Adjust the `ExecutorRouter` / `RunnerError` import paths to the real modules — confirm via
`git grep "class RunnerError"` and the router type's export site.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/backtester/test/walk-forward-runfold.test.ts`
Expected: FAIL — the Task-6 stub ignores `io` and always throws `runner_failure`.

- [ ] **Step 3: Implement the production factory**

Replace the Task-6 stub in `apps/backtester/src/jobs/worker.ts`:

```ts
interface WalkForwardFoldIO {
  buildTape(period: RunPeriod): Promise<MarketTapeDataset>;
  makeRouter(): ExecutorRouter;
  runEngine(request: BacktestRunRequest, tape: MarketTapeDataset, router: ExecutorRouter): Promise<RunOutcome>;
}

function mapRunnerCode(code: string): WalkForwardFailureCode {
  if (code === 'sandbox_error' || code === 'sandbox_unavailable') return 'sandbox_failure';
  if (code === 'validation_error') return 'validation_error';
  if (code.includes('timeout')) return 'timeout';
  return 'runner_failure';
}

// E3b: build the per-fold executor. ONE FRESH sandbox session per fold (no shared mutable router —
// load-bearing while P1-4 IPC/sequence is open); assertSandboxClean before accepting; failures classified
// into normalized codes. Registry is built once from the OUTER bundle (pure, reused); the outer bundle's
// cleanup stays with the worker (no reload here). engineRequest is the outer one — only `period` changes.
function makeWalkForwardRunFold(
  deps: WorkerDeps,
  engine: Engine,
  engineRequest: BacktestRunRequest,
  sandboxBundle?: SandboxBundleHandle,
  io?: WalkForwardFoldIO,
): RunFold {
  const registry =
    engine === 'strategy'
      ? buildInlineOverlayRegistry([], sandboxBundle ? [sandboxBundle.bundle] : [])
      : sandboxBundle
        ? buildInlineOverlayRegistry([sandboxBundle.bundle])
        : buildTrustedRegistry();
  const r = engineRequest;
  const realIo: WalkForwardFoldIO = {
    buildTape: (period) =>
      overlayTapeCache.getOrBuild(
        tapeCacheKey({ datasetRef: r.datasetRef, symbols: r.symbols, timeframe: r.timeframe, from: period.from, to: period.to }),
        () => buildOverlayDataset(deps.dataPort, { datasetRef: r.datasetRef, symbols: r.symbols, timeframe: r.timeframe, period }),
      ),
    makeRouter: () => workerInternals.overlayRouterFor(deps, r.symbols.length),
    runEngine: (request, tape, router) =>
      engine === 'strategy'
        ? runStrategyBacktest(request, {
            registry, marketTape: tape, router,
            ...(deps.barBatching === true ? { barBatching: { maxBars: deps.batchBars ?? 64 } } : {}),
            ...(deps.barMajor === true ? { barMajor: true } : {}),
            ...(deps.barMajorBatch === true ? { barMajorBatch: true } : {}),
            ...(deps.universe ? { universe: deps.universe } : {}),
          })
        : runOverlayBacktest(request, { registry, marketTape: tape, router, ...(deps.universe ? { universe: deps.universe } : {}) }),
  };
  const foldIo = io ?? realIo;

  return async (fold) => {
    const period = { from: fold.train.from, to: fold.test.to };
    let tape: MarketTapeDataset;
    try {
      tape = await foldIo.buildTape(period);
    } catch (err) {
      throw new WalkForwardFoldError('missing_dataset', `fold ${fold.index} tape build failed: ${String(err)}`);
    }
    const router = foldIo.makeRouter();
    try {
      const outcome = await foldIo.runEngine({ ...r, period }, tape, router);
      if (outcome.status !== 'completed') throw new WalkForwardFoldError('validation_error', `fold ${fold.index} rejected`);
      assertSandboxClean(router); // throws RunnerError('sandbox_error') if the session left errors → mapped below
      return { outcome, hash: contentRef(outcome) };
    } catch (err) {
      if (err instanceof WalkForwardFoldError) throw err;
      const code = err instanceof RunnerError ? mapRunnerCode(err.code) : 'runner_failure';
      throw new WalkForwardFoldError(code, `fold ${fold.index}: ${String(err)}`);
    } finally {
      router.closeAll();
    }
  };
}
```

Confirm `RunnerError` has a `.code` string field (worker.ts throws `new RunnerError('sandbox_error', …)`).
Reuse existing imports; add `MarketTapeDataset`, `ExecutorRouter`, `RunPeriod` type imports only if missing.

- [ ] **Step 4: Run the factory unit test**

Run: `pnpm sdk:build && npx vitest run apps/backtester/test/walk-forward-runfold.test.ts`
Expected: PASS (fresh router per fold; closeAll on success + throw; RunnerError → sandbox_failure; dirty
sandbox → sandbox_failure; tape fail → missing_dataset).

- [ ] **Step 5: Write the durability + isolation integration test (spy seam, no Docker)**

Create `apps/backtester/test/walk-forward-integration.test.ts`. Drive one overlay/strategy run through a
real store with `deps.walkForward = { enabled: true, maxFolds: 20 }` and a request whose
`request.walkForward = { folds: 2, mode: 'rolling' }`, injecting a canned fold runner via
`vi.spyOn(workerInternals, 'makeWalkForwardRunFold').mockReturnValue(async (f) => ({ outcome: cannedOutcome, hash: 'h' + f.index }))`
(no Docker). Model the harness on the closest existing end-to-end worker test (a dedup/coalesce test that
drives `drainQueue`/`processNextQueued` through a store). Assert:
- **durability:** after `drainQueue`, read the terminal row back from the store and assert
  `resultSummary.walkForward` is present — on BOTH `InMemoryJobStore` AND `PgJobStore` (Pg gated behind
  `process.env.DATABASE_URL`, skipped if unset — mirror the repo's existing Pg-gated tests; the Pg case
  proves JSON (de)serialization round-trips the union);
- **isolation:** the injected `trialLedger.recordIfNew` and novelty-pool `recordIfNew` were NOT called by
  the fold loop, and the webhook poster (`deps.postWebhook`) was called exactly once for the run (not per
  fold).

Restore the spy in `afterEach`.

- [ ] **Step 6: Run the integration test**

Run: `npx vitest run apps/backtester/test/walk-forward-integration.test.ts`
Expected: PASS (InMemory durability + isolation; Pg case iff `DATABASE_URL` set).

- [ ] **Step 7: Full-suite determinism gate**

Run: `npx tsc --noEmit -p tsconfig.json && npx vitest run`
Expected: tsc exit 0; suite fully green. Every prior golden `result_hash` test byte-identical (flag OFF
everywhere; `walkForward` non-hashed; fingerprint change is a conditional-spread that omits the key for
absent-scheme requests). If any prior golden moved, STOP — something leaked into a hashed payload.

- [ ] **Step 8: Commit**

```bash
git add apps/backtester/src/jobs/worker.ts apps/backtester/test/walk-forward-runfold.test.ts apps/backtester/test/walk-forward-integration.test.ts
git commit -m "feat(research): E3b — production per-fold runFold + durability/isolation (advisory, flag OFF)"
```

---

## Self-Review

**Spec coverage:**
- Warmup/eval (continuous-state, anchored slice, in-test trade filter, carryInClosedTradeCount) → Task 5 (`anchoredTestEquity`, `inTest`/carry filter, `computeMetrics`) + its tests. ✓
- Status union (resolved/partial/unavailable) + normalized codes + internal_error + unavailable carries failedFolds/insufficientFolds → Task 5. ✓
- SDK contract → Task 1. ✓
- Fingerprint config-independent → Task 2. ✓
- Submit 400 vs MAX_FOLDS advisory → Task 3 (400) + Task 4 (maxFolds) + Task 5 (folds_exceeds_max). ✓
- Config flag + safe-int max → Task 4. ✓
- Worker wiring on both hit+miss (seam in `processNextQueued` after cache-populate, reusing the outer `engineRequest`+`sandboxBundle` built pre-dedup-gate → available on both paths) + gate + fail-open → Task 6. ✓
- Production per-fold fresh router + assertSandboxClean + closeAll(success+throw) + deadline + normalized code mapping (`mapRunnerCode`) → Task 7 (io-injectable factory, **unit-tested without Docker** in Step 1) + Task 6 (deadlineExceeded). ✓
- No engineRequest/bundle defects: fold reuses the outer `engineRequest` (correct `effectiveSeed`, stripped) with only `period` overridden; reuses the outer `sandboxBundle` (no reload → no leak; worker's single `cleanup()` owns it) → Task 6 ctx + Task 7 factory. ✓
- Durability on both stores + isolation (no E2 ledger / novelty / webhook) → Task 7 Step 5. ✓
- Determinism gate (flag-OFF byte-identical) → Task 7 Step 7. ✓
- Fingerprint byte-identical for absent-scheme (conditional spread + golden pin) → Task 2. ✓
- Submit guards arbitrary JSON (object/null/array before field access) → Task 3. ✓
- Rollout (SDK release, don't enable until P1-4) → operational, tracked in the memory/ROADMAP, not code.

**Placeholder scan:** Task 3's `submitBad`/`submitOk` and Task 7's integration harness are intentionally modeled on existing tests in the repo (named, with the exact contract to satisfy) — the implementer adapts the nearest existing end-to-end test; every assertion contract is spelled out. Task 2's `GOLDEN` is captured from a pre-change run (procedure given). No `require`/dynamic-import placeholders remain (Task 5 uses a static `aggregateFolds` import). The production runFold is now covered by a dedicated factory unit test (Task 7 Step 1), not only the flag-OFF suite.

**Type consistency:** `RunFold` / `CompletedOutcome` / `WalkForwardFoldError` (Task 5) are consumed unchanged in Tasks 6-7. `WalkForward` / `WalkForwardExecAggregate` / `WalkForwardFailure` (Task 1) match their use in Task 5's assembly and Task 6's merge. `resolveWalkForward(deps, claimed, engine, ctx, runFoldOverride?)` is consistent between its export (Task 6) and its caller (the `processNextQueued` merge, Task 6, passing `{ engineRequest, sandboxBundle }`); the integration test overrides `workerInternals.makeWalkForwardRunFold` rather than the param. Config fields `walkForward`/`walkForwardMaxFolds` (Task 4) match `app.ts` (Task 6) and `WorkerDeps.walkForward` (Task 6).

**Sequencing note for the implementer:** Tasks 1→5 are independent-ish substrate; Task 6 depends on 1+5; Task 7 depends on 6. Task 6 ships a compiling stub `makeWalkForwardRunFold` so its tests pass without Docker; Task 7 replaces the stub with the real executor. This keeps the tested orchestration (6) reviewable separately from the Docker-touching glue (7).
