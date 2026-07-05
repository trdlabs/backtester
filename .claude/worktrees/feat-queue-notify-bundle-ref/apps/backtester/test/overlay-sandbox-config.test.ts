import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { SANDBOX_IMAGE, DEFAULT_SANDBOX } from '../src/engine/sandbox-policy';

describe('overlaySandbox config', () => {
  it('defaults the overlay image to the pinned digest and the policy to DEFAULT_SANDBOX', () => {
    const c = loadConfig({});
    expect(c.overlaySandbox.image).toBe(SANDBOX_IMAGE);
    expect(c.overlaySandbox.image).toMatch(/@sha256:[0-9a-f]{64}$/); // digest-pinned, not a floating tag
    expect(c.overlaySandbox.policy.isolation.image).toBe(SANDBOX_IMAGE);
    expect(c.overlaySandbox.harnessDir).toMatch(/sandbox-harness-overlay$/);
    // wall-time defaults track the lifted policy:
    expect(c.overlaySandbox.policy.limits.wallTimeMsPerCall).toBe(DEFAULT_SANDBOX.limits.wallTimeMsPerCall);
    expect(c.overlaySandbox.policy.limits.wallTimeMsPerSession).toBe(
      DEFAULT_SANDBOX.limits.wallTimeMsPerSession,
    );
    expect(c.overlaySandbox.policy.limits.memoryBytes).toBe(DEFAULT_SANDBOX.limits.memoryBytes);
  });

  it('honours BACKTESTER_SANDBOX_OVERLAY_IMAGE override', () => {
    const c = loadConfig({ BACKTESTER_SANDBOX_OVERLAY_IMAGE: 'node:24-bookworm-slim@sha256:' + 'a'.repeat(64) });
    expect(c.overlaySandbox.policy.isolation.image).toBe('node:24-bookworm-slim@sha256:' + 'a'.repeat(64));
    expect(c.overlaySandbox.image).toBe('node:24-bookworm-slim@sha256:' + 'a'.repeat(64));
  });

  it('honours BACKTESTER_SANDBOX_OVERLAY_HARNESS_DIR override', () => {
    const c = loadConfig({ BACKTESTER_SANDBOX_OVERLAY_HARNESS_DIR: '/custom/overlay-harness' });
    expect(c.overlaySandbox.harnessDir).toBe('/custom/overlay-harness');
  });

  it('applies per-call/per-session/memory/cpus/pids limit overrides onto DEFAULT_SANDBOX', () => {
    const c = loadConfig({
      BACKTESTER_SANDBOX_OVERLAY_WALL_MS_PER_CALL: '5000',
      BACKTESTER_SANDBOX_OVERLAY_WALL_MS_PER_SESSION: '60000',
      BACKTESTER_SANDBOX_OVERLAY_MEMORY_MB: '96',
      BACKTESTER_SANDBOX_OVERLAY_CPUS: '2',
      BACKTESTER_SANDBOX_OVERLAY_PIDS: '32',
    });
    expect(c.overlaySandbox.policy.limits.wallTimeMsPerCall).toBe(5000);
    expect(c.overlaySandbox.policy.limits.wallTimeMsPerSession).toBe(60000);
    expect(c.overlaySandbox.policy.limits.memoryBytes).toBe(96 * 1024 * 1024);
    expect(c.overlaySandbox.policy.limits.cpus).toBe(2);
    expect(c.overlaySandbox.policy.isolation.pidsLimit).toBe(32);
    // image still pinned; isolation kept intact under PIDS override:
    expect(c.overlaySandbox.policy.isolation.image).toBe(SANDBOX_IMAGE);
    expect(c.overlaySandbox.policy.isolation.network).toBe('none');
  });

  it('leaves the Slice-3 sandbox block untouched (separate config)', () => {
    const c = loadConfig({});
    expect(c.sandbox.harnessDir).toMatch(/sandbox-harness$/);
    expect(c.sandbox.harnessDir).not.toMatch(/sandbox-harness-overlay$/);
  });

  it('defaults volume + volumeMountpoint to undefined (bind mode)', () => {
    const c = loadConfig({});
    expect(c.overlaySandbox.volume).toBeUndefined();
    expect(c.overlaySandbox.volumeMountpoint).toBeUndefined();
  });

  it('reads BACKTESTER_SANDBOX_OVERLAY_VOLUME + _VOLUME_MOUNTPOINT (volume mode)', () => {
    const c = loadConfig({
      BACKTESTER_SANDBOX_OVERLAY_VOLUME: 'btx-sandbox',
      BACKTESTER_SANDBOX_OVERLAY_VOLUME_MOUNTPOINT: '/sandbox-shared',
    });
    expect(c.overlaySandbox.volume).toBe('btx-sandbox');
    expect(c.overlaySandbox.volumeMountpoint).toBe('/sandbox-shared');
  });

  it('fails fast on half-config (volume set, mountpoint missing)', () => {
    expect(() => loadConfig({ BACKTESTER_SANDBOX_OVERLAY_VOLUME: 'btx-sandbox' })).toThrow(
      /both .* or neither/i,
    );
  });

  it('fails fast on half-config (mountpoint set, volume missing)', () => {
    expect(() =>
      loadConfig({ BACKTESTER_SANDBOX_OVERLAY_VOLUME_MOUNTPOINT: '/sandbox-shared' }),
    ).toThrow(/both .* or neither/i);
  });
});
