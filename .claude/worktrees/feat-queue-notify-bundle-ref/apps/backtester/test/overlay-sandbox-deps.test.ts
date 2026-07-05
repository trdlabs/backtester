// apps/backtester/test/overlay-sandbox-deps.test.ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { overlaySandboxDeps, bundleBaseDir } from '../src/jobs/worker.js';
import { DEFAULT_SANDBOX } from '../src/engine/sandbox-policy.js';

function settings(extra: Record<string, unknown>) {
  return {
    harnessDir: makeHarness(),
    image: DEFAULT_SANDBOX.isolation.image,
    policy: DEFAULT_SANDBOX,
    ...extra,
  } as any;
}
function makeHarness(): string {
  const dir = mkdtempSync(join(tmpdir(), 'btx-h-'));
  writeFileSync(join(dir, 'entry.mjs'), '// entry\n');
  return dir;
}

describe('overlaySandboxDeps', () => {
  it('bind mode (no volume): harnessDir passthrough, no mount', () => {
    const s = settings({});
    const deps = overlaySandboxDeps(s);
    expect(deps.harnessDir).toBe(s.harnessDir);
    expect(deps.mount).toBeUndefined();
    expect(bundleBaseDir(s)).toBeUndefined();
  });

  it('volume mode: harness copied under mountpoint, mount=volume, baseDir under mountpoint', () => {
    const mp = mkdtempSync(join(tmpdir(), 'btx-mp-'));
    const s = settings({ volume: 'btx-sandbox', volumeMountpoint: mp });
    const deps = overlaySandboxDeps(s);
    expect(deps.harnessDir!.startsWith(join(mp, 'harness'))).toBe(true);
    expect(deps.mount).toEqual({ mode: 'volume', volume: 'btx-sandbox', mountpoint: mp });
    expect(bundleBaseDir(s)).toBe(join(mp, 'bundles'));
  });
});
