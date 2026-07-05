import { describe, expect, it } from 'vitest';
import { buildDockerRunArgs } from '../src/engine/sandbox/docker-driver.js';
import { DEFAULT_SANDBOX } from '../src/engine/sandbox-policy.js';

const LOCKDOWN = [
  '--network', 'none', '--read-only', '--cap-drop', 'ALL',
  '--security-opt', 'no-new-privileges', '--user', DEFAULT_SANDBOX.isolation.user,
];

describe('buildDockerRunArgs — bind mode (host-process / dev)', () => {
  const args = buildDockerRunArgs(DEFAULT_SANDBOX, {
    name: 'sbx-run1',
    bundle: { kind: 'bind', hostPath: '/tmp/btx-bundle-AAA' },
    harness: { kind: 'bind', hostPath: '/app/apps/backtester/sandbox-harness-overlay' },
  });
  it('emits the legacy -v :ro bind-mounts for bundle and harness', () => {
    expect(args).toContain('/tmp/btx-bundle-AAA:/sandbox/bundle:ro');
    expect(args).toContain('/app/apps/backtester/sandbox-harness-overlay:/sandbox/harness:ro');
  });
  it('preserves every lockdown flag and the harness entrypoint', () => {
    expect(args).toEqual(expect.arrayContaining(LOCKDOWN));
    expect(args).toContain('--disallow-code-generation-from-strings');
    expect(args).toContain('/sandbox/harness/entry.mjs');
    expect(args).not.toContain('--rm');
  });
});

describe('buildDockerRunArgs — volume mode (DooD / demo)', () => {
  const args = buildDockerRunArgs(DEFAULT_SANDBOX, {
    name: 'sbx-run1',
    bundle: { kind: 'volume', volume: 'btx-sandbox', subpath: 'bundles/btx-bundle-AAA' },
    harness: { kind: 'volume', volume: 'btx-sandbox', subpath: 'harness/deadbeef' },
  });
  it('emits volume-subpath --mount for bundle and harness, readonly', () => {
    expect(args).toContain('type=volume,src=btx-sandbox,dst=/sandbox/bundle,volume-subpath=bundles/btx-bundle-AAA,readonly');
    expect(args).toContain('type=volume,src=btx-sandbox,dst=/sandbox/harness,volume-subpath=harness/deadbeef,readonly');
  });
  it('does NOT emit any host bind-mount for bundle or harness', () => {
    expect(args.some((a) => a.endsWith(':/sandbox/bundle:ro'))).toBe(false);
    expect(args.some((a) => a.endsWith(':/sandbox/harness:ro'))).toBe(false);
  });
  it('preserves every lockdown flag', () => {
    expect(args).toEqual(expect.arrayContaining(LOCKDOWN));
    expect(args).toContain('--disallow-code-generation-from-strings');
    expect(args).not.toContain('--rm');
  });
});
