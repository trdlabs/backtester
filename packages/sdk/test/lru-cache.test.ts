import { describe, expect, it } from 'vitest';
import { LruCache } from '../src/internal/lru-cache';

describe('LruCache', () => {
  it('evicts the least-recently-used (oldest) entry past capacity', () => {
    const c = new LruCache<string, number>(2);
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3); // over capacity → 'a' (LRU) evicted
    expect(c.has('a')).toBe(false);
    expect(c.get('b')).toBe(2);
    expect(c.get('c')).toBe(3);
    expect(c.size).toBe(2);
  });

  it('get promotes a key to most-recently-used (refresh-on-hit)', () => {
    const c = new LruCache<string, number>(2);
    c.set('a', 1);
    c.set('b', 2);
    expect(c.get('a')).toBe(1); // promote 'a' → 'b' becomes LRU
    c.set('c', 3); // evicts 'b', 'a' survives
    expect(c.has('b')).toBe(false);
    expect(c.get('a')).toBe(1);
    expect(c.get('c')).toBe(3);
  });

  it('re-setting an existing key refreshes it (one entry, most-recent, updated value)', () => {
    const c = new LruCache<string, number>(2);
    c.set('a', 1);
    c.set('b', 2);
    c.set('a', 11); // same key → refresh (not a new slot); 'b' is now LRU
    expect(c.size).toBe(2);
    c.set('c', 3); // evicts 'b'
    expect(c.has('b')).toBe(false);
    expect(c.get('a')).toBe(11); // updated value retained
  });

  it('a get miss returns undefined and does not change eviction order', () => {
    const c = new LruCache<string, number>(2);
    c.set('a', 1);
    c.set('b', 2);
    expect(c.get('x')).toBeUndefined();
    c.set('c', 3); // 'a' is still the LRU → evicted
    expect(c.has('a')).toBe(false);
  });

  it('rejects a non-positive / non-integer capacity', () => {
    expect(() => new LruCache(0)).toThrow();
    expect(() => new LruCache(-1)).toThrow();
    expect(() => new LruCache(1.5)).toThrow();
  });
});
