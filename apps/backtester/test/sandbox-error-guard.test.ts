// P0: a sandboxed run degrades internal hook failures to `idle` and only RECORDS the error on the
// router (sandbox-executor.ts). If the worker never inspects router.errors(), a crashed/OOM container
// finalizes as `completed` with truncated trades AND poisons the dedup cache. `assertSandboxClean`
// is the guard (mirrors the evidence driver's H1 check) that turns recorded sandbox errors into a
// hard RunnerError BEFORE finalize/cache. See CODE-REVIEW-2026-07-12.md P0-1.

import { describe, expect, it } from 'vitest';
import { assertSandboxClean } from '../src/jobs/worker.js';
import { RunnerError } from '../src/runner/errors.js';
import type { ExecutorRouter } from '../src/engine/sandbox/routing.js';

const routerWith = (errs: unknown[]): ExecutorRouter =>
  ({ errors: () => errs }) as unknown as ExecutorRouter;

describe('assertSandboxClean', () => {
  it('throws RunnerError(sandbox_error) when the router recorded ≥1 error', () => {
    const router = routerWith([{ kind: 'sandbox_module_error', message: 'container OOM' }]);
    expect(() => assertSandboxClean(router)).toThrow(RunnerError);
    try {
      assertSandboxClean(router);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(RunnerError);
      expect((e as RunnerError).code).toBe('sandbox_error');
      expect((e as RunnerError).terminalStatus).toBe('failed');
    }
  });

  it('is a no-op when the router recorded no errors', () => {
    expect(() => assertSandboxClean(routerWith([]))).not.toThrow();
  });

  it('is a no-op when there is no router (trusted / momentum path)', () => {
    expect(() => assertSandboxClean(undefined)).not.toThrow();
  });
});
