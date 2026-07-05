// Task 6 — strategy-route twin-equivalence integration test (Docker-gated).
//
// Proves: backtest(short_after_pump kind:'strategy' bundle via NEW strategy route, sandbox)
//      == backtest(trusted shortAfterPump baseline, in-process)
//
// CURATED side:   runOverlayBacktest(baseline.json, { buildTrustedRegistry(), marketTape })
//                 — identical to overlay-golden.test.ts::overlayDeps, the 6a in-process path.
// CANDIDATE side: runStrategyBacktest({ ...baselineReq, engine:'strategy' },
//                   { buildSandboxStrategyBaselineDeps().registry, marketTape, router })
//                 — short_after_pump kind:'strategy' bundle executed in a real Docker container
//                   via the SandboxModuleExecutor (strategy session, `onBarClose` in-harness).
//
// Parity gate: compareBacktestRuns → equivalent + contentRef match.
//
// Router construction copied verbatim from overlay-sandbox-equivalence.test.ts
// (`buildSandboxStrategyBaselineDeps`).  Docker guard copied from the same file
// (`DOCKER_AVAILABLE` from `./store-factories.js`, `describe.skipIf(!DOCKER_AVAILABLE)`).
// Skips cleanly (does not fail) where no Docker daemon is reachable — WSL2 and dev machines
// without Docker pass CI with this test silently skipped, the same as all other Docker-gated suites.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BacktestRunRequest, ModuleBundle as InlineModuleBundle } from '@trading/research-contracts';
import { buildOverlayDataset } from '../src/engine/data-adapter.js';
import { runOverlayBacktest } from '../src/engine/run-overlay.js';
import { runStrategyBacktest } from '../src/engine/run-strategy.js';
import { buildTrustedRegistry } from '../src/engine/trusted-registry.js';
import { compareBacktestRuns } from '../src/engine/equivalence.js';
import type { MaterializedBundle } from '../src/engine/sandbox/bundle-materialize.js';
import { FixtureDataPort } from '../src/data/reader.js';
import { contentRef } from '../src/determinism/hash.js';
import { FIXTURES_DIR } from './helpers.js';
import {
  buildSandboxStrategyBaselineDeps,
  materializeReadableBundle,
} from './helpers-overlay-sandbox.js';
import { DOCKER_AVAILABLE } from './store-factories.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OVERLAY_DIR = resolve(HERE, 'fixtures/overlay');

function loadInlineBundle(name: string): InlineModuleBundle {
  return JSON.parse(
    readFileSync(resolve(OVERLAY_DIR, 'bundles', name), 'utf8'),
  ) as InlineModuleBundle;
}

function loadRequest(name: string): BacktestRunRequest {
  return JSON.parse(
    readFileSync(resolve(OVERLAY_DIR, 'requests', name), 'utf8'),
  ) as BacktestRunRequest;
}

/** Dataset selector from a request (mirrors overlay-sandbox-equivalence.test.ts). */
function selFrom(req: BacktestRunRequest) {
  return {
    datasetRef: req.datasetRef,
    symbols: req.symbols,
    timeframe: req.timeframe,
    period: req.period,
  };
}

const baselineReq = loadRequest('baseline.json'); // moduleRef = short_after_pump@0.1.0

describe.skipIf(!DOCKER_AVAILABLE)(
  'strategy-route equivalence — short_after_pump twin (Docker)',
  () => {
    // Strategy bundle materialized to a world-readable temp dir (required by sandbox `nobody` user).
    let sp: MaterializedBundle;
    // Market tape built once up-front before any container churn — avoids transient fixture FS races
    // (mirrors the beforeAll pattern in overlay-sandbox-equivalence.test.ts).
    let marketTape: Awaited<ReturnType<typeof buildOverlayDataset>>;

    beforeAll(async () => {
      sp = await materializeReadableBundle(loadInlineBundle('short-after-pump.bundle.json'));
      marketTape = await buildOverlayDataset(
        new FixtureDataPort(FIXTURES_DIR),
        selFrom(baselineReq),
      );
    });

    afterAll(async () => {
      await sp?.cleanup();
    });

    it(
      'backtest(kind:"strategy" bundle via new strategy route) == backtest(trusted baseline in-process)',
      async () => {
        // CURATED: trusted shortAfterPump lifecycle, fully in-process (6a overlay path).
        // Identical to overlay-golden.test.ts::overlayDeps — the canonical trusted baseline.
        const curated = await runOverlayBacktest(baselineReq, {
          registry: buildTrustedRegistry(),
          marketTape,
        });

        // CANDIDATE: short_after_pump kind:'strategy' bundle via NEW strategy route.
        // Router wired per overlay-sandbox-equivalence.test.ts: buildSandboxStrategyBaselineDeps
        // loads the materialized bundle dir into a ModuleRegistry019 (provenance:'bundle') and
        // creates an ExecutorRouter that routes the strategy's onBarClose to a real Docker container
        // via SandboxModuleExecutor + NDJSON IPC.
        // runStrategyBacktest strips engine:'strategy' + overlayRefs before handing to runBacktest
        // so the hashed RunOutcome is platform-compatible (no backtester-only fields in the hash).
        const { registry, router } = buildSandboxStrategyBaselineDeps({ spDir: sp.bundleDir });
        try {
          const candidate = await runStrategyBacktest(
            { ...baselineReq, engine: 'strategy' },
            { registry, marketTape, router },
          );

          expect(router.errors()).toEqual([]);

          const eq = compareBacktestRuns(curated, candidate);
          expect(eq.equivalent).toBe(true);
          expect(eq.firstDivergence).toBeUndefined();
          expect(contentRef(candidate)).toBe(contentRef(curated));
        } finally {
          // Tears down the strategy session container (docker rm -f) — deterministic cleanup.
          router.closeAll();
        }
      },
      60_000, // generous: real container boot + 30 bars of synchronous NDJSON IPC
    );
  },
);
