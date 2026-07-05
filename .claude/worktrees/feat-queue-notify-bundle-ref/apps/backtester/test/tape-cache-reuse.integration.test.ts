// Spec §Testing — "the actual payoff": two runs over the same data slice materialize once; a run over a
// different slice rematerializes. Proven at the worker's keying contract — the exact field mapping
// worker.ts uses to derive the overlay cache key — with a stub builder that counts materializations.
// (buildOverlayDataset's internals are covered by the overlay goldens; this pins that the KEY drives reuse.)

import { describe, expect, it, vi } from 'vitest';
import { TapeCache, tapeCacheKey } from '../src/data/tape-cache.js';

// The fields worker.ts reads off claimed.request on the overlay path.
type OverlayReq = {
  datasetRef: string;
  symbols: readonly string[];
  timeframe: string;
  period: { from: string; to: string };
  params?: Record<string, unknown>; // strategy dimension — must NOT affect the key
  seed?: number;                     // strategy dimension — must NOT affect the key
};

// MUST mirror the overlay seam in worker.ts:
//   tapeCacheKey({ datasetRef: r.datasetRef, symbols: r.symbols, timeframe: r.timeframe, from: r.period.from, to: r.period.to })
const keyFor = (r: OverlayReq) =>
  tapeCacheKey({
    datasetRef: r.datasetRef,
    symbols: r.symbols,
    timeframe: r.timeframe,
    from: r.period.from,
    to: r.period.to,
  });

const baseReq: OverlayReq = {
  datasetRef: 'smoke-btc-1m',
  symbols: ['BTCUSDT'],
  timeframe: '1m',
  period: { from: '2023-11-14T00:00:00.000Z', to: '2023-11-15T00:00:00.000Z' },
};

describe('tape cache payoff: same data slice materializes once across runs', () => {
  it('reuses one materialization for two identical requests', async () => {
    const cache = new TapeCache<{ tag: string }>(16);
    const build = vi.fn(async () => ({ tag: 'tape' }));
    const first = await cache.getOrBuild(keyFor(baseReq), build);
    const second = await cache.getOrBuild(keyFor(baseReq), build);
    expect(build).toHaveBeenCalledTimes(1); // materialized once
    expect(second).toBe(first); // same instance shared across runs
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1 });
  });

  it('reuses the materialization when only strategy params/seed differ (parameter sweep)', async () => {
    const cache = new TapeCache<{ tag: string }>(16);
    const build = vi.fn(async () => ({ tag: 'tape' }));
    await cache.getOrBuild(keyFor({ ...baseReq, params: { fast: 5 }, seed: 1 }), build);
    await cache.getOrBuild(keyFor({ ...baseReq, params: { fast: 9 }, seed: 2 }), build);
    expect(build).toHaveBeenCalledTimes(1); // a whole sweep over params hits one cached tape
  });

  it('rematerializes when a data dimension changes (different window)', async () => {
    const cache = new TapeCache<{ tag: string }>(16);
    const build = vi.fn(async () => ({ tag: 'tape' }));
    await cache.getOrBuild(keyFor(baseReq), build);
    await cache.getOrBuild(
      keyFor({ ...baseReq, period: { from: baseReq.period.from, to: '2023-11-16T00:00:00.000Z' } }),
      build,
    );
    expect(build).toHaveBeenCalledTimes(2); // different slice → second materialization
  });
});
