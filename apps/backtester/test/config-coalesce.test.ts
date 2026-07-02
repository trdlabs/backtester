import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('coalescing config', () => {
  it('coalesceEnabled defaults false, true only for "true"', () => {
    expect(loadConfig({} as NodeJS.ProcessEnv).coalesceEnabled).toBe(false);
    expect(loadConfig({ BACKTESTER_COALESCE_ENABLED: 'true' } as NodeJS.ProcessEnv).coalesceEnabled).toBe(true);
    expect(loadConfig({ BACKTESTER_COALESCE_ENABLED: '1' } as NodeJS.ProcessEnv).coalesceEnabled).toBe(false);
  });
  it('lock ttl + wait cap have defaults, overridable', () => {
    const d = loadConfig({} as NodeJS.ProcessEnv);
    expect(d.computeLockTtlMs).toBe(d.workerLeaseTtlMs);   // default = worker lease ttl
    expect(d.computeWaitMaxAttempts).toBe(3);
    const o = loadConfig({ BACKTESTER_COMPUTE_LOCK_TTL_MS: '45000', BACKTESTER_COMPUTE_WAIT_MAX_ATTEMPTS: '5' } as NodeJS.ProcessEnv);
    expect(o.computeLockTtlMs).toBe(45000);
    expect(o.computeWaitMaxAttempts).toBe(5);
  });
});
