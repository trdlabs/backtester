import { describe, expect, it } from 'vitest';
import { resolveWalkForward, type WorkerDeps } from '../src/jobs/worker.js';
import type { RunFold, CompletedOutcome } from '../src/engine/walk-forward-exec.js';
import type { FoldWindow } from '@trdlabs/backtester-sdk/contracts';

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

// wfo-extended-fixture item 4 — up-front (BEFORE any fold runs) history sufficiency check. At the 1h
// cadence, (maxFolds+1)*MACD-warmup(34) ⇒ ~30 required days (see required-history.test.ts). A 7-day
// request period is short of that; a 42-day one clears it — mirrors the T1/T2 fixture tiers.
describe('resolveWalkForward — up-front insufficient_history (before any fold runs)', () => {
  let foldCalls: number;
  // Equity anchored INSIDE the fold's own test window (not the fixed `co()` helper, which is only
  // 0-3 days in and would land outside a 42-day-period fold's test slice) — the assertion this block
  // cares about is whether runFold is invoked at all, not per-fold metric values.
  function coForFold(fold: FoldWindow): CompletedOutcome {
    const from = Date.parse(fold.test.from);
    const to = Date.parse(fold.test.to);
    const mid = Math.round((from + to) / 2);
    return {
      status: 'completed',
      baseline: { trades: [], evidence: { equityCurve: [
        { barIndex: 0, barTs: from, equity: 100 },
        { barIndex: 1, barTs: mid, equity: 110 },
        { barIndex: 2, barTs: to, equity: 120 },
      ] } },
    } as unknown as CompletedOutcome;
  }
  const countingFold: RunFold = async (fold) => {
    foldCalls += 1;
    return { outcome: coForFold(fold), hash: 'h' };
  };

  function claimedWithSpan(days: number, folds = 2, over: object = {}) {
    return claimed({
      request: {
        symbols: ['BTCUSDT'], timeframe: '1h', metrics: ['returns_count'],
        period: { from: new Date(0).toISOString(), to: new Date(days * DAY).toISOString() },
        walkForward: { folds, mode: 'rolling' },
      },
      ...over,
    });
  }

  // fix wave: sizing is keyed on THIS REQUEST's own scheme.folds (clamped to maxFolds=20), not
  // unconditionally on maxFolds — so a 7-day, 2-fold request required-days shrinks with it: (2+1)*34
  // bars * 60min / 1440 = 5.1d ⇒ ceil 5d, and 7d clears that. To keep exercising the fail-fast path at
  // the old 30-day floor, this case now declares a 20-fold request (clamped to maxFolds=20, same as
  // the pre-fix constant sizing).
  it('7-day period, 1h timeframe, 20-fold request ⇒ still unavailable:insufficient_history with requiredDays 30 (clamped to maxFolds) + a T2 hint, runFold never called', async () => {
    foldCalls = 0;
    const wf = await resolveWalkForward(deps(on), claimedWithSpan(7, 20), 'overlay', ctx, countingFold);
    expect(wf).toMatchObject({ status: 'unavailable', reason: 'insufficient_history', requiredDays: 30 });
    expect((wf as { requiredTier?: string }).requiredTier).toContain('T2');
    expect(foldCalls).toBe(0);
  });

  it('42-day period, 1h timeframe, 2-fold request ⇒ resolves normally, no insufficient-history reason', async () => {
    foldCalls = 0;
    const wf = await resolveWalkForward(deps(on), claimedWithSpan(42, 2), 'overlay', ctx, countingFold);
    expect(wf?.status).toBe('resolved');
    expect(foldCalls).toBeGreaterThan(0);
  });

  // fix wave: the core regression this fix closes — a valid 2-fold request over a period the deep
  // path would resolve (~15d, required = (2+1)*34*60/1440 = 5.1d ⇒ ceil 5d) must NOT be falsely
  // short-circuited just because the config ceiling (maxFolds=20 ⇒ 30d required) is larger.
  it('2-fold request over a ~15-day period, 1h timeframe ⇒ resolves (sized from the request\'s own folds, not maxFolds)', async () => {
    foldCalls = 0;
    const wf = await resolveWalkForward(deps(on), claimedWithSpan(15, 2), 'overlay', ctx, countingFold);
    expect(wf?.status).toBe('resolved');
    expect(wf).not.toMatchObject({ reason: 'insufficient_history' });
    expect(foldCalls).toBeGreaterThan(0);
  });

  it('same ~15-day period with a 20-fold request ⇒ still short-circuits (config ceiling, clamped-to sizing needs 30d)', async () => {
    foldCalls = 0;
    const wf = await resolveWalkForward(deps(on), claimedWithSpan(15, 20), 'overlay', ctx, countingFold);
    expect(wf).toMatchObject({ status: 'unavailable', reason: 'insufficient_history', requiredDays: 30 });
    expect(foldCalls).toBe(0);
  });

  it('an over-ceiling fold request (50, maxFolds=20) is clamped to maxFolds for sizing, not used raw', async () => {
    foldCalls = 0;
    // Raw 50-fold sizing would require ceil(51*34*60/1440)=73d and 42d would still fail the up-front
    // check with reason:insufficient_history. Clamped-to-20 sizing requires only 30d, so the 42-day
    // period CLEARS the up-front check and falls through to the deep `runWalkForward`, which then (and
    // only then) rejects on its own `scheme.folds(50) > maxFolds(20)` ceiling — proving the up-front
    // sizing used the clamped value, not the raw request folds.
    const wf = await resolveWalkForward(deps(on), claimedWithSpan(42, 50), 'overlay', ctx, countingFold);
    expect(wf).toMatchObject({ status: 'unavailable', reason: 'folds_exceeds_max' });
    expect(foldCalls).toBe(0);
  });
});
