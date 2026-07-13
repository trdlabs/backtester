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
