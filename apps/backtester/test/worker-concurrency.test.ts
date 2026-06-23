import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildTestApp, runBody, AUTH } from './helpers.js';
import type { AppHandles } from '../src/app.js';

describe('WORKER_CONCURRENCY config', () => {
  it('defaults to 4 when unset', () => {
    const cfg = loadConfig({ ...process.env, WORKER_CONCURRENCY: undefined });
    expect(cfg.workerConcurrency).toBe(4);
  });
  it('parses an explicit value', () => {
    const cfg = loadConfig({ ...process.env, WORKER_CONCURRENCY: '8' });
    expect(cfg.workerConcurrency).toBe(8);
  });
  it('clamps values below 1 up to 1', () => {
    const cfg = loadConfig({ ...process.env, WORKER_CONCURRENCY: '0' });
    expect(cfg.workerConcurrency).toBe(1);
  });
});

/** Submit N distinct-seed momentum jobs, drain, return a {seed -> resultHash} map. */
async function drainSweep(concurrency: number, n: number): Promise<Map<number, string>> {
  const app: AppHandles = await buildTestApp({ workerConcurrency: concurrency });
  try {
    const runIdToSeed = new Map<string, number>();
    for (let seed = 0; seed < n; seed += 1) {
      const res = await app.server.inject({
        method: 'POST',
        url: '/v1/runs',
        headers: AUTH,
        payload: runBody({ seed, runId: `sweep-seed-${seed}` }),
      });
      expect(res.statusCode).toBe(202);
      const runId = (res.json() as { runId: string }).runId;
      runIdToSeed.set(runId, seed);
    }
    const processed = await app.drain();
    expect(processed).toBe(n); // all jobs drained

    const bySeed = new Map<number, string>();
    for (const [runId, seed] of runIdToSeed) {
      const job = await app.store.get(runId);
      expect(job?.status).toBe('completed');
      bySeed.set(seed, String(job!.resultHash));
    }
    return bySeed;
  } finally {
    await app.dispose();
  }
}

describe('determinism under concurrency', () => {
  it('parallel drain produces the same result hashes as serial drain', async () => {
    const N = 6;
    const serial = await drainSweep(1, N);
    const parallel = await drainSweep(4, N);
    expect(parallel.size).toBe(N);
    for (const [seed, hash] of serial) {
      expect(parallel.get(seed)).toBe(hash); // identical result per job, regardless of concurrency
    }
  });
});
