// Exercises the published @trading-backtester/sdk client against a REAL running app over HTTP (the same
// path trading-lab's HttpBacktesterAdapter uses). Imported from source to avoid a build step in tests.
//
// TEMPORARY DUPLICATE: this intentionally mirrors apps/backtester/test/client.test.ts during the
// compatibility window so both the legacy and SDK clients are exercised against identical HTTP
// behavior. Once trading-lab cuts over to @trading-backtester/sdk/client, delete the legacy
// client.test.ts (and packages/client) and keep this file (Phase 3 of the SDK plan).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppHandles } from '../src/app';
import {
  BacktesterClient,
  BacktesterConflictError,
} from '../../../packages/sdk/src/client/index';
import type { RunJobHandle } from '../../../packages/sdk/src/contracts/index';
import { buildTestApp, runBody, testDeps } from './helpers';

const GOLDEN_RESULT_HASH = 'sha256:eff10116147933c96d92ae50071ef66339467fb69545c38855dcd50c2c0b43ba';

describe('@trading-backtester/client over HTTP (SDK client)', () => {
  let app: AppHandles;
  let client: BacktesterClient;

  beforeAll(async () => {
    app = await buildTestApp({ autoWorker: true }, testDeps());
    app.startWorker();
    const url = await app.server.listen({ host: '127.0.0.1', port: 0 });
    client = new BacktesterClient({ baseUrl: url, token: 'test-token' });
  });
  afterAll(async () => {
    await app.dispose();
  });

  it('discovers capabilities and datasets', async () => {
    const caps = await client.getCapabilities();
    expect(caps.contractVersion).toBe('017.2');
    const datasets = await client.listDatasets();
    expect(datasets.find((d) => d.datasetRef === 'smoke-btc-1m')).toBeDefined();
  });

  it('submits, awaits completion, reads result + artifacts', async () => {
    const handle: RunJobHandle = await client.submitRun(runBody({ runId: 'det-run' }));
    expect(handle.status).toBe('accepted');

    const terminal = await client.awaitCompletion('det-run', { intervalMs: 50, timeoutMs: 20_000 });
    expect(terminal.status).toBe('completed');

    const result = await client.getRunResult('det-run');
    expect(result.resultHash).toBe(GOLDEN_RESULT_HASH);

    const manifest = await client.getArtifactManifest('det-run');
    const trades = manifest.descriptors.find((d) => d.artifactType === 'trades');
    expect(trades).toBeDefined();
    const page = await client.readArtifact('det-run', trades!.contentHash, { limit: 5 });
    expect(Array.isArray(page.page)).toBe(true);
  });

  it('throws BacktesterConflictError on resumeToken reuse with a different request', async () => {
    await client.submitRun(runBody({ resumeToken: 'ctok' }));
    await expect(client.submitRun(runBody({ resumeToken: 'ctok', seed: 999 }))).rejects.toBeInstanceOf(
      BacktesterConflictError,
    );
  });

  it('validates a module and cancels a run', async () => {
    const report = await client.validateModule(runBody());
    expect(report.executed).toBe(false);

    await client.submitRun(runBody({ runId: 'client-cancel' }));
    const view = await client.cancelRun('client-cancel');
    expect(['canceled', 'completed', 'running']).toContain(view.status);
  });
});
