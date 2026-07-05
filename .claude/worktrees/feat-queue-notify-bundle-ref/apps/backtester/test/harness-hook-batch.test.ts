// Task 3 (17b bar batching) — pure batch-iteration helper, host-side unit test.
//
// `runHookBatch` is imported DIRECTLY (no container, no entry.mjs spawn — entry.mjs imports the
// untrusted bundle from a container-absolute path and cannot run on the host). Fakes: `instance`
// with a scripted per-bar hook answer, identity `rehydrateContext`, `pickHook` returning the fixed
// fn (or undefined for case d), `normalize = (x) => x ?? []` (verbatim per the plan's Testability
// section), and real arrays for the buffers so buffer-advancement is observable.
import { describe, expect, it } from 'vitest';
import { runHookBatch } from '../sandbox-harness-overlay/hook-batch.mjs';

type Bar = { readonly ts: number };
type BatchEntry = { readonly snapshot: unknown; readonly newBar: Bar | null; readonly newOi?: unknown; readonly newLiq?: unknown };

function makeBars(n: number): BatchEntry[] {
  return Array.from({ length: n }, (_, i) => ({ snapshot: { i }, newBar: { ts: i } }));
}

/**
 * Scripted fake harness deps. `answers[i]` is what the fake hook returns on the i-th invocation
 * (bars are processed 0..n-1 in order, so call index === bar index for every bar actually reached).
 * `throwAt` (optional) makes the i-th invocation throw instead of returning.
 */
function makeDeps(opts: { answers?: readonly unknown[]; throwAt?: number; hookPresent?: boolean } = {}) {
  const { answers = [], throwAt, hookPresent = true } = opts;
  const buffer: unknown[] = [];
  const oiBuffer: unknown[] = [];
  const liqBuffer: unknown[] = [];
  const rng = { next: () => 0.5 };
  const calls: unknown[] = [];
  const fn = function onBarClose(this: unknown, ctx: unknown) {
    const i = calls.length;
    calls.push(ctx);
    if (throwAt === i) throw new Error(`boom at bar ${i}`);
    return answers[i];
  };
  const instance = { onBarClose: fn };
  // Identity fake: returns something that carries the CURRENT buffer length so state continuity
  // (buffer.push happens before this is called) is directly observable without a real rehydrator.
  const rehydrateContext = (snapshot: unknown, buf: unknown[]) => ({ snapshot, bufferLenAtRehydrate: buf.length });
  const pickHook = () => (hookPresent ? fn : undefined);
  const normalize = (x: unknown): unknown[] => (x ?? []) as unknown[];
  return { buffer, oiBuffer, liqBuffer, rng, instance, rehydrateContext, pickHook, normalize, calls };
}

describe('runHookBatch (17b — pure harness batch iteration)', () => {
  it('(a) stops on the bar that produces a signal; only executed bars are consumed', async () => {
    const bars = makeBars(5);
    const deps = makeDeps({ answers: [[], [], ['SIGNAL'], ['unreached'], ['unreached']] });

    const result = await runHookBatch(bars, 'onBarClose', deps);

    expect(result).toEqual({ kind: 'ok', stoppedAt: 2, decisions: ['SIGNAL'] });
    // Bars 3..4 never ran — buffer advanced by exactly 3 (entries 0..2), NOT 5.
    expect(deps.buffer.length).toBe(3);
    expect(deps.calls.length).toBe(3);
  });

  it('(b) all-empty batch runs to completion with no decisions', async () => {
    const bars = makeBars(5);
    const deps = makeDeps({ answers: [[], [], [], [], []] });

    const result = await runHookBatch(bars, 'onBarClose', deps);

    expect(result).toEqual({ kind: 'ok', stoppedAt: 4, decisions: [] });
    expect(deps.buffer.length).toBe(5);
  });

  it('(c) a throwing hook returns err with barOffset; the failing bar\'s newBar IS consumed (pushed before invoke)', async () => {
    const bars = makeBars(5);
    const deps = makeDeps({ answers: [[]], throwAt: 1 });

    const result = await runHookBatch(bars, 'onBarClose', deps);

    expect(result.kind).toBe('err');
    expect((result as { barOffset: number }).barOffset).toBe(1);
    expect((result as { cause: Error }).cause).toBeInstanceOf(Error);
    // Boundary contract (pinned here + mirrored host-side in sandbox-session-batch.test.ts): the
    // harness pushes newBar for bar j BEFORE invoking the hook on bar j, so a bar that fails still
    // counted its own newBar. buffer.length === 2 == (bar 0 consumed) + (bar 1's newBar pushed).
    expect(deps.buffer.length).toBe(2);
  });

  it('(d) missing hook (pickHook returns undefined) produces a fully-empty result without calling anything', async () => {
    const bars = makeBars(3);
    const deps = makeDeps({ hookPresent: false });

    const result = await runHookBatch(bars, 'onBarClose', deps);

    expect(result).toEqual({ kind: 'ok', stoppedAt: 2, decisions: [] });
    expect(deps.calls.length).toBe(0);
    // newBar bookkeeping still advances even with no hook — mirrors entry.mjs's existing handleHook.
    expect(deps.buffer.length).toBe(3);
  });
});
