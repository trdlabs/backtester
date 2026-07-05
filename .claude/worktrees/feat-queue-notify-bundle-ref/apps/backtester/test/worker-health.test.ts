import { describe, expect, it } from 'vitest';
import { startWorkerHealthServer } from '../src/jobs/worker-health';

async function statusOf(base: string, path: string): Promise<number> {
  return (await fetch(`${base}${path}`)).status;
}

describe('worker health server', () => {
  it('/healthz and /readyz reflect the state functions', async () => {
    let live = true;
    let ready = true;
    const server = await startWorkerHealthServer(0, { live: () => live, ready: () => ready });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      expect(await statusOf(base, '/healthz')).toBe(200);
      expect(await statusOf(base, '/readyz')).toBe(200);

      ready = false; // simulate SIGTERM draining: readiness drops, liveness stays up
      expect(await statusOf(base, '/readyz')).toBe(503);
      expect(await statusOf(base, '/healthz')).toBe(200);

      live = false; // loop fully resolved
      expect(await statusOf(base, '/healthz')).toBe(503);

      expect(await statusOf(base, '/nope')).toBe(404);
    } finally {
      await server.close();
    }
  });
});
