// Task 6 — freeze the bar-major N>1 result_hash as the committed golden of the NEW semantics
// (NOT compared to symbol-major — Task 4's bar-major-runner.test.ts already pins the divergence),
// plus a Docker-gated twin-equivalence gate (trusted == sandbox under bar-major).
//
// Ordering constraint: this runs AFTER Task 5, so the frozen hash below includes the `capitalModel`
// evidence field (equal_weight_per_symbol, 2 symbols) that Task 5 added to bar-major N>1 outcomes.
//
// Golden section reuses Task 4's fixture verbatim (`makeMultiSymbolDeps`/`makeRequest`/`resultHash`
// from `./helpers/bar-major-fixture.js`) — capture-then-freeze: run once with the placeholder, paste
// the printed hash in, re-run to confirm.
//
// Twin-equivalence section: Task 4's fixture strategy is an in-process closure (`moduleFactory`)
// with no materializable bundle source, so it cannot be loaded through the sandbox path as-is.
// Instead this reuses the repo's EXISTING trusted/sandbox twin pair for `short_after_pump`
// (`buildTrustedRegistry()` / `buildSandboxStrategyBaselineDeps` + `short-after-pump.bundle.json`,
// proven byte-identical in `strategy-route.integration.test.ts`) over the existing 3-symbol
// `universe-multi.json` request + `universe-fixture-1m` dataset (`universe-session-equivalence.test.ts`),
// with `barMajor: true` added to BOTH sides via `runBacktest` directly (`runStrategyBacktest` does not
// thread `barMajor` through). This proves trusted == sandbox holds under the bar-major driver too,
// without inventing a new bundle fixture. It intentionally does NOT compare to `BAR_MAJOR_GOLDEN`
// below — that hash is scoped to the Task-4 fixture's own strategy/dataset, not `short_after_pump`.
// Docker is unavailable in this environment, so this suite is expected to report SKIPPED.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { BacktestRunRequest, ModuleBundle as InlineModuleBundle } from '@trading/research-contracts';
import { runBacktest } from '../src/engine/runner.js';
import { buildOverlayDataset } from '../src/engine/data-adapter.js';
import { buildTrustedRegistry } from '../src/engine/trusted-registry.js';
import { createTrustedRouter } from '../src/engine/module-executor.js';
import { FixtureDataPort } from '../src/data/reader.js';
import type { MaterializedBundle } from '../src/engine/sandbox/bundle-materialize.js';
import { FIXTURES_DIR } from './helpers.js';
import {
  buildSandboxStrategyBaselineDeps,
  materializeReadableBundle,
} from './helpers-overlay-sandbox.js';
import { DOCKER_AVAILABLE } from './store-factories.js';
import { makeMultiSymbolDeps, makeRequest, resultHash } from './helpers/bar-major-fixture.js';

// ---------------------------------------------------------------------------------------------
// Golden freeze — Task 4's fixture, bar-major ON, N=2 (BTCUSDT/ETHUSDT).
// ---------------------------------------------------------------------------------------------

const BAR_MAJOR_GOLDEN = 'sha256:9da2192a459e6147bd4d5d52de6a327ed7b40b6520e107f93dabc3cff53ef977';

describe('bar-major N>1 golden (new semantics)', () => {
  it('produces the committed bar-major result_hash on the fixture', async () => {
    const out = await runBacktest(makeRequest(['BTCUSDT', 'ETHUSDT']), makeMultiSymbolDeps({ barMajor: true }));
    expect(resultHash(out)).toBe(BAR_MAJOR_GOLDEN);
  });
});

// ---------------------------------------------------------------------------------------------
// Docker-gated twin-equivalence — trusted == sandbox under bar-major (N=3, short_after_pump).
// ---------------------------------------------------------------------------------------------

const OVERLAY_REQUESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/overlay/requests');

function loadOverlayRequest(name: string): BacktestRunRequest {
  return JSON.parse(readFileSync(resolve(OVERLAY_REQUESTS_DIR, name), 'utf8')) as BacktestRunRequest;
}

function loadInlineBundle(name: string): InlineModuleBundle {
  return JSON.parse(readFileSync(resolve(OVERLAY_REQUESTS_DIR, '../bundles', name), 'utf8')) as InlineModuleBundle;
}

// 3 symbols (BTCUSDT/ETHUSDT/SOLUSDT), datasetRef 'universe-fixture-1m' — same fixture pair
// universe-session-equivalence.test.ts uses for its Docker golden gate.
const universeReq = loadOverlayRequest('universe-multi.json');

describe.skipIf(!DOCKER_AVAILABLE)('bar-major twin-equivalence (Docker)', () => {
  it(
    'trusted (in-process) and sandbox (bundle, container) produce the same result_hash under bar-major',
    async () => {
      const sp: MaterializedBundle = await materializeReadableBundle(loadInlineBundle('short-after-pump.bundle.json'));
      try {
        const marketTape = await buildOverlayDataset(new FixtureDataPort(FIXTURES_DIR), {
          datasetRef: universeReq.datasetRef,
          symbols: universeReq.symbols,
          timeframe: universeReq.timeframe,
          period: universeReq.period,
        });

        const trusted = await runBacktest(universeReq, {
          registry: buildTrustedRegistry(),
          marketTape,
          router: createTrustedRouter(),
          barMajor: true,
        });

        const { registry, router } = buildSandboxStrategyBaselineDeps({ spDir: sp.bundleDir });
        try {
          const sandboxed = await runBacktest(universeReq, {
            registry,
            marketTape,
            router,
            barMajor: true,
          });

          expect(router.errors()).toEqual([]);
          expect(resultHash(sandboxed)).toBe(resultHash(trusted));
        } finally {
          router.closeAll();
        }
      } finally {
        await sp.cleanup();
      }
    },
    120_000, // generous: real container boot + NDJSON IPC over 3 symbols x 30 bars, bar-major interleaved
  );
});
