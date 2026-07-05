import { describe, expect, it } from 'vitest';
import { DEFAULT_SANDBOX, EVIDENCE_LONG_SANDBOX, SANDBOX_POLICIES } from '../src/engine/sandbox-policy.js';

describe('evidence_long sandbox policy', () => {
  it('raises ONLY maxStdoutBytes and wallTimeMsPerSession vs default', () => {
    expect(EVIDENCE_LONG_SANDBOX.id).toBe('evidence_long');
    expect(EVIDENCE_LONG_SANDBOX.limits.maxStdoutBytes).toBe(2_097_152);
    expect(EVIDENCE_LONG_SANDBOX.limits.wallTimeMsPerSession).toBe(300_000);
    // the raised caps must actually be larger than the default
    expect(EVIDENCE_LONG_SANDBOX.limits.maxStdoutBytes).toBeGreaterThan(DEFAULT_SANDBOX.limits.maxStdoutBytes);
    expect(EVIDENCE_LONG_SANDBOX.limits.wallTimeMsPerSession).toBeGreaterThan(DEFAULT_SANDBOX.limits.wallTimeMsPerSession);
  });

  it('leaves isolation and the other quotas byte-identical to default (no security relaxation)', () => {
    expect(EVIDENCE_LONG_SANDBOX.isolation).toEqual(DEFAULT_SANDBOX.isolation);
    expect(EVIDENCE_LONG_SANDBOX.limits.cpus).toBe(DEFAULT_SANDBOX.limits.cpus);
    expect(EVIDENCE_LONG_SANDBOX.limits.memoryBytes).toBe(DEFAULT_SANDBOX.limits.memoryBytes);
    expect(EVIDENCE_LONG_SANDBOX.limits.wallTimeMsPerCall).toBe(DEFAULT_SANDBOX.limits.wallTimeMsPerCall);
    expect(EVIDENCE_LONG_SANDBOX.limits.maxStderrBytes).toBe(DEFAULT_SANDBOX.limits.maxStderrBytes);
    expect(EVIDENCE_LONG_SANDBOX.limits.maxDecisionBytes).toBe(DEFAULT_SANDBOX.limits.maxDecisionBytes);
  });

  it('is resolvable from the shipped registry by id@version', () => {
    expect(SANDBOX_POLICIES.resolve({ id: 'evidence_long', version: '1.0.0' })).toBe(EVIDENCE_LONG_SANDBOX);
  });
});
