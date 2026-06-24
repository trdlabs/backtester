// 019 hardening — a fail-closed sandbox apply must be OBSERVABLE, not silent.
//
// The sandbox executor fail-closes ([] + a collected SandboxErrorArtifact) when an untrusted overlay
// hook cannot run (FR-025). Before this guard the fail-close was also SILENT: the host returned [],
// the run continued, and the overlay variant degraded to baseline behaviour → all-zero metric deltas
// downstream — hard to attribute after the fact. `SandboxModuleExecutor.record()` now also emits a
// structured `console.warn`. These tests pin that behaviour WITHOUT needing Docker, by injecting a
// driver whose session spawn always throws (the same fail-close path a missing/broken daemon takes).
//
// The clean (success) path — record() NOT called, no warning — is covered by the Docker-gated
// overlay-engine / overlay-sandbox-session suites; here we add the deterministic, daemon-free FAILURE
// half plus a construction guard that the warning is tied to a fail-close, not to wiring.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  HypothesisOverlayModule,
  ModuleManifest,
  StrategyContext,
} from '@trading/research-contracts/research';
import { SandboxModuleExecutor } from '../src/engine/sandbox/sandbox-executor.js';
import { DockerDriver } from '../src/engine/sandbox/docker-driver.js';
import { DEFAULT_SANDBOX } from '../src/engine/sandbox-policy.js';
import type { ModuleBundle } from '../src/engine/sandbox/bundle.js';

/**
 * A DockerDriver whose session spawn always throws — `SandboxSession.open()` catches it and
 * fail-closes with `sandbox_crashed`, exactly as a missing/broken Docker daemon would, with no
 * real container. `kill`/`remove` are never reached (the container is never assigned).
 */
class ThrowingDriver extends DockerDriver {
  override spawnSession(): never {
    throw new Error('docker spawn boom (test)');
  }
}

/**
 * Minimal host-side overlay bundle double. The fail-close path reads only
 * `manifest.{id,version,kind,hooks}` and `bundleDir` (handed to `spawnSession`, which throws before
 * it is used); `descriptor` is never reached. The manifest is cast (its full 017 shape is irrelevant
 * to this path); everything else is honestly typed.
 */
const bundle: ModuleBundle = {
  bundleDir: '/nonexistent/test-overlay-bundle',
  manifest: { id: 'test_overlay', version: '1.0.0', kind: 'overlay', hooks: ['apply'] } as unknown as ModuleManifest,
  descriptor: {
    contractVersion: '1.0.0',
    kind: 'overlay',
    entryPoint: 'module/index.js',
    files: [],
    bundleHash: 'sha256:0',
  },
};

// The apply path reads only ctx.run.{runId,seed}, ctx.symbol and ctx.params before fail-closing on
// open() — the rest of StrategyContext (bar/market/...) is never touched, so a minimal double is safe.
const ctx = {
  run: { runId: 'run-test-1', seed: 1 },
  symbol: 'BTCUSDT',
  params: {},
} as unknown as StrategyContext;

// `executeOverlayApply` ignores its overlay argument (it drives the sandboxed `apply` hook by ctx).
const overlay = {} as unknown as HypothesisOverlayModule;

describe('sandbox apply observability (fail-close is not silent)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fail-closes to [] AND logs a structured warning when the sandbox cannot start', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const executor = new SandboxModuleExecutor(bundle, DEFAULT_SANDBOX, { driver: new ThrowingDriver() });

    const decisions = await executor.executeOverlayApply(overlay, ctx);

    // Fail-closed: nothing leaks into the host run.
    expect(decisions).toEqual([]);

    // Still collected for diagnostics (US6) — the artifact is unchanged.
    expect(executor.errors).toHaveLength(1);
    expect(executor.errors[0]).toMatchObject({
      code: 'sandbox_crashed',
      severity: 'error',
      symbol: 'BTCUSDT',
      runId: 'run-test-1',
      moduleRef: { id: 'test_overlay', version: '1.0.0' },
    });

    // Now ALSO observable: a single structured warning carrying the code + identifying context.
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0] ?? '');
    expect(line).toContain('[sandbox] fail-closed');
    expect(line).toContain('module=test_overlay@1.0.0');
    expect(line).toContain('symbol=BTCUSDT');
    expect(line).toContain('run=run-test-1');
    expect(line).toContain('code=sandbox_crashed');
  });

  it('does not log on construction — the warning is tied to a fail-close, not to wiring', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const executor = new SandboxModuleExecutor(bundle, DEFAULT_SANDBOX, { driver: new ThrowingDriver() });

    expect(executor.errors).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});
