// P3-6b — result-cache TTL eviction is wired into the worker loop (both topologies) and gated on
// `resultCacheTtlMs` (unset ⇒ OFF, cache unchanged). Driven through buildApp + the exposed tick().
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { testConfig, testDeps } from './helpers.js';
import type { CacheEntry } from '../src/jobs/dedup/result-cache.js';

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => { await dispose?.(); dispose = undefined; });

const NOW = 1_700_000_000_000; // testConfig's fixed clock
const entry = (id: string, createdAtMs: number): CacheEntry => ({
  computeIdentity: id,
  requestFingerprint: 'f',
  datasetFingerprint: 'd',
  computeVersion: '1',
  sandboxPolicyVersion: 's',
  templateRef: 'sha256:x',
  createdAtMs,
});

describe('buildApp result-cache TTL wiring', () => {
  it('tick() evicts an expired cache row when resultCacheTtlMs is set', async () => {
    const app = await buildApp(testConfig({ dedupEnabled: true, resultCacheTtlMs: 1000 }), testDeps());
    dispose = app.dispose;
    const cache = app.workerDeps.resultCache!;
    await cache.put(entry('expired', NOW - 10_000)); // 10s old ≫ 1s TTL
    await cache.put(entry('fresh', NOW - 100)); // within TTL
    const sweepSpy = vi.spyOn(cache, 'sweepExpired');
    await app.tick();
    expect(sweepSpy).toHaveBeenCalled();
    expect(await cache.lookup('expired')).toBeUndefined();
    expect(await cache.lookup('fresh')).toBeDefined(); // artifacts + fresh rows untouched
  });

  it('default OFF: no resultCacheTtlMs → tick() never sweeps the cache', async () => {
    const app = await buildApp(testConfig({ dedupEnabled: true }), testDeps()); // resultCacheTtlMs unset
    dispose = app.dispose;
    const cache = app.workerDeps.resultCache!;
    await cache.put(entry('old', NOW - 10_000));
    const sweepSpy = vi.spyOn(cache, 'sweepExpired');
    await app.tick();
    expect(sweepSpy).not.toHaveBeenCalled();
    expect(await cache.lookup('old')).toBeDefined(); // never evicted (TTL OFF)
  });
});
