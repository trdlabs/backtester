// E3b Task 7 — makeWalkForwardRunFold factory unit test (injected io, no Docker).
//
// Proves the per-fold resource lifecycle + error-mapping contract in isolation, without touching the
// sandbox/Docker path: buildTape/makeRouter/runEngine are all injected via `io`, so this test drives
// the factory's OWN control flow (fresh router per fold, closeAll on success AND on throw,
// assertSandboxClean-driven dirty-sandbox detection, RunnerError code mapping, tape-build failure
// mapping) deterministically and fast.

import { describe, expect, it, vi } from 'vitest';
import type { ExecutorRouter } from '../src/engine/sandbox/routing.js';
import { RunnerError } from '../src/runner/errors.js';
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
    const makeRouterFn = vi.fn(() => routers[n++]);
    const io = { buildTape: vi.fn(async () => ({} as any)), makeRouter: makeRouterFn, runEngine: vi.fn(async () => goodOutcome) };
    const rf = workerInternals.makeWalkForwardRunFold(deps, 'overlay', engineRequest, undefined, io);
    await rf(fold(0));
    await rf(fold(1));
    expect(makeRouterFn).toHaveBeenCalledTimes(2);
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
  it('a makeRouter() throw is classified via mapRunnerCode, not surfaced raw as runner_failure', async () => {
    const io = {
      buildTape: async () => ({} as any),
      makeRouter: () => { throw new RunnerError('sandbox_unavailable', 'no daemon'); },
      runEngine: async () => goodOutcome,
    };
    const rf = workerInternals.makeWalkForwardRunFold(deps, 'overlay', engineRequest, undefined, io);
    await expect(rf(fold(0))).rejects.toMatchObject({ code: 'sandbox_failure' });
  });
});
