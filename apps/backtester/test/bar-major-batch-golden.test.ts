// Task 7 — Slice B final proof gate: batch ON reproduces Slice A byte-for-byte.
//
// Two independent golden checks, mirroring the two sections of Task 6's `bar-major-golden.test.ts`:
//
//  1. Trusted, Docker-free — replay Task 4's exact 2-symbol fixture (BTCUSDT/ETHUSDT,
//     `makeMultiSymbolDeps`/`makeRequest`/`resultHash` from `./helpers/bar-major-fixture.js`) with
//     `barMajorBatch: true`. The 3-phase batched loop (`executeStrategyHookBarMajor`, trusted
//     executor) must produce the SAME committed hash as Task 6's frozen `BAR_MAJOR_GOLDEN`
//     (`barMajor:true`, batch OFF) — imported from `./helpers/bar-major-golden-hash.js`, NOT
//     retyped — proving the transport collapse changes IPC shape only, never engine output, on the
//     trusted path. (Imported from the shared non-`.test.ts` helper module, not from
//     `bar-major-golden.test.ts` directly — importing a `.test.ts` file would re-run its
//     `describe`/`it` blocks as a side effect of module evaluation.)
//
//  2. Sandbox, Docker-gated — reuse Task 6's short_after_pump / `universe-multi.json` twin (3
//     symbols): trusted vs sandbox, both with `barMajor: true, barMajorBatch: true` added to BOTH
//     sides via `runBacktest` directly. Assert `router.errors()` is empty, then assert the sandboxed
//     (real per-symbol container, one shared session, ONE `hookBarMajor` round-trip per union-ts)
//     result_hash equals the freshly-computed trusted (batched) result_hash. This extends Task 6's
//     twin-equivalence proof from Slice A (lockstep interleave) to the Slice B collapsed transport.
//
// NOTE on scope: `BAR_MAJOR_GOLDEN` is frozen against Task 4's own 2-symbol fixture (see that
// constant's doc comment) — it is NOT compared against the short_after_pump/universe-multi fixture
// in section 2 (different strategy, different dataset, different hash by construction; Task 6's
// docstring already flags this). Section 1 is where `BAR_MAJOR_GOLDEN` earns its keep: same fixture,
// same expected hash, batch flag flipped.

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
import { BAR_MAJOR_GOLDEN } from './helpers/bar-major-golden-hash.js';

// ---------------------------------------------------------------------------------------------
// Section 1 — trusted, Docker-free: batch ON reproduces the Task 6 frozen golden on the SAME
// (Task 4) fixture.
// ---------------------------------------------------------------------------------------------

describe('bar-major batch N>1 golden (trusted, batch ON reproduces the Slice A frozen golden)', () => {
  it('produces the SAME committed bar-major result_hash with barMajorBatch:true', async () => {
    const out = await runBacktest(
      makeRequest(['BTCUSDT', 'ETHUSDT']),
      makeMultiSymbolDeps({ barMajor: true, barMajorBatch: true }),
    );
    expect(resultHash(out)).toBe(BAR_MAJOR_GOLDEN);
  });
});

// ---------------------------------------------------------------------------------------------
// Section 2 — Docker-gated twin-equivalence, batched: trusted == sandbox under bar-major AND
// barMajorBatch (N=3, short_after_pump).
// ---------------------------------------------------------------------------------------------

const OVERLAY_REQUESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/overlay/requests');

function loadOverlayRequest(name: string): BacktestRunRequest {
  return JSON.parse(readFileSync(resolve(OVERLAY_REQUESTS_DIR, name), 'utf8')) as BacktestRunRequest;
}

function loadInlineBundle(name: string): InlineModuleBundle {
  return JSON.parse(readFileSync(resolve(OVERLAY_REQUESTS_DIR, '../bundles', name), 'utf8')) as InlineModuleBundle;
}

// 3 symbols (BTCUSDT/ETHUSDT/SOLUSDT), datasetRef 'universe-fixture-1m' — same fixture pair Task 6's
// (and universe-session-equivalence.test.ts's) Docker golden gate uses.
const universeReq = loadOverlayRequest('universe-multi.json');

describe.skipIf(!DOCKER_AVAILABLE)('bar-major batch twin-equivalence (Docker)', () => {
  it(
    'trusted (batch ON) and sandbox (batch ON, real container, collapsed transport) produce the same result_hash',
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
          barMajorBatch: true,
        });

        const { registry, router } = buildSandboxStrategyBaselineDeps({ spDir: sp.bundleDir });
        try {
          const sandboxed = await runBacktest(universeReq, {
            registry,
            marketTape,
            router,
            barMajor: true,
            barMajorBatch: true,
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
    120_000, // generous: real container boot + collapsed NDJSON IPC over 3 symbols x bars, bar-major batched
  );
});
