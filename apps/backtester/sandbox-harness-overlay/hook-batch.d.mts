// Type declaration for hook-batch.mjs (17b) — the harness's pure batch-iteration helper. Kept
// intentionally loose (unknown-heavy): hook-batch.mjs is plain untyped ESM shared verbatim between
// the in-container harness (real closures over live buffers/instance) and host-side unit tests
// (scripted fakes) — this file exists only so `tsc --noEmit` can typecheck the test import; it is
// NOT part of the sandbox trust boundary (harness code itself stays plain JS, per convention).

export interface HookBatchIterationEntry {
  readonly snapshot: unknown;
  readonly newBar: unknown;
  readonly newOi?: unknown;
  readonly newLiq?: unknown;
}

export interface HookBatchDeps {
  readonly buffer: unknown[];
  readonly oiBuffer: unknown[];
  readonly liqBuffer: unknown[];
  readonly rng: unknown;
  readonly instance: unknown;
  readonly rehydrateContext: (
    snapshot: unknown,
    buffer: unknown[],
    rng: unknown,
    oiBuffer: unknown[],
    liqBuffer: unknown[],
  ) => unknown;
  readonly pickHook: (hook: string) => ((this: unknown, ctx: unknown) => unknown) | undefined;
  readonly normalize: (out: unknown) => unknown[];
}

export type HookBatchOutcome =
  | { readonly kind: 'ok'; readonly stoppedAt: number; readonly decisions: unknown[] }
  | { readonly kind: 'err'; readonly barOffset: number; readonly cause: unknown };

export function runHookBatch(
  bars: readonly HookBatchIterationEntry[],
  hook: string,
  deps: HookBatchDeps,
): Promise<HookBatchOutcome>;
