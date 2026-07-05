import { describe, expect, it } from 'vitest';
import { DEFAULT_SANDBOX } from '../src/engine/sandbox-policy.js';
import { deriveUniversePolicy } from '../src/engine/sandbox/universe-policy.js';

const MiB = 1024 * 1024;

describe('deriveUniversePolicy', () => {
  it('scales memory = (base + k×N) MiB and session wall-time × N; leaves the rest intact', () => {
    const p = deriveUniversePolicy(DEFAULT_SANDBOX, 10, { memBaseMb: 128, memPerSymbolMb: 8 });
    expect(p.limits.memoryBytes).toBe((128 + 8 * 10) * MiB); // 208 MiB
    expect(p.limits.wallTimeMsPerSession).toBe(30_000 * 10);
    expect(p.limits.wallTimeMsPerCall).toBe(DEFAULT_SANDBOX.limits.wallTimeMsPerCall); // unchanged
    expect(p.limits.cpus).toBe(DEFAULT_SANDBOX.limits.cpus);
    expect(p.isolation).toEqual(DEFAULT_SANDBOX.isolation); // isolation untouched (no sandbox weakening)
  });
  it('N=1 still scales cleanly', () => {
    const p = deriveUniversePolicy(DEFAULT_SANDBOX, 1, { memBaseMb: 128, memPerSymbolMb: 8 });
    expect(p.limits.memoryBytes).toBe((128 + 8) * MiB);
  });
});
