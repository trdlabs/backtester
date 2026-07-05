import { afterEach, describe, expect, it } from 'vitest';
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
});
