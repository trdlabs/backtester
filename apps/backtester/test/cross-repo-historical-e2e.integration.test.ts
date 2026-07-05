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

// ── Task 5: real-platform gate (dataSource:'real' against the SAME spawned server) ─────────────
//
// Closed window + symbol set are DERIVED from the spawned server's /historical/coverage — NEVER
// hardcoded dates/symbols. The sibling trading-platform fixture corpus is not guaranteed to hold
// specific symbols/dates, so hardcoding would make the gate environment-specific/flaky. If the
// corpus has fewer usable symbols than requested, the case skips (logged) rather than failing.
const TF = '1m';
const MARGIN_MS = 2 * 60_000; // trim below max toMs → exclude any still-forming tail bar (closed window)
// The spawned server here never sets HISTORICAL_HTTP_TOKENS (see startPlatformServer), so it is
// loopback-trusted and accepts any bearer token — this is a fixed placeholder, not a real secret.
const REAL_TOKEN = 'cross-repo-e2e-real-token';

interface CoverageEntry {
  symbol: string;
  timeframe: string;
  fromMs: number;
  toMs: number;
  barCount: number;
  availability: string;
}

async function pickClosedWindow(
  baseUrl: string,
  token: string,
  n: number,
): Promise<{ symbols: string[]; from: string; to: string } | undefined> {
  const res = await fetch(`${baseUrl}/historical/coverage`, { headers: { authorization: `Bearer ${token}` } });
  const cov = (await res.json()) as { entries: CoverageEntry[] };
  const usable = cov.entries
    .filter((e) => e.timeframe === TF && e.availability === 'available' && e.barCount > 0)
    .slice(0, n);
  if (usable.length < n) return undefined; // corpus too small → caller skips (logged)
  const from = Math.max(...usable.map((e) => e.fromMs));
  const to = Math.min(...usable.map((e) => e.toMs)) - MARGIN_MS;
  return {
    symbols: usable.map((e) => e.symbol),
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
  };
}

/** `dataSource:'real'` pointed at the SAME spawned server, via the 'real' factory path (Task 2)
 *  instead of 'mock' — proves the real-platform wiring, not a second server. */
function realCfg(baseUrl: string, token: string) {
  return testConfig({
    dataSource: 'real',
    realPlatformUrl: baseUrl,
    realPlatformToken: token,
    enableOverlayEngine: true,
    autoWorker: false,
  });
}

interface ClosedWindowRunResult {
  outcome: string;
  resultHash: string | undefined;
  datasetFingerprint: string | undefined;
}

/**
 * Submit an overlay run over a closed window, drain it to a terminal state, and return the fields
 * needed for the determinism assertions. `RunResultSummary` nests `datasetFingerprint` under
 * `evidence` (see the `result.evidence.datasetFingerprint` assertion above) — this test-only helper
 * flattens that so callers can compare `.datasetFingerprint` directly. No engine/production code
 * changes; the field was already returned by the existing `/v1/runs/:id/result` route.
 */
async function runToTerminal(
  app: AppHandles,
  req: { symbols: string[]; timeframe: string; from: string; to: string },
  runId: string,
): Promise<ClosedWindowRunResult> {
  const datasetRef = `${req.symbols[0]}:${req.timeframe}`;
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
      datasetRef,
      symbols: req.symbols,
      timeframe: req.timeframe,
      period: { from: req.from, to: req.to },
      riskProfileRef: { id: 'default_risk', version: '1.0.0' },
      executionProfileRef: { id: 'default_exec', version: '1.0.0' },
      seed: 12345,
      metrics: ['pnl', 'max_drawdown', 'win_rate', 'sharpe'],
    },
  });
  expect(submit.statusCode).toBe(202);

  // Single drain runs the overlay backtest in-process to completion (mirrors the existing test above).
  expect(await app.drain()).toBe(1);

  const status = (
    await app.server.inject({ url: `/v1/runs/${runId}/status`, headers: AUTH })
  ).json() as RunStatusView;

  const result = (
    await app.server.inject({ url: `/v1/runs/${runId}/result`, headers: AUTH })
  ).json() as RunResultSummary;

  return {
    outcome: status.status,
    resultHash: result.resultHash,
    datasetFingerprint: result.evidence?.datasetFingerprint,
  };
}

/**
 * Build a fresh `real`-configured app (fixed clock via testDeps()), run one closed-window job to
 * terminal, and dispose. `runId` is embedded in the hashed `RunOutcome` by design (runner.ts
 * `simulateTarget({ runId: request.runId, ... })`, kept for platform-golden parity) — so the two
 * "identical run twice" attempts use the SAME literal runId on two SEPARATE fresh apps/job-stores.
 * That isolates the comparison to real engine/data determinism instead of incidentally hashing two
 * different runIds against each other.
 */
async function runOnce(
  req: { symbols: string[]; timeframe: string; from: string; to: string },
  runId: string,
): Promise<ClosedWindowRunResult> {
  const realApp = await buildApp(realCfg(BASE_URL, REAL_TOKEN), testDeps());
  try {
    return await runToTerminal(realApp, req, runId);
  } finally {
    await realApp.dispose();
  }
}

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

  it('real platform: single-symbol run is deterministic across two identical closed-window runs', async () => {
    const w = await pickClosedWindow(BASE_URL, REAL_TOKEN, 1);
    if (!w) {
      console.warn('skip real-single: corpus has no usable 1m symbol');
      return;
    }
    const req = { symbols: w.symbols, timeframe: TF, from: w.from, to: w.to };
    const a = await runOnce(req, 'real-e2e-single');
    const b = await runOnce(req, 'real-e2e-single');
    expect(a.outcome).toBe('completed');
    expect(b.outcome).toBe('completed');
    expect(a.resultHash).toBeDefined();
    expect(a.datasetFingerprint).toBeDefined();
    expect(a.resultHash).toBe(b.resultHash);
    expect(a.datasetFingerprint).toBe(b.datasetFingerprint);
  }, 120_000);

  it('real platform: multi-symbol run is deterministic across two identical closed-window runs', async () => {
    const w = await pickClosedWindow(BASE_URL, REAL_TOKEN, 3);
    if (!w) {
      console.warn('skip real-multi: corpus has <3 usable 1m symbols');
      return;
    }
    const req = { symbols: w.symbols, timeframe: TF, from: w.from, to: w.to };
    const a = await runOnce(req, 'real-e2e-multi');
    const b = await runOnce(req, 'real-e2e-multi');
    expect(a.outcome).toBe('completed');
    expect(b.outcome).toBe('completed');
    expect(a.resultHash).toBeDefined();
    expect(a.datasetFingerprint).toBeDefined();
    expect(a.resultHash).toBe(b.resultHash);
    expect(a.datasetFingerprint).toBe(b.datasetFingerprint);
  }, 120_000);
});
