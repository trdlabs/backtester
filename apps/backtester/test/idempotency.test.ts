import { describe, expect, it } from 'vitest';
import type { RunJobHandle } from '@trading/research-contracts';
import { AUTH, makeApp, runBody } from './helpers';
import { STORE_FACTORIES } from './store-factories';

for (const factory of STORE_FACTORIES) {
  describe.skipIf(!factory.available)(`idempotency [${factory.name}]`, () => {
    it('replays the same resumeToken without creating a second run', async () => {
      const { app, cleanup } = await makeApp(factory);
      try {
        const payload = runBody({ resumeToken: 'tok-1' });
        const r1 = await app.server.inject({ method: 'POST', url: '/v1/runs', headers: AUTH, payload });
        const r2 = await app.server.inject({ method: 'POST', url: '/v1/runs', headers: AUTH, payload });

        expect(r1.statusCode).toBe(202);
        expect(r2.statusCode).toBe(202);
        const h1 = r1.json() as RunJobHandle;
        const h2 = r2.json() as RunJobHandle;
        expect(h1.idempotentReplay).toBe(false);
        expect(h2.idempotentReplay).toBe(true);
        expect(h2.runId).toBe(h1.runId);
        expect(h2.requestFingerprint).toBe(h1.requestFingerprint);
      } finally {
        await cleanup();
      }
    });

    it('rejects resumeToken reuse with a different request (409)', async () => {
      const { app, cleanup } = await makeApp(factory);
      try {
        await app.server.inject({
          method: 'POST',
          url: '/v1/runs',
          headers: AUTH,
          payload: runBody({ resumeToken: 'tok-1' }),
        });
        const conflict = await app.server.inject({
          method: 'POST',
          url: '/v1/runs',
          headers: AUTH,
          payload: runBody({ resumeToken: 'tok-1', seed: 99 }),
        });
        expect(conflict.statusCode).toBe(409);
        expect((conflict.json() as { code: string }).code).toBe('resume_token_conflict');
      } finally {
        await cleanup();
      }
    });

    it('rejects an unknown metric (400)', async () => {
      const { app, cleanup } = await makeApp(factory);
      try {
        const r = await app.server.inject({
          method: 'POST',
          url: '/v1/runs',
          headers: AUTH,
          payload: runBody({ metrics: ['not_a_metric'] }),
        });
        expect(r.statusCode).toBe(400);
      } finally {
        await cleanup();
      }
    });
  });
}
