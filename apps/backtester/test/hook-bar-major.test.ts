// Task 3 (Slice B bar-major transport) — pure per-symbol iteration helper, host-side unit test.
//
// `runHookBarMajor` is imported DIRECTLY (no container, no entry.mjs spawn — entry.mjs imports the
// untrusted bundle from a container-absolute path and cannot run on the host). `runHookBarMajor` is
// async (mirrors hook-batch.mjs's runHookBatch: `await fn.call(instance, ctx)` per entry, so an
// async onBarClose is supported) — so every call site here awaits it.
import { describe, expect, it } from 'vitest';
import { runHookBarMajor } from '../sandbox-harness-overlay/hook-bar-major.mjs';
import type { HookBarMajorSlot, HookBarMajorStore } from '../sandbox-harness-overlay/hook-bar-major.d.mts';

function fakeStore(map: Map<string, HookBarMajorSlot>): HookBarMajorStore {
  return { get: (s: string) => map.get(s) };
}
const rehydrateContext = (snap: unknown) => ({ symbol: (snap as { symbol: string }).symbol });
const normalize = (out: unknown): unknown[] => (Array.isArray(out) ? out : out == null ? [] : [out]);
const pickHook = (inst: unknown) =>
  (inst as { onBarClose?: (this: unknown, ctx: unknown) => unknown }).onBarClose;

describe('runHookBarMajor (sequential, index order, per-symbol fail-closed)', () => {
  it('runs each symbol in index order and returns tagged results', async () => {
    const calls: string[] = [];
    const store = fakeStore(
      new Map<string, HookBarMajorSlot>([
        [
          'AAA',
          {
            instance: {
              onBarClose: () => {
                calls.push('AAA');
                return ['SIG'];
              },
            },
            buffer: [],
            oiBuffer: [],
            liqBuffer: [],
          },
        ],
        [
          'BBB',
          {
            instance: {
              onBarClose: () => {
                calls.push('BBB');
                throw new Error('boom');
              },
            },
            buffer: [],
            oiBuffer: [],
            liqBuffer: [],
          },
        ],
      ]),
    );
    const bars = [
      { snapshot: { symbol: 'AAA' }, newBar: null },
      { snapshot: { symbol: 'BBB' }, newBar: null },
    ];
    const r = await runHookBarMajor(bars, 'onBarClose', store, { rehydrateContext, normalize, pickHook });
    expect(calls).toEqual(['AAA', 'BBB']); // sequential, index order
    expect(r.results[0]).toEqual({ ok: true, decisions: ['SIG'] });
    expect(r.results[1].ok).toBe(false); // BBB threw → tagged error, others ran
    expect((r.results[1] as { error: { detail: string } }).error.detail).toContain('boom');
  });

  it('uses an injected classifyError for a thrown entry, proving deny-shim codes carry through', async () => {
    const store = fakeStore(
      new Map<string, HookBarMajorSlot>([
        [
          'AAA',
          {
            instance: {
              onBarClose: () => {
                throw new Error('network access denied');
              },
            },
            buffer: [],
            oiBuffer: [],
            liqBuffer: [],
          },
        ],
      ]),
    );
    const bars = [{ snapshot: { symbol: 'AAA' }, newBar: null }];
    const classifyError = (_e: unknown) => 'sandbox_forbidden_access';
    const r = await runHookBarMajor(bars, 'onBarClose', store, {
      rehydrateContext,
      normalize,
      pickHook,
      classifyError,
    });
    expect(r.results[0].ok).toBe(false);
    expect((r.results[0] as { error: { code: string } }).error.code).toBe('sandbox_forbidden_access');
  });

  it('a missing slot for an entry yields a tagged error for that entry only', async () => {
    const store = fakeStore(
      new Map<string, HookBarMajorSlot>([['AAA', { instance: { onBarClose: () => [] }, buffer: [], oiBuffer: [], liqBuffer: [] }]]),
    );
    const bars = [
      { snapshot: { symbol: 'AAA' }, newBar: null },
      { snapshot: { symbol: 'ZZZ' }, newBar: null },
    ];
    const r = await runHookBarMajor(bars, 'onBarClose', store, { rehydrateContext, normalize, pickHook });
    expect(r.results[0].ok).toBe(true);
    expect(r.results[1].ok).toBe(false);
  });
});
