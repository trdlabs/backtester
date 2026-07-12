// Type declaration for hook-bar-major.mjs (Slice B) — the harness's pure per-symbol bar-major
// dispatch helper. Kept intentionally loose (unknown-heavy): hook-bar-major.mjs is plain untyped
// ESM shared verbatim between the in-container harness (real closures over the live per-symbol
// `store`) and host-side unit tests (scripted fakes) — this file exists only so `tsc --noEmit` can
// typecheck the test import; it is NOT part of the sandbox trust boundary (harness code itself
// stays plain JS, per convention — see hook-batch.d.mts, the 17b sibling this mirrors).

export interface HookBarMajorEntry {
  readonly snapshot: { readonly symbol: string } & Record<string, unknown>;
  readonly newBar: unknown;
  readonly newOi?: unknown;
  readonly newLiq?: unknown;
}

export interface HookBarMajorSlot {
  readonly instance: unknown;
  readonly buffer: unknown[];
  readonly oiBuffer: unknown[];
  readonly liqBuffer: unknown[];
  readonly rng?: unknown;
}

export interface HookBarMajorStore {
  get(symbol: string): HookBarMajorSlot | undefined;
}

export interface HookBarMajorDeps {
  readonly rehydrateContext: (
    snapshot: unknown,
    buffer: unknown[],
    rng: unknown,
    oiBuffer: unknown[],
    liqBuffer: unknown[],
  ) => unknown;
  readonly pickHook: (instance: unknown, hook: string) => ((this: unknown, ctx: unknown) => unknown) | undefined;
  readonly normalize: (out: unknown) => unknown[];
  readonly classifyError?: (e: unknown) => string;
}

export type HookBarMajorResult =
  | { readonly ok: true; readonly decisions: unknown[] }
  | { readonly ok: false; readonly error: { readonly code: string; readonly detail: string } };

export function runHookBarMajor(
  bars: readonly HookBarMajorEntry[],
  hook: string,
  store: HookBarMajorStore,
  deps: HookBarMajorDeps,
): Promise<{ readonly results: HookBarMajorResult[] }>;
