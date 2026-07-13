// Type declaration for deny-shims.mjs — the harness's defense-in-depth shims (child_process / env
// deny) plus the P1-4 stdio isolation. Kept intentionally loose (unknown-heavy): deny-shims.mjs is
// plain untyped ESM that runs in-container; this file exists only so `tsc --noEmit` can typecheck the
// host-side unit test import. It is NOT part of the sandbox trust boundary (harness code stays plain
// JS, per convention — see hook-batch.d.mts).

export function installDenyShims(): void;

export function classifyError(e: unknown): string;

export interface StdioIsolationOptions {
  /** A dead/ended Readable handed to the untrusted bundle as `process.stdin` (no request-wire peek). */
  readonly deadStdin?: unknown;
}

export function isolateStdio(
  proc: unknown,
  con: unknown,
  opts?: StdioIsolationOptions,
): { readonly realWrite: (s: string) => boolean };
