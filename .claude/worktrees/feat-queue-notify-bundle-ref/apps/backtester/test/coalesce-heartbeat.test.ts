import { describe, expect, it, vi } from 'vitest';
import { InMemoryComputeLockStore } from '../src/jobs/coalesce/compute-lock.js';

describe('leader compute-lock heartbeat renew', () => {
  it('renews the active leader lock separately from the job lease', async () => {
    const lock = new InMemoryComputeLockStore();
    await lock.acquire('ci', 'run-A', 'w1', 1000, 100);          // expires 1100
    const renewSpy = vi.spyOn(lock, 'renew');
    // Simulate the heartbeat helper the loop uses: renew all active leader identities to now+ttl.
    const active = new Set(['ci']);
    const beat = async (now: number, ttl: number) => { for (const ci of active) await lock.renew(ci, 'w1', now + ttl); };
    await beat(5000, 100);
    expect(renewSpy).toHaveBeenCalledWith('ci', 'w1', 5100);
    expect((await lock.get('ci'))?.lockExpiresAtMs).toBe(5100);   // extended, no spurious takeover
  });
});
