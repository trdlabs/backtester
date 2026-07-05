import { describe, expect, it } from 'vitest';
import { toMountSource, mountConfigFor } from '../src/engine/sandbox/mounts.js';

describe('mountConfigFor', () => {
  it('returns bind when neither volume nor mountpoint is set', () => {
    expect(mountConfigFor(undefined, undefined)).toEqual({ mode: 'bind' });
  });
  it('returns volume when both are set', () => {
    expect(mountConfigFor('btx-sandbox', '/sandbox-shared')).toEqual({
      mode: 'volume', volume: 'btx-sandbox', mountpoint: '/sandbox-shared',
    });
  });
  it('throws on half-config (only volume)', () => {
    expect(() => mountConfigFor('btx-sandbox', undefined)).toThrow(/both .* or neither/i);
  });
  it('throws on half-config (only mountpoint)', () => {
    expect(() => mountConfigFor(undefined, '/sandbox-shared')).toThrow(/both .* or neither/i);
  });
});

describe('toMountSource', () => {
  it('bind mode → hostPath passthrough', () => {
    expect(toMountSource({ mode: 'bind' }, '/tmp/btx-bundle-AAA')).toEqual({
      kind: 'bind', hostPath: '/tmp/btx-bundle-AAA',
    });
  });
  it('volume mode → subpath relative to mountpoint', () => {
    const cfg = { mode: 'volume', volume: 'btx-sandbox', mountpoint: '/sandbox-shared' } as const;
    expect(toMountSource(cfg, '/sandbox-shared/bundles/btx-bundle-AAA')).toEqual({
      kind: 'volume', volume: 'btx-sandbox', subpath: 'bundles/btx-bundle-AAA',
    });
  });
  it('volume mode → throws when dir is not under the mountpoint', () => {
    const cfg = { mode: 'volume', volume: 'btx-sandbox', mountpoint: '/sandbox-shared' } as const;
    expect(() => toMountSource(cfg, '/tmp/elsewhere')).toThrow(/under the volume mountpoint/i);
  });
  it('volume mode → throws when dir equals the mountpoint (empty subpath)', () => {
    const cfg = { mode: 'volume', volume: 'btx-sandbox', mountpoint: '/sandbox-shared' } as const;
    expect(() => toMountSource(cfg, '/sandbox-shared')).toThrow(/under the volume mountpoint/i);
  });
  it('volume mode → throws on dotdot traversal', () => {
    const cfg = { mode: 'volume', volume: 'btx-sandbox', mountpoint: '/sandbox-shared' } as const;
    expect(() => toMountSource(cfg, '/sandbox-shared/../other')).toThrow(/under the volume mountpoint/i);
  });
  it('volume mode → throws when the mountpoint is not absolute', () => {
    const cfg = { mode: 'volume', volume: 'btx-sandbox', mountpoint: 'sandbox-shared' } as const;
    expect(() => toMountSource(cfg, 'sandbox-shared/foo')).toThrow(/absolute path/i);
  });
});
