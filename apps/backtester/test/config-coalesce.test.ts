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

describe('result-cache TTL config (P3-6b)', () => {
  it('unset → resultCacheTtlMs undefined (TTL eviction OFF)', () => {
    expect(loadConfig({} as NodeJS.ProcessEnv).resultCacheTtlMs).toBeUndefined();
    expect(loadConfig({} as NodeJS.ProcessEnv).resultCacheSweepIntervalMs).toBeUndefined();
  });
  it('valid positive integer ms → parsed', () => {
    expect(loadConfig({ BACKTESTER_RESULT_CACHE_TTL_MS: '86400000' } as NodeJS.ProcessEnv).resultCacheTtlMs).toBe(86_400_000);
  });
  it('blank / whitespace → OFF (not an error)', () => {
    expect(loadConfig({ BACKTESTER_RESULT_CACHE_TTL_MS: '' } as NodeJS.ProcessEnv).resultCacheTtlMs).toBeUndefined();
    expect(loadConfig({ BACKTESTER_RESULT_CACHE_TTL_MS: '   ' } as NodeJS.ProcessEnv).resultCacheTtlMs).toBeUndefined();
  });
  it.each(['0', '-1', '1.5', 'NaN', 'Infinity', 'abc'])('fail-fast on invalid TTL "%s"', (bad) => {
    expect(() => loadConfig({ BACKTESTER_RESULT_CACHE_TTL_MS: bad } as NodeJS.ProcessEnv)).toThrow(/positive integer/);
  });
  it('sweep-interval override is validated the same way', () => {
    expect(
      loadConfig({ BACKTESTER_RESULT_CACHE_TTL_MS: '1000', BACKTESTER_RESULT_CACHE_SWEEP_INTERVAL_MS: '5000' } as NodeJS.ProcessEnv).resultCacheSweepIntervalMs,
    ).toBe(5000);
    expect(() =>
      loadConfig({ BACKTESTER_RESULT_CACHE_TTL_MS: '1000', BACKTESTER_RESULT_CACHE_SWEEP_INTERVAL_MS: '-1' } as NodeJS.ProcessEnv),
    ).toThrow(/positive integer/);
  });
});
