import { describe, expect, it, vi } from 'vitest';
import { tapeCacheKey, TapeCache, readMaxEntries } from '../src/data/tape-cache.js';

describe('tapeCacheKey', () => {
  it('is independent of symbol order', () => {
    const a = tapeCacheKey({ datasetRef: 'ds', symbols: ['BTC', 'ETH'], from: '1', to: '2', timeframe: '1m' });
    const b = tapeCacheKey({ datasetRef: 'ds', symbols: ['ETH', 'BTC'], from: '1', to: '2', timeframe: '1m' });
    expect(a).toBe(b);
  });

  it('distinguishes different windows', () => {
    const a = tapeCacheKey({ datasetRef: 'ds', symbols: ['BTC'], from: '1', to: '2' });
    const b = tapeCacheKey({ datasetRef: 'ds', symbols: ['BTC'], from: '1', to: '3' });
    expect(a).not.toBe(b);
  });

  it('distinguishes datasetRef and timeframe', () => {
    const base = { symbols: ['BTC'], from: '1', to: '2' } as const;
    expect(tapeCacheKey({ ...base, datasetRef: 'a' })).not.toBe(tapeCacheKey({ ...base, datasetRef: 'b' }));
    expect(tapeCacheKey({ ...base, datasetRef: 'a', timeframe: '1m' })).not.toBe(
      tapeCacheKey({ ...base, datasetRef: 'a', timeframe: '5m' }),
    );
  });
});

describe('TapeCache', () => {
  it('builds once on miss and serves the cached value on hit', async () => {
    const cache = new TapeCache<number>(16);
    const build = vi.fn(async () => 42);
    expect(await cache.getOrBuild('k', build)).toBe(42);
    expect(await cache.getOrBuild('k', build)).toBe(42);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('de-duplicates concurrent builds for the same key', async () => {
    const cache = new TapeCache<number>(16);
    let resolve!: (v: number) => void;
    const build = vi.fn(() => new Promise<number>((r) => { resolve = r; }));
    const p1 = cache.getOrBuild('k', build);
    const p2 = cache.getOrBuild('k', build);
    resolve(7);
    expect(await p1).toBe(7);
    expect(await p2).toBe(7);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('evicts the least-recently-used entry beyond maxEntries', async () => {
    const cache = new TapeCache<string>(2);
    const bA = vi.fn(async () => 'A');
    const bB = vi.fn(async () => 'B');
    const bC = vi.fn(async () => 'C');
    await cache.getOrBuild('a', bA);          // [a]
    await cache.getOrBuild('b', bB);          // [a,b]
    await cache.getOrBuild('a', bA);          // hit a -> order [b,a]
    await cache.getOrBuild('c', bC);          // miss c -> evict LRU 'b' -> [a,c]
    await cache.getOrBuild('b', bB);          // 'b' was evicted -> rebuild
    expect(bB).toHaveBeenCalledTimes(2);
    await cache.getOrBuild('a', bA);          // 'a' still cached
    expect(bA).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed build; the next call retries', async () => {
    const cache = new TapeCache<number>(16);
    const build = vi.fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(5);
    await expect(cache.getOrBuild('k', build)).rejects.toThrow('boom');
    expect(await cache.getOrBuild('k', build)).toBe(5);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('bypasses caching when maxEntries is 0', async () => {
    const cache = new TapeCache<number>(0);
    const build = vi.fn(async () => 1);
    await cache.getOrBuild('k', build);
    await cache.getOrBuild('k', build);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('reports hit/miss/size stats', async () => {
    const cache = new TapeCache<number>(16);
    const build = vi.fn(async () => 1);
    await cache.getOrBuild('k', build); // miss
    await cache.getOrBuild('k', build); // hit
    expect(cache.stats()).toEqual({ hits: 1, misses: 1, size: 1 });
  });
});

describe('readMaxEntries', () => {
  it('defaults to 16 when unset', () => {
    delete process.env.TAPE_CACHE_MAX_ENTRIES;
    expect(readMaxEntries()).toBe(16);
  });
  it('parses an explicit value', () => {
    process.env.TAPE_CACHE_MAX_ENTRIES = '4';
    expect(readMaxEntries()).toBe(4);
    delete process.env.TAPE_CACHE_MAX_ENTRIES;
  });
  it('accepts 0 (disabled)', () => {
    process.env.TAPE_CACHE_MAX_ENTRIES = '0';
    expect(readMaxEntries()).toBe(0);
    delete process.env.TAPE_CACHE_MAX_ENTRIES;
  });
  it('falls back to 16 on garbage', () => {
    process.env.TAPE_CACHE_MAX_ENTRIES = 'nope';
    expect(readMaxEntries()).toBe(16);
    delete process.env.TAPE_CACHE_MAX_ENTRIES;
  });
});
