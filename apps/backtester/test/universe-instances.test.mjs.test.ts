// apps/backtester/test/universe-instances.test.mjs.test.ts
import { describe, expect, it } from 'vitest';
import { makeInstanceStore, symbolOf, resolveInstance } from '../sandbox-harness-overlay/universe-instances.mjs';

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

describe('resolveInstance', () => {
  it('function default export: ok:true with a FRESH instance on each call (per-symbol isolation)', () => {
    const loadedModule = { default: () => ({ n: 0 }) };
    const r1 = resolveInstance(loadedModule, { universe: true });
    const r2 = resolveInstance(loadedModule, { universe: true });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) throw new Error('unreachable — asserted above');
    expect(r1.instance).not.toBe(r2.instance); // distinct instances per call
    expect(r1.instance).toEqual({ n: 0 });
    expect(r2.instance).toEqual({ n: 0 });
  });

  it('non-function default export + universe:false: ok:true, shared object (back-compat, pre-branch behavior)', () => {
    const shared = { tag: 'shared' };
    const loadedModule = { default: shared };
    const r = resolveInstance(loadedModule, { universe: false });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable — asserted above');
    expect(r.instance).toBe(shared);
  });

  it('non-function default export + universe:true: fail-closed with bundle_load_failed', () => {
    const shared = { tag: 'shared' };
    const loadedModule = { default: shared };
    const r = resolveInstance(loadedModule, { universe: true });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable — asserted above');
    expect(r.code).toBe('bundle_load_failed');
    expect(r.reason).toMatch(/universe session requires a factory-function default export/);
  });

  it('no default export (falls back to loadedModule) + universe:false: ok:true, unchanged fallback', () => {
    const loadedModule = { someExport: 1 };
    const r = resolveInstance(loadedModule, { universe: false });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable — asserted above');
    expect(r.instance).toBe(loadedModule);
  });
});
