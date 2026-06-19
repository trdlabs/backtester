import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { RunJobHandle } from '@trading/research-contracts';
import { InMemoryJobStore } from '../src/jobs/job-store';
import { requestFingerprint, storedRequestFingerprint } from '../src/jobs/fingerprint';
import { submitRun } from '../src/jobs/submit';
import { AUTH, makeApp, runBody } from './helpers';
import { STORE_FACTORIES } from './store-factories';

// ---------------------------------------------------------------------------
// Replay integrity: guard recomputes stored fingerprint with CURRENT algorithm
// ---------------------------------------------------------------------------

function makeDeps(store: InMemoryJobStore) {
  return {
    store,
    clock: () => 1_700_000_000_000,
    uid: () => randomUUID(),
    defaultQueueTimeoutMs: 3_600_000,
    defaultRunTimeoutMs: 3_600_000,
    enableOverlayEngine: false,
  };
}

/** Seeds a row that simulates a job written by an OLDER deploy (stale requestFingerprint). */
async function seedOldRow(
  store: InMemoryJobStore,
  runId: string,
  resumeToken: string,
  request: Record<string, unknown>,
) {
  await store.insertOrGet({
    jobId: runId,
    runId,
    resumeToken,
    // Deliberately stale: a hash written by an older algorithm that omitted overlay fields.
    requestFingerprint: 'sha256:older-algorithm-row',
    request: { ...request, runId, metrics: (request.metrics as string[]) ?? [] } as any,
    effectiveSeed: (request.seed as number) ?? 42,
    datasetRef: (request.datasetRef as string) ?? 'smoke-btc-1m',
    queueDeadlineMs: 0,
    runTimeoutMs: 3_600_000,
    acceptedAtMs: 1_700_000_000_000,
  } as any);
}

describe('replay integrity: recompute from stored request', () => {
  it('replays a job stored by an older algorithm without a false conflict', async () => {
    const store = new InMemoryJobStore();
    const deps = makeDeps(store);
    const body = runBody({ resumeToken: 'rt-1', seed: 42, robustnessChecks: [] as any });
    await seedOldRow(store, 'run-1', 'rt-1', body as any);

    // Identical request → the guard must recompute from stored data → match → no 409.
    const outcome = await submitRun(deps, body);
    expect(outcome.created).toBe(false);
  });

  it('rejects a replay that changed a field the older hash ignored (riskProfileRef)', async () => {
    const store = new InMemoryJobStore();
    const deps = makeDeps(store);
    const stored = runBody({
      resumeToken: 'rt-2',
      seed: 42,
      riskProfileRef: { id: 'default_risk', version: '1.0.0' } as any,
    });
    await seedOldRow(store, 'run-2', 'rt-2', stored as any);

    const changed = { ...stored, riskProfileRef: { id: 'long_only_risk', version: '1.0.0' } as any };

    // The guard recomputes fingerprint from stored row vs. incoming → mismatch → real 409.
    await expect(submitRun(deps, changed)).rejects.toMatchObject({
      statusCode: 409,
      code: 'resume_token_conflict',
    });

    // Also assert the fingerprints genuinely differ.
    expect(storedRequestFingerprint(stored, null)).not.toBe(requestFingerprint(changed));
  });
});

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
