/**
 * Cross-repo E2E (Initiative #1, Phase C — Task C4) — OPT-IN, CI-safe.
 *
 * Spawns the REAL platform `start-historical-http` entrypoint over the platform's committed
 * historical golden (30 CanonicalRowV2 rows, BTCUSDT:1m) and drives the backtester overlay
 * job-flow to terminal `completed` THROUGH the consumer rows-path (`RowsDataPort`).
 *
 * This is the real `real == mock` proof at the process boundary: unlike `rows-parity.test.ts`
 * (a fake in-test Fastify server replaying the vendored golden), here the data is served by the
 * actual platform binary reading actual parquet — and the backtester consumes it via the same
 * `dataSource:'mock'` → `RowsDataPort` wiring the demo stack uses.
 *
 * Gating: the whole suite skips unless RUN_CROSS_REPO_E2E=true AND the platform repo exists.
 * With no env it is a clean no-op (safe for CI). PLATFORM_REPO overrides the platform location.
 *
 * Run locally (platform co-located):
 *   RUN_CROSS_REPO_E2E=true pnpm --config.verify-deps-before-run=false test cross-repo-historical-e2e
 */
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunResultSummary, RunStatusView } from '@trading/research-contracts';
import { buildApp, type AppHandles } from '../src/app';
import { testConfig, testDeps, AUTH } from './helpers';

const PLATFORM_REPO = process.env.PLATFORM_REPO ?? '/home/alexxxnikolskiy/projects/trading-platform';
const ENTRYPOINT = resolve(PLATFORM_REPO, 'dist/src/storage/historical/bin/start-historical-http.js');
const HISTORY_ROOT = resolve(PLATFORM_REPO, 'test/fixtures/historical-golden');

const enabled = process.env.RUN_CROSS_REPO_E2E === 'true' && existsSync(PLATFORM_REPO);

const PORT = 8096;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DATASET_REF = 'BTCUSDT:1m';
// The golden spans 30 one-minute bars (00:00 → 00:29). period.to is half-open, so 00:30 includes
// the last bar — matching the overlay-golden window convention.
const PERIOD = { from: '2025-01-02T00:00:00.000Z', to: '2025-01-02T00:30:00.000Z' };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Spawn the real platform historical-http server and resolve once /historical/discover is 200. */
async function startPlatformServer(): Promise<ChildProcess> {
  const child = spawn('node', [ENTRYPOINT], {
    env: {
      ...process.env,
      MARKET_HISTORY_ENABLED: 'true',
      MARKET_HISTORY_ROOT: HISTORY_ROOT,
      HISTORICAL_HTTP_PORT: String(PORT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  for (let i = 0; i < 60; i += 1) {
    if (child.exitCode !== null) throw new Error(`platform server exited early (code ${child.exitCode})`);
    try {
      const res = await fetch(`${BASE_URL}/historical/discover`);
      if (res.ok) return child;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  child.kill('SIGKILL');
  throw new Error('platform historical-http server did not become ready within 15s');
}

describe.skipIf(!enabled)('cross-repo E2E (backtester rows-path → real platform start-historical-http)', () => {
  let server: ChildProcess;
  let app: AppHandles;

  beforeAll(async () => {
    if (!existsSync(ENTRYPOINT)) {
      // Try to build the platform dist once; if that fails, surface a clear actionable error.
      execSync('npm run build', { cwd: PLATFORM_REPO, stdio: 'inherit' });
      if (!existsSync(ENTRYPOINT)) {
        throw new Error(`platform entrypoint missing after build: ${ENTRYPOINT}`);
      }
    }
    server = await startPlatformServer();
    app = await buildApp(
      testConfig({
        dataSource: 'mock',
        mockPlatformUrl: BASE_URL,
        enableOverlayEngine: true,
        autoWorker: false,
      }),
      testDeps(),
    );
  }, 120_000);

  afterAll(async () => {
    await app?.dispose();
    server?.kill('SIGKILL');
  });

  it('listDatasets exposes the real platform BTCUSDT:1m dataset (rows-path, not a fixture)', async () => {
    const datasets = await app.dataPort.listDatasets();
    expect(datasets.length).toBeGreaterThan(0);
    const ds = datasets.find((d) => d.datasetRef === DATASET_REF);
    expect(ds).toBeDefined();
    expect(ds!.symbols).toContain('BTCUSDT');
    expect(ds!.timeframe).toBe('1m');
    expect(ds!.rowCount).toBe(30);
    // Proof this is the rows-path, not the in-process fixture port (which exposes smoke-* refs).
    expect(datasets.every((d) => !d.datasetRef.startsWith('smoke-'))).toBe(true);
  }, 30_000);

  it('overlay run over real golden data completes through the job API with a comparison', async () => {
    const runId = 'cross-repo-e2e-variant';
    const submit = await app.server.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: AUTH,
      payload: {
        runId,
        engine: 'overlay',
        mode: 'research',
        moduleRef: { id: 'short_after_pump', version: '0.1.0' },
        overlayRefs: [{ id: 'early_exit_short_after_pump', version: '0.1.0' }],
        datasetRef: DATASET_REF,
        symbols: ['BTCUSDT'],
        timeframe: '1m',
        period: PERIOD,
        riskProfileRef: { id: 'default_risk', version: '1.0.0' },
        executionProfileRef: { id: 'default_exec', version: '1.0.0' },
        seed: 12345,
        metrics: ['pnl', 'max_drawdown', 'win_rate', 'sharpe'],
      },
    });
    expect(submit.statusCode).toBe(202);

    // Single drain runs the overlay backtest in-process (trusted registry — no Docker sandbox)
    // against the MarketTape materialized from the real platform /historical/rows feed.
    expect(await app.drain()).toBe(1);

    const status = (
      await app.server.inject({ url: `/v1/runs/${runId}/status`, headers: AUTH })
    ).json() as RunStatusView;
    expect(status.status).toBe('completed');

    const result = (
      await app.server.inject({ url: `/v1/runs/${runId}/result`, headers: AUTH })
    ).json() as RunResultSummary;
    expect(result.status).toBe('completed');
    expect(result.resultHash).toMatch(/^sha256:/);
    expect(result.metrics).toBeDefined();
    // overlayRefs → a real baseline-vs-variant comparison driven by real platform data.
    expect(result.comparison).toBeDefined();
    expect(result.evidence.datasetRef).toBe(DATASET_REF);
    expect(result.evidence.datasetFingerprint).toMatch(/^sha256:/);
  }, 120_000);
});
