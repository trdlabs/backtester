import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { testConfig } from './helpers.js';
import { PgComputeLockStore } from '../src/jobs/coalesce/pg-compute-lock.js';
import { InMemoryComputeLockStore } from '../src/jobs/coalesce/compute-lock.js';

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => { await dispose?.(); dispose = undefined; });

describe('buildApp coalescing wiring', () => {
  it('wires a ComputeLockStore + flags when coalesceEnabled', async () => {
    const app = await buildApp(testConfig({ dedupEnabled: true, coalesceEnabled: true }));
    dispose = app.dispose;
    expect(app.workerDeps.coalesceEnabled).toBe(true);
    expect(app.workerDeps.computeLock).toBeInstanceOf(InMemoryComputeLockStore); // no DB in testConfig → InMemory
  });
  it('coalesceEnabled false → no computeLock on workerDeps', async () => {
    const app = await buildApp(testConfig({ coalesceEnabled: false }));
    dispose = app.dispose;
    expect(app.workerDeps.computeLock).toBeUndefined();
    expect(app.workerDeps.coalesceEnabled).toBe(false);
  });

  // P3-6a: the single-process autoWorker's tick() must run the SAME coalescing maintenance as the
  // multi-process loop — including the orphan-lock sweep (previously only in runWorkerLoop).
  it('tick() sweeps an orphaned compute-lock in the single-process worker (coalescing ON)', async () => {
    const app = await buildApp(testConfig({ dedupEnabled: true, coalesceEnabled: true }));
    dispose = app.dispose;
    const lock = app.workerDeps.computeLock!;
    const now = 1_700_000_000_000; // testConfig's fixed clock
    // Orphaned lock expired far beyond the 30s grace (leader crashed, no follower to re-elect).
    await lock.acquire('orphan-ci', 'run-dead', 'w', now - 100_000, 100);
    const sweepSpy = vi.spyOn(lock, 'sweepExpired');
    await app.tick();
    expect(sweepSpy).toHaveBeenCalled();
    expect(await lock.get('orphan-ci')).toBeUndefined();
  });

  // INV-6: coalescing OFF → no compute lock is wired, so tick() performs no lock maintenance (and never
  // throws for its absence).
  it('INV-6: coalescing OFF → tick() does no lock maintenance (no lock wired)', async () => {
    const app = await buildApp(testConfig({ coalesceEnabled: false }));
    dispose = app.dispose;
    expect(app.workerDeps.computeLock).toBeUndefined();
    await expect(app.tick()).resolves.toBeUndefined();
  });
});
