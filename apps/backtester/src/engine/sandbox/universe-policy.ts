import type { SandboxPolicy } from '../sandbox-policy.js';

const MiB = 1024 * 1024;

/**
 * Derive a universe-session policy: memory grows with the symbol count N and the session wall-time
 * budget scales with N (the one container runs all N symbols sequentially). Isolation, cpus, per-call
 * wall-time and byte caps are unchanged — this never weakens the sandbox.
 */
export function deriveUniversePolicy(
  base: SandboxPolicy,
  n: number,
  opts: { memBaseMb: number; memPerSymbolMb: number; perSymbolSessionMs?: number },
): SandboxPolicy {
  const perSymbolSessionMs = opts.perSymbolSessionMs ?? base.limits.wallTimeMsPerSession;
  return {
    ...base,
    limits: {
      ...base.limits,
      memoryBytes: (opts.memBaseMb + opts.memPerSymbolMb * n) * MiB,
      wallTimeMsPerSession: perSymbolSessionMs * n,
    },
  };
}
