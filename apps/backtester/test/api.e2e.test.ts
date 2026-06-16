import { describe, expect, it } from 'vitest';
import type {
  ArtifactManifest,
  ArtifactPage,
  RunJobHandle,
  RunResultSummary,
  RunStatusView,
} from '@trading/research-contracts';
import { AUTH, buildTestApp, runBody } from './helpers';

describe('api e2e', () => {
  it('submit -> drain -> status -> result -> artifacts', async () => {
    const app = buildTestApp();

    const submit = await app.server.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: AUTH,
      payload: runBody({ runId: 'e2e-1' }),
    });
    expect(submit.statusCode).toBe(202);
    expect((submit.json() as RunJobHandle).status).toBe('accepted');

    const queued = (
      await app.server.inject({ url: '/v1/runs/e2e-1/status', headers: AUTH })
    ).json() as RunStatusView;
    expect(queued.status).toBe('queued');

    expect(await app.drain()).toBe(1);

    const done = (
      await app.server.inject({ url: '/v1/runs/e2e-1/status', headers: AUTH })
    ).json() as RunStatusView;
    expect(done.status).toBe('completed');

    const result = (
      await app.server.inject({ url: '/v1/runs/e2e-1/result', headers: AUTH })
    ).json() as RunResultSummary;
    expect(typeof result.metrics).toBe('object');
    expect(result.metrics.total_bars).toBeGreaterThan(0);
    expect(result.resultHash).toMatch(/^sha256:/);
    expect(result.evidence.datasetFingerprint).toMatch(/^sha256:/);

    const manifest = (
      await app.server.inject({ url: '/v1/runs/e2e-1/artifacts', headers: AUTH })
    ).json() as ArtifactManifest;
    expect(manifest.descriptors.length).toBeGreaterThanOrEqual(3);

    const trades = manifest.descriptors.find((d) => d.artifactType === 'trades');
    expect(trades).toBeDefined();
    const page = (
      await app.server.inject({
        url: `/v1/runs/e2e-1/artifacts/${trades!.contentHash}`,
        headers: AUTH,
      })
    ).json() as ArtifactPage;
    expect(Array.isArray(page.page)).toBe(true);
    expect(page.artifactType).toBe('trades');

    await app.server.close();
  });

  it('rejects requests without a bearer token (401)', async () => {
    const app = buildTestApp();
    const r = await app.server.inject({ method: 'POST', url: '/v1/runs', payload: runBody() });
    expect(r.statusCode).toBe(401);
    await app.server.close();
  });

  it('cancels a queued run', async () => {
    const app = buildTestApp();
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
    await app.server.close();
  });

  it('reports capabilities', async () => {
    const app = buildTestApp();
    const caps = (await app.server.inject({ url: '/v1/capabilities', headers: AUTH })).json() as {
      contractVersion: string;
    };
    expect(caps.contractVersion).toBe('017.2');
    await app.server.close();
  });
});
