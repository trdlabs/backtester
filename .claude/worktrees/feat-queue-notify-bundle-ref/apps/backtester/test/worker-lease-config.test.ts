import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('worker lease config', () => {
  it('defaults', () => {
    const c = loadConfig({} as NodeJS.ProcessEnv);
    expect(c.workerLeaseTtlMs).toBe(30_000);
    expect(c.workerHeartbeatMs).toBe(10_000);
    expect(c.workerMaxAttempts).toBe(3);
    expect(c.workerPollMs).toBe(500);
    expect(c.workerId).toMatch(/.+:\d+$/); // hostname:pid
  });
  it('clamps lease TTL to >= 3x heartbeat', () => {
    const c = loadConfig({ WORKER_LEASE_TTL_MS: '5000', WORKER_HEARTBEAT_MS: '4000' } as NodeJS.ProcessEnv);
    expect(c.workerLeaseTtlMs).toBeGreaterThanOrEqual(3 * c.workerHeartbeatMs);
  });
});
