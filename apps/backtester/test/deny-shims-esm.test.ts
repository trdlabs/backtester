// P3-2: installDenyShims patches the CJS child_process exports, but a bundle using an ESM named import
// (`import { spawn } from 'node:child_process'`) binds to the ESM namespace, whose exports are a SNAPSHOT
// taken at materialization time. Without module.syncBuiltinESMExports() after patching, an already-
// materialized ESM binding keeps the ORIGINAL spawn — the shim silently misses the ESM path. See
// CODE-REVIEW-2026-07-12 P3-2. (Container flags remain the real boundary; this is defense-in-depth.)
//
// NOTE: this test mutates process-global builtins (child_process, process.env) — vitest isolates test
// FILES in separate workers, so the mutation is contained here; process.env is restored afterEach.

import { afterEach, describe, expect, it } from 'vitest';
import { installDenyShims } from '../sandbox-harness-overlay/deny-shims.mjs';

const originalEnv = process.env;
afterEach(() => {
  Object.defineProperty(process, 'env', { value: originalEnv, configurable: true, writable: true, enumerable: true });
});

describe('installDenyShims — ESM named-import coverage (P3-2)', () => {
  it('blocks child_process spawn on an ALREADY-materialized ESM binding, not just require()', async () => {
    // Materialize the ESM namespace BEFORE the shims — this is the case syncBuiltinESMExports must fix.
    const cp = await import('node:child_process');

    installDenyShims();

    // ESM named import path: the pre-materialized binding must now be the deny shim.
    expect(() => cp.spawn('true')).toThrow();
    expect(() => cp.spawnSync('true')).toThrow();
    expect(() => cp.execSync('true')).toThrow();
    expect(() => cp.exec('true')).toThrow();
    expect(() => cp.fork('x')).toThrow();
  });
});
