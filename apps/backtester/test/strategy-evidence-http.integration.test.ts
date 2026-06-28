// Task 4 (E4) — worker-level e2e: engine:'strategy' + curatedBaselineRef + signing key
// produces a signed backtest-evidence/v1 artifact and stores a pointer in resultSummary.evidenceRef.
//
// Proves:
//   HTTP submit(engine:'strategy', curatedBaselineRef, evidenceSigningKey injected) →
//   processNextQueued → evidence block → signed artifact → row.resultSummary.evidenceRef defined.
//
// Two cases:
//   (a) WITH curatedBaselineRef + key → completed, evidenceRef defined, artifact verifies
//   (b) WITHOUT curatedBaselineRef → completed, evidenceRef undefined (resultHash path intact)
//
// Harness modelled on strategy-route-worker.integration.test.ts.
// DOCKER_AVAILABLE guard — skipped in WSL2/CI without Docker daemon.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { BacktestRunRequest, ModuleBundle } from '@trading/research-contracts';
import { AUTH, buildTestApp } from './helpers.js';
import { DOCKER_AVAILABLE } from './store-factories.js';
import { generateSigningKey, verifySignedEvidenceLocal } from '../src/evidence/signing.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REQ = resolve(HERE, 'fixtures/overlay/requests');
const BUN = resolve(HERE, 'fixtures/overlay/bundles');

const loadRequest = (n: string): BacktestRunRequest =>
  JSON.parse(readFileSync(resolve(REQ, n), 'utf8')) as BacktestRunRequest;
const loadBundle = (n: string): ModuleBundle =>
  JSON.parse(readFileSync(resolve(BUN, n), 'utf8')) as ModuleBundle;

describe.skipIf(!DOCKER_AVAILABLE)(
  "strategy-evidence over HTTP (Docker) — E4: worker produces signed backtest-evidence",
  () => {
    it(
      'strategy submit + curatedBaselineRef + signing key → signed evidenceRef, verifiable',
      async () => {
        const key = generateSigningKey();
        const app = await buildTestApp({
          enableOverlayEngine: true,
          workerConcurrency: 1,
          evidenceSigningKey: key,
        });
        try {
          const baselineReq = loadRequest('baseline.json');
          const bundle = loadBundle('short-after-pump.bundle.json');
          const runId = 'strat-evidence-1';

          // Use evidence-pump-1m: flat warmup (bars 0-19 at 100) → 12% pump at bar 20 (vol 2M) →
          // retracement to 105 (bars 21-29). Strategy enters short at 112, closes at 105 → profit.
          // This guarantees sharpe>0, winRate>0, total_trades>=1 → verdict='passed'.
          const res = await app.server.inject({
            method: 'POST',
            url: '/v1/runs',
            headers: AUTH,
            payload: {
              ...baselineReq,
              runId,
              engine: 'strategy',
              moduleBundle: bundle,
              datasetRef: 'evidence-pump-1m',
              metrics: ['pnl', 'win_rate'],
              curatedBaselineRef: { id: 'short_after_pump', version: '0.1.0' },
            },
          });
          expect(res.statusCode).toBe(202);

          const processed = await app.drain();
          expect(processed).toBe(1);

          const row = await app.store.get(runId);
          expect(row).toBeDefined();
          expect(row!.status).toBe('completed');
          expect(row!.resultSummary).toBeDefined();

          // E4: evidenceRef must be present when curatedBaselineRef + key are supplied.
          expect(row!.resultSummary!.evidenceRef).toBeDefined();

          // Fetch and verify the signed artifact.
          const artifact = await app.artifactStore.read(row!.resultSummary!.evidenceRef!.artifactId) as {
            body: { schema: string; bundleHash: string; verdict: string };
            signature: string;
          };
          expect(artifact.body.schema).toBe('backtest-evidence/v1');
          expect(artifact.body.bundleHash).toMatch(/^sha256:[0-9a-f]{64}$/);
          expect(artifact.body.verdict).toBe('passed');
          // Verify signature with the injected key — keyId must match what was used to sign.
          expect(
            verifySignedEvidenceLocal(artifact, { [key.keyId]: key.publicKeyPem }).ok,
          ).toBe(true);
        } finally {
          await app.dispose();
        }
      },
      120_000,
    );

    it(
      'strategy submit WITHOUT curatedBaselineRef → completed, no evidenceRef (resultHash path intact)',
      async () => {
        const app = await buildTestApp({
          enableOverlayEngine: true,
          workerConcurrency: 1,
          evidenceSigningKey: generateSigningKey(),
        });
        try {
          const baselineReq = loadRequest('baseline.json');
          const res = await app.server.inject({
            method: 'POST',
            url: '/v1/runs',
            headers: AUTH,
            payload: {
              ...baselineReq,
              runId: 'strat-no-ev',
              engine: 'strategy',
              moduleBundle: loadBundle('short-after-pump.bundle.json'),
              metrics: ['pnl', 'win_rate'],
              // No curatedBaselineRef — evidence block must be skipped.
            },
          });
          expect(res.statusCode).toBe(202);

          await app.drain();

          const row = await app.store.get('strat-no-ev');
          expect(row).toBeDefined();
          expect(row!.status).toBe('completed');
          expect(row!.resultSummary).toBeDefined();
          // resultHash path intact — evidenceRef must be absent.
          expect(row!.resultSummary!.evidenceRef).toBeUndefined();
          // resultHash still set.
          expect(row!.resultHash).toBeTruthy();
        } finally {
          await app.dispose();
        }
      },
      120_000,
    );
  },
);
