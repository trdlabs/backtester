import { describe, expect, it } from 'vitest';
import type {
  ArtifactManifest,
  ArtifactPage,
  RunJobHandle,
  RunResultSummary,
  RunStatusView,
} from '@trading/research-contracts';
import { AUTH, makeApp, runBody } from './helpers';
import { STORE_FACTORIES } from './store-factories';

// Same inputs as the determinism golden (test/determinism.test.ts), incl. runId — so the end-to-end
// result_hash must equal that golden regardless of the store backend.
const GOLDEN_RESULT_HASH = 'sha256:eff10116147933c96d92ae50071ef66339467fb69545c38855dcd50c2c0b43ba';

for (const factory of STORE_FACTORIES) {
  describe.skipIf(!factory.available)(`api e2e [${factory.name}]`, () => {
    it('submit -> drain -> status -> result -> artifacts', async () => {
      const { app, cleanup } = await makeApp(factory);
      try {
        const submit = await app.server.inject({
          method: 'POST',
          url: '/v1/runs',
          headers: AUTH,
          payload: runBody({ runId: 'det-run' }),
        });
        expect(submit.statusCode).toBe(202);
        expect((submit.json() as RunJobHandle).status).toBe('accepted');

        const queued = (
          await app.server.inject({ url: '/v1/runs/det-run/status', headers: AUTH })
        ).json() as RunStatusView;
        expect(queued.status).toBe('queued');

        expect(await app.drain()).toBe(1);

        const done = (
          await app.server.inject({ url: '/v1/runs/det-run/status', headers: AUTH })
        ).json() as RunStatusView;
        expect(done.status).toBe('completed');

        const result = (
          await app.server.inject({ url: '/v1/runs/det-run/result', headers: AUTH })
        ).json() as RunResultSummary;
        expect(result.metrics.total_bars).toBeGreaterThan(0);
        // Golden result_hash is identical regardless of store backend (Slice 1 invariant holds).
        expect(result.resultHash).toBe(GOLDEN_RESULT_HASH);
        expect(result.evidence.datasetFingerprint).toMatch(/^sha256:/);

        const manifest = (
          await app.server.inject({ url: '/v1/runs/det-run/artifacts', headers: AUTH })
        ).json() as ArtifactManifest;
        expect(manifest.descriptors.length).toBeGreaterThanOrEqual(3);

        const trades = manifest.descriptors.find((d) => d.artifactType === 'trades');
        expect(trades).toBeDefined();
        const page = (
          await app.server.inject({
            url: `/v1/runs/det-run/artifacts/${trades!.contentHash}`,
            headers: AUTH,
          })
        ).json() as ArtifactPage;
        expect(Array.isArray(page.page)).toBe(true);
        expect(page.artifactType).toBe('trades');
      } finally {
        await cleanup();
      }
    });

    it('rejects requests without a bearer token (401)', async () => {
      const { app, cleanup } = await makeApp(factory);
      try {
        const r = await app.server.inject({ method: 'POST', url: '/v1/runs', payload: runBody() });
        expect(r.statusCode).toBe(401);
      } finally {
        await cleanup();
      }
    });

    it('cancels a queued run', async () => {
      const { app, cleanup } = await makeApp(factory);
      try {
        await app.server.inject({
          method: 'POST',
          url: '/v1/runs',
          headers: AUTH,
          payload: runBody({ runId: 'c-1' }),
        });
        const cancel = await app.server.inject({
          method: 'POST',
          url: '/v1/runs/c-1/cancel',
          headers: AUTH,
        });
        expect((cancel.json() as RunStatusView).status).toBe('canceled');
      } finally {
        await cleanup();
      }
    });

    it('reports capabilities', async () => {
      const { app, cleanup } = await makeApp(factory);
      try {
        const caps = (await app.server.inject({ url: '/v1/capabilities', headers: AUTH })).json() as {
          contractVersion: string;
        };
        expect(caps.contractVersion).toBe('017.2');
      } finally {
        await cleanup();
      }
    });
  });
}
