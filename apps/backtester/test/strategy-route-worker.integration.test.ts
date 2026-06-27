// Task 2 (R2) — worker-level e2e: engine:'strategy' job through the real app-pipeline.
//
// Proves: HTTP submit(engine:'strategy', moduleBundle=short_after_pump) →
//         processNextQueued → sandboxBundleFor → buildOverlayDataset →
//         runStrategyBacktest → terminal 'completed' with non-empty resultHash.
//
// This exercises the FULL worker path — not just the engine-level helpers used by
// strategy-route.integration.test.ts — but the actual HTTP submit + drainQueue pipeline.
//
// Harness reused from: apps/backtester/test/async-sandbox-overlap.test.ts
//   • buildTestApp({ enableOverlayEngine: true, workerConcurrency: 1 })
//   • loadBundle / loadRequest from overlay fixtures (same as model harness)
//   • DOCKER_AVAILABLE guard (describe.skipIf(!DOCKER_AVAILABLE))
//   • app.drain() + app.dispose() in try/finally
//
// Submit shape:
//   { ...baseline.json, runId:'strat-worker-e2e-1', engine:'strategy',
//     moduleBundle: short-after-pump.bundle.json, metrics: ['pnl', 'win_rate'] }
//   No overlayRefs — strategy engine path does not use them.
//   moduleRef = { id:'short_after_pump', version:'0.1.0' } (from baseline.json, matches bundle manifest).
//   robustnessChecks: ['walk_forward'] carried from baseline.json — valid in platform ROBUSTNESS_CATALOG.
//
// Metric selection:
//   submit.ts validate() validates engine:'strategy' against VALID_OVERLAY_METRICS (the platform
//   catalog: pnl/sharpe/max_drawdown/win_rate/total_trades/...) and rejects empty metrics — the
//   strategy engine runs the same lifted engine as overlay. ['pnl','win_rate'] is a minimal valid
//   choice; the full platform catalog is accepted (e.g. sharpe/max_drawdown/total_trades).
//
// Terminal assertions:
//   row.status === 'completed', row.resultHash non-empty, row.resultSummary defined,
//   row.bundleHash defined (set during submission via moduleBundle→bundleStore.put).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { BacktestRunRequest, ModuleBundle } from '@trading/research-contracts';
import { AUTH, buildTestApp } from './helpers.js';
import { DOCKER_AVAILABLE } from './store-factories.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REQ = resolve(HERE, 'fixtures/overlay/requests');
const BUN = resolve(HERE, 'fixtures/overlay/bundles');

const loadRequest = (n: string): BacktestRunRequest =>
  JSON.parse(readFileSync(resolve(REQ, n), 'utf8')) as BacktestRunRequest;
const loadBundle = (n: string): ModuleBundle =>
  JSON.parse(readFileSync(resolve(BUN, n), 'utf8')) as ModuleBundle;

describe.skipIf(!DOCKER_AVAILABLE)(
  "strategy-route worker e2e — engine:'strategy' job drains through app-pipeline (Docker)",
  () => {
    it(
      "submit strategy job → drainQueue → processNextQueued → completed with resultHash",
      async () => {
        const app = await buildTestApp({ enableOverlayEngine: true, workerConcurrency: 1 });
        try {
          const baselineReq = loadRequest('baseline.json');
          const bundle = loadBundle('short-after-pump.bundle.json');
          const runId = 'strat-worker-e2e-1';

          // Submit a strategy job. baseline.json carries:
          //   moduleRef = { id:'short_after_pump', version:'0.1.0' }  — matches bundle manifest
          //   datasetRef = 'pump-fixture-1m'                          — served by FixtureDataPort
          //   symbols = ['BTCUSDT'], timeframe = '1m', period 30 min
          //   robustnessChecks = ['walk_forward']                     — valid in platform catalog
          // We add engine:'strategy' and moduleBundle so submitRun stores the bundle bytes and
          // sets bundleHash on the job row. processNextQueued will call sandboxBundleFor(bundleHash)
          // → buildOverlayDataset → runStrategyBacktest → completed.
          //
          // metrics: ['pnl', 'win_rate'] — a minimal valid set. submit.ts validates engine:'strategy'
          // against VALID_OVERLAY_METRICS (the platform catalog) and rejects metrics:[] with a 400,
          // so the full platform catalog (sharpe/max_drawdown/total_trades/...) is also accepted here.
          const res = await app.server.inject({
            method: 'POST',
            url: '/v1/runs',
            headers: AUTH,
            payload: {
              ...baselineReq,
              runId,
              engine: 'strategy',
              moduleBundle: bundle,
              metrics: ['pnl', 'win_rate'],
            },
          });
          expect(res.statusCode).toBe(202);

          // Drain the single queued job through the real worker pipeline.
          const processed = await app.drain();
          expect(processed).toBe(1);

          // Query the store for the terminal row.
          const row = await app.store.get(runId);
          expect(row).toBeDefined();
          expect(row!.status).toBe('completed');
          // resultHash is set by contentRef(outcome) in the strategy branch — must be a non-empty string.
          expect(typeof row!.resultHash).toBe('string');
          expect(row!.resultHash).toBeTruthy();
          // resultSummary is set by toOverlaySummary(...) in the strategy branch.
          expect(row!.resultSummary).toBeDefined();
          // bundleHash is set during submission (submitRun → bundleStore.put).
          expect(row!.bundleHash).toBeDefined();
        } finally {
          await app.dispose();
        }
      },
      120_000, // generous: real container boot + NDJSON IPC over 30 bars
    );
  },
);
