import { afterEach, describe, expect, it } from 'vitest';
import { startWorkerHealthServer } from '../src/jobs/worker-health.js';
import { ObsRegistry, type JobObsSnapshot } from '../src/jobs/obs-registry.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

const state = { live: () => true, ready: () => true };

describe('worker health /statsz', () => {
  it('serves the ObsRegistry snapshot when a provider is given', async () => {
    const obs = new ObsRegistry(1234);
    const srv = await startWorkerHealthServer(0, state, obs);
    close = srv.close;
    const res = await fetch(`http://127.0.0.1:${srv.port}/statsz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as JobObsSnapshot;
    expect(body.startedAtMs).toBe(1234);
    expect(body.jobs.total).toBe(0);
  });

  it('404s /statsz when no provider is given', async () => {
    const srv = await startWorkerHealthServer(0, state);
    close = srv.close;
    const res = await fetch(`http://127.0.0.1:${srv.port}/statsz`);
    expect(res.status).toBe(404);
  });

  it('adds a queue block when a queueStats provider is given', async () => {
    const obs = new ObsRegistry(1234);
    const srv = await startWorkerHealthServer(0, state, obs, async () => ({ depth: 5, oldestQueuedAgeMs: 1234 }));
    close = srv.close;
    const body = (await (await fetch(`http://127.0.0.1:${srv.port}/statsz`)).json()) as { queue?: unknown };
    expect(body.queue).toEqual({ depth: 5, oldestQueuedAgeMs: 1234 });
  });

  it('degrades the queue block to a bounded error and still serves 200', async () => {
    const obs = new ObsRegistry(1234);
    const srv = await startWorkerHealthServer(0, state, obs, async () => { throw new Error('pg down\nline2'); });
    close = srv.close;
    const res = await fetch(`http://127.0.0.1:${srv.port}/statsz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { queue?: { error?: string } };
    expect(body.queue).toEqual({ error: 'pg down line2' });
  });

  it('omits the queue block when no provider is given (back-compat)', async () => {
    const obs = new ObsRegistry(1234);
    const srv = await startWorkerHealthServer(0, state, obs);
    close = srv.close;
    const body = (await (await fetch(`http://127.0.0.1:${srv.port}/statsz`)).json()) as { queue?: unknown };
    expect(body.queue).toBeUndefined();
  });
});
