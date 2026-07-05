// Task 2 (result-dedup) — per-engine-path byte-equivalence GOLDEN.
//
// Proves the dedup core (Task 1's normalize/restamp): for a real engine run with runId X,
// restamp(normalize(engine, run(X), X), Y) is byte-identical (same contentRef) to a FRESH
// engine run with runId Y. If this holds for every engine path, the runId re-stamp used by
// the dedup cache-hit path is proven correct — a cache hit under runId Y can be served by
// restamping the cached (normalized) template from any prior run, with zero behavioral
// difference from actually re-running the engine.
//
// Three describe blocks, one per DedupEngine ('momentum' | 'overlay' | 'strategy'), each
// mirroring the fixture/engine wiring of an existing golden test verbatim:
//   - momentum: apps/backtester/test/momentum-guardrail.test.ts (legacy runner, src/runner/run-backtest.ts)
//   - overlay:  apps/backtester/test/overlay-golden.test.ts (lifted engine, src/engine/run-overlay.ts)
//   - strategy: apps/backtester/test/strategy-route-worker.integration.test.ts /
//               strategy-route.integration.test.ts (Docker-gated sandbox strategy bundle,
//               src/engine/run-strategy.ts) — skips cleanly without a Docker daemon (WSL2/CI
//               without Docker), same as every other Docker-gated suite in this repo.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { BacktestRunRequest, ModuleBundle as InlineModuleBundle } from '@trading/research-contracts';
import { runBacktest } from '../src/runner/run-backtest';
import { FixtureDataPort, materialize } from '../src/data/reader';
import { contentRef } from '../src/determinism/hash';
import { normalize, restamp } from '../src/jobs/dedup/restamp';
import { buildOverlayDataset } from '../src/engine/data-adapter.js';
import { runOverlayBacktest } from '../src/engine/run-overlay.js';
import { runStrategyBacktest } from '../src/engine/run-strategy.js';
import { buildTrustedRegistry } from '../src/engine/trusted-registry.js';
import type { MaterializedBundle } from '../src/engine/sandbox/bundle-materialize.js';
import { FIXTURES_DIR } from './helpers.js';
import {
  buildSandboxStrategyBaselineDeps,
  materializeReadableBundle,
} from './helpers-overlay-sandbox.js';
import { DOCKER_AVAILABLE } from './store-factories.js';

// ---------------------------------------------------------------------------------------------
// momentum — mirrors momentum-guardrail.test.ts's REQ / FIXTURES_DIR / loadDataset() verbatim.
// ---------------------------------------------------------------------------------------------

const MOMENTUM_REQ: BacktestRunRequest = {
  runId: 'det-run',
  mode: 'research',
  moduleRef: { id: 'smoke', version: '1.0.0' },
  datasetRef: 'smoke-btc-1m',
  symbols: ['BTCUSDT'],
  timeframe: '1m',
  period: { from: '2023-11-14T00:00:00.000Z', to: '2023-11-15T00:00:00.000Z' },
  seed: 42,
  metrics: [],
};

async function loadMomentumDataset() {
  const port = new FixtureDataPort(FIXTURES_DIR);
  const reader = await port.openDataset('smoke-btc-1m');
  if (!reader) throw new Error('fixture missing');
  return materialize(reader, 'smoke-btc-1m', {
    tsFrom: 0,
    tsTo: Number.MAX_SAFE_INTEGER,
    symbols: ['BTCUSDT'],
  });
}

const momentumFreshRun = async (runId: string) =>
  runBacktest({ ...MOMENTUM_REQ, runId }, { dataset: await loadMomentumDataset() });

describe('dedup equivalence golden — momentum', () => {
  it('restamp(normalize(run(X)), Y) is byte-identical to run(Y)', async () => {
    const a = await momentumFreshRun('run-AAAAAAAA');
    const b = await momentumFreshRun('run-BBBBBBBB');
    const restamped = restamp(normalize('momentum', a, 'run-AAAAAAAA'), 'run-BBBBBBBB');
    expect(contentRef(restamped)).toBe(contentRef(b));
  });
});

// ---------------------------------------------------------------------------------------------
// overlay — mirrors overlay-golden.test.ts's trusted registry + market tape + runOverlayBacktest.
// ---------------------------------------------------------------------------------------------

const OVERLAY_REQUESTS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/overlay/requests',
);

function loadOverlayRequest(name: string): BacktestRunRequest {
  return JSON.parse(readFileSync(resolve(OVERLAY_REQUESTS_DIR, name), 'utf8')) as BacktestRunRequest;
}

async function overlayDeps(req: BacktestRunRequest) {
  const registry = buildTrustedRegistry();
  const marketTape = await buildOverlayDataset(new FixtureDataPort(FIXTURES_DIR), {
    datasetRef: req.datasetRef,
    symbols: req.symbols,
    timeframe: req.timeframe,
    period: req.period,
  });
  return { registry, marketTape };
}

const overlayFreshRun = async (runId: string) => {
  const req = { ...loadOverlayRequest('baseline.json'), runId };
  return runOverlayBacktest(req, await overlayDeps(req));
};

describe('dedup equivalence golden — overlay', () => {
  it('restamp(normalize(run(X)), Y) is byte-identical to run(Y)', async () => {
    const a = await overlayFreshRun('run-AAAAAAAA');
    const b = await overlayFreshRun('run-BBBBBBBB');
    const restamped = restamp(normalize('overlay', a, 'run-AAAAAAAA'), 'run-BBBBBBBB');
    expect(contentRef(restamped)).toBe(contentRef(b));
  });
});

// ---------------------------------------------------------------------------------------------
// strategy — Docker-gated. Mirrors strategy-route.integration.test.ts / strategy-route-worker
// .integration.test.ts's DOCKER_AVAILABLE guard + buildSandboxStrategyBaselineDeps wiring. Skips
// cleanly (does not fail) where no Docker daemon is reachable — WSL2 and dev machines without
// Docker pass with this suite silently skipped, same as every other Docker-gated suite here.
// ---------------------------------------------------------------------------------------------

function loadInlineBundle(name: string): InlineModuleBundle {
  return JSON.parse(
    readFileSync(resolve(OVERLAY_REQUESTS_DIR, '../bundles', name), 'utf8'),
  ) as InlineModuleBundle;
}

const strategyBaselineReq = loadOverlayRequest('baseline.json'); // moduleRef = short_after_pump@0.1.0

describe.skipIf(!DOCKER_AVAILABLE)(
  'dedup equivalence golden — strategy (Docker)',
  () => {
    it(
      'restamp(normalize(run(X)), Y) is byte-identical to run(Y)',
      async () => {
        // Each runId gets its own materialized bundle dir + router (own containerSuffix) so the
        // two sandbox runs never collide on a session container name.
        const spA: MaterializedBundle = await materializeReadableBundle(
          loadInlineBundle('short-after-pump.bundle.json'),
        );
        const spB: MaterializedBundle = await materializeReadableBundle(
          loadInlineBundle('short-after-pump.bundle.json'),
        );
        try {
          const marketTape = await buildOverlayDataset(new FixtureDataPort(FIXTURES_DIR), {
            datasetRef: strategyBaselineReq.datasetRef,
            symbols: strategyBaselineReq.symbols,
            timeframe: strategyBaselineReq.timeframe,
            period: strategyBaselineReq.period,
          });

          const depsA = buildSandboxStrategyBaselineDeps({ spDir: spA.bundleDir });
          const depsB = buildSandboxStrategyBaselineDeps({ spDir: spB.bundleDir });
          try {
            const a = await runStrategyBacktest(
              { ...strategyBaselineReq, runId: 'run-AAAAAAAA', engine: 'strategy' },
              { registry: depsA.registry, marketTape, router: depsA.router },
            );
            const b = await runStrategyBacktest(
              { ...strategyBaselineReq, runId: 'run-BBBBBBBB', engine: 'strategy' },
              { registry: depsB.registry, marketTape, router: depsB.router },
            );

            const restamped = restamp(normalize('strategy', a, 'run-AAAAAAAA'), 'run-BBBBBBBB');
            expect(contentRef(restamped)).toBe(contentRef(b));
          } finally {
            depsA.router.closeAll();
            depsB.router.closeAll();
          }
        } finally {
          await spA.cleanup();
          await spB.cleanup();
        }
      },
      120_000, // generous: two real container boots + NDJSON IPC over 30 bars
    );
  },
);
