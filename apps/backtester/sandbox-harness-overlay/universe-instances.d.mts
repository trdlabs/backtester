// Type declaration for universe-instances.mjs — the harness's per-symbol instance-slot store.
// Kept intentionally loose (unknown-heavy): universe-instances.mjs is plain untyped ESM shared
// verbatim between the in-container harness (real closures over live buffers/instance) and the
// host-side unit test — this file exists only so `tsc --noEmit` can typecheck the test import; it
// is NOT part of the sandbox trust boundary (harness code itself stays plain JS, per convention).

export interface InstanceSlot {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- bundle instance shape is caller-defined (test fakes, real hooks)
  instance: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rng: any;
  readonly buffer: unknown[];
  readonly oiBuffer: unknown[];
  readonly liqBuffer: unknown[];
}

export interface InstanceStore {
  get(symbol: string | undefined): InstanceSlot | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ensure(symbol: string | undefined, factory: () => { instance: any; rng: any }): InstanceSlot;
  all(): IterableIterator<InstanceSlot>;
}

export function makeInstanceStore(): InstanceStore;

export function symbolOf(msg: unknown): string | undefined;

export type ResolveInstanceResult =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | { readonly ok: true; readonly instance: any }
  | { readonly ok: false; readonly code: 'bundle_load_failed'; readonly reason: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function resolveInstance(loadedModule: any, opts?: { universe?: boolean }): ResolveInstanceResult;
