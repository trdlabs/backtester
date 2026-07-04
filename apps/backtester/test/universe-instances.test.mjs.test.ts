// apps/backtester/test/universe-instances.test.mjs.test.ts
import { describe, expect, it } from 'vitest';
import { makeInstanceStore, symbolOf } from '../sandbox-harness-overlay/universe-instances.mjs';

describe('universe-instances', () => {
  it('ensure() creates one isolated slot per symbol; get() returns it', () => {
    const store = makeInstanceStore();
    // factory returns { instance, rng } — the exact contract entry.mjs's handleInit passes
    const a = store.ensure('AAA', () => ({ instance: { tag: 'A' }, rng: { r: 1 } }));
    const b = store.ensure('BBB', () => ({ instance: { tag: 'B' }, rng: { r: 2 } }));
    expect(a.instance.tag).toBe('A');
    expect(b.instance.tag).toBe('B');
    expect(a.rng.r).toBe(1); // rng carried from the factory result
    a.buffer.push(1);
    expect(b.buffer).toEqual([]); // isolated buffers
    expect(store.get('AAA')).toBe(a); // stable identity
    expect(store.ensure('AAA', () => ({ instance: { tag: 'X' }, rng: { r: 9 } })).instance.tag).toBe('A'); // idempotent
  });
  it('symbolOf reads symbol from init/hook/hookBatch shapes', () => {
    expect(symbolOf({ t: 'init', symbol: 'S1' })).toBe('S1');
    expect(symbolOf({ t: 'hook', snapshot: { symbol: 'S2' } })).toBe('S2');
    expect(symbolOf({ t: 'hookBatch', bars: [{ snapshot: { symbol: 'S3' } }] })).toBe('S3');
  });
});
