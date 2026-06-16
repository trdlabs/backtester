import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { RunJobHandle } from '@trading/research-contracts';
import { AUTH, buildTestApp, runBody, testDeps } from './helpers';
import { createPgSchema, PG_AVAILABLE } from './store-factories';

describe.skipIf(!PG_AVAILABLE)('idempotency survives process restart [postgres]', () => {
  it('re-submit after recreating the store over the same DB → idempotentReplay, no new run', async () => {
    const ctx = await createPgSchema();
    try {
      const payload = runBody({ resumeToken: 'restart-tok' });

      // First "process": submit and accept the run, then dispose the whole app (drop the store).
      const app1 = await buildTestApp({}, testDeps({ store: ctx.makeStore(), uid: () => randomUUID() }));
      const h1 = (
        await app1.server.inject({ method: 'POST', url: '/v1/runs', headers: AUTH, payload })
      ).json() as RunJobHandle;
      expect(h1.idempotentReplay).toBe(false);
      await app1.dispose();

      // Second "process": brand-new store over the SAME database; same submit must be a replay.
      const store2 = ctx.makeStore();
      const app2 = await buildTestApp({}, testDeps({ store: store2, uid: () => randomUUID() }));
      const h2 = (
        await app2.server.inject({ method: 'POST', url: '/v1/runs', headers: AUTH, payload })
      ).json() as RunJobHandle;

      expect(h2.idempotentReplay).toBe(true);
      expect(h2.runId).toBe(h1.runId);

      const persisted = (await store2.list()).filter((j) => j.resumeToken === 'restart-tok');
      expect(persisted.length).toBe(1);

      await app2.dispose();
    } finally {
      await ctx.teardown();
    }
  });
});
