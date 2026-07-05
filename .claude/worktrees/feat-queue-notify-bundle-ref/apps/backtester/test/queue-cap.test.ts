// Queue-depth cap → 429 queue_full (rate_limit category, Retry-After) with resumeToken-replay bypass.
// Mirrors idempotency.test.ts fixtures (makeApp/runBody/AUTH) — copy them verbatim.
import { describe, expect, it } from 'vitest';
import type { RunJobHandle } from '@trading/research-contracts';
import { AUTH, makeApp, runBody } from './helpers';
import { STORE_FACTORIES } from './store-factories';

for (const factory of STORE_FACTORIES) {
  describe.skipIf(!factory.available)(`queue cap (${factory.name})`, () => {
    it('429s a NEW submit at the cap: rate_limit category, Retry-After header, nothing persisted', async () => {
      const { app, cleanup } = await makeApp(factory, {}, { queueMaxDepth: 2, queueRetryAfterS: 7 });
      try {
        await app.server.inject({ method: 'POST', url: '/v1/runs', headers: AUTH, payload: runBody({}) });
        await app.server.inject({ method: 'POST', url: '/v1/runs', headers: AUTH, payload: runBody({ seed: 2 }) });
        const third = await app.server.inject({ method: 'POST', url: '/v1/runs', headers: AUTH, payload: runBody({ seed: 3 }) });
        expect(third.statusCode).toBe(429);
        expect(third.headers['retry-after']).toBe('7');
        const body = third.json() as { category: string; code: string; queueDepth: number; maxDepth: number };
        expect(body.category).toBe('rate_limit');
        expect(body.code).toBe('queue_full');
        expect(body.queueDepth).toBeGreaterThanOrEqual(2);
        expect(body.maxDepth).toBe(2);
        // nothing persisted: queue depth still exactly 2 (check AppHandles' shape in src/app.ts —
        // the store is exposed via the handles object, e.g. app.workerDeps.store; adapt the access)
        const stats = await app.workerDeps.store.countQueueStats(Date.now());
        expect(stats.depth).toBe(2);
      } finally {
        await cleanup();
      }
    });

    it('replay with matching resumeToken bypasses the cap', async () => {
      const { app, cleanup } = await makeApp(factory, {}, { queueMaxDepth: 1, queueRetryAfterS: 7 });
      try {
        const payload = runBody({ resumeToken: 'tok-cap' });
        const first = await app.server.inject({ method: 'POST', url: '/v1/runs', headers: AUTH, payload });
        expect(first.statusCode).toBe(202); // fills the queue to the cap
        const replay = await app.server.inject({ method: 'POST', url: '/v1/runs', headers: AUTH, payload });
        expect(replay.statusCode).toBe(202);
        expect((replay.json() as RunJobHandle).idempotentReplay).toBe(true);
      } finally {
        await cleanup();
      }
    });

    it('cap 0 = unlimited (default)', async () => {
      const { app, cleanup } = await makeApp(factory);
      try {
        for (let i = 0; i < 5; i += 1) {
          const r = await app.server.inject({ method: 'POST', url: '/v1/runs', headers: AUTH, payload: runBody({ seed: i }) });
          expect(r.statusCode).toBe(202);
        }
      } finally {
        await cleanup();
      }
    });
  });
}
