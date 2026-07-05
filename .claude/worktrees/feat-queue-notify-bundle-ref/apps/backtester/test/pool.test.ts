import { describe, expect, it } from 'vitest';
import { runBoundedPool } from '../src/jobs/pool.js';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('runBoundedPool', () => {
  it('keeps at most `concurrency` next() calls in flight', async () => {
    const concurrency = 3;
    const total = 8;
    let started = 0;
    let inFlight = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const next = (): Promise<boolean> => {
      if (started >= total) return Promise.resolve(false);
      started += 1;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return new Promise<boolean>((resolve) => {
        releases.push(() => {
          inFlight -= 1;
          resolve(true);
        });
      });
    };
    const done = runBoundedPool(concurrency, next);
    await tick(); // let the pool fill its slots
    expect(inFlight).toBe(concurrency); // exactly `concurrency` active, never more
    while (releases.length > 0) {
      releases.shift()!();
      await tick(); // the freed slot loops and calls next() again
    }
    const processed = await done;
    expect(peak).toBe(concurrency);
    expect(processed).toBe(total);
  });

  it('processes every item exactly once', async () => {
    let remaining = 5;
    let calls = 0;
    const next = async (): Promise<boolean> => {
      calls += 1;
      if (remaining === 0) return false;
      remaining -= 1;
      return true;
    };
    const processed = await runBoundedPool(2, next);
    expect(processed).toBe(5);
    expect(calls).toBeGreaterThanOrEqual(6); // 5 truthy + at least one trailing false
  });

  it('clamps concurrency below 1 up to 1', async () => {
    let remaining = 3;
    const next = async (): Promise<boolean> => remaining-- > 0;
    const processed = await runBoundedPool(0, next);
    expect(processed).toBe(3);
  });

  it('surfaces a next() rejection (does not swallow infra errors)', async () => {
    let calls = 0;
    const next = async (): Promise<boolean> => {
      calls += 1;
      if (calls === 2) throw new Error('infra blip');
      return calls < 5;
    };
    await expect(runBoundedPool(1, next)).rejects.toThrow('infra blip');
  });

  it('lets a sibling slot finish when another slot throws', async () => {
    let siblingDone = false;
    let calls = 0;
    const next = async (): Promise<boolean> => {
      const n = calls++;
      if (n === 0) throw new Error('blip'); // slot A: immediate throw
      if (n === 1) {
        await new Promise((r) => setTimeout(r, 20));
        siblingDone = true;
        return false; // slot B: slow work, then drains
      }
      return false;
    };
    await expect(runBoundedPool(2, next)).rejects.toThrow('blip');
    expect(siblingDone).toBe(true); // sibling completed despite slot A throwing
  });

  it('treats a non-finite concurrency as a single slot', async () => {
    let remaining = 3;
    const next = async (): Promise<boolean> => remaining-- > 0;
    const processed = await runBoundedPool(Number.NaN, next);
    expect(processed).toBe(3);
  });
});
