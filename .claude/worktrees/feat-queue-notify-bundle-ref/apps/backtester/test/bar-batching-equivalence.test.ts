// Task 5 (17b bar batching) — Docker-gated result_hash golden gate.
//
// Falsifiable proof that the batch path (Task 4's `runSymbol` batching + Task 3's real
// SandboxSession.callHookBatch protocol, run for real through the short_after_pump sandbox
// container) produces the EXACT SAME result_hash as the pre-existing lockstep path, for every
// `maxBars` in [2, 3, 64]: `contentRef(restamped lockstep) === contentRef(batched)`. This is the
// empirical byte-identity proof — everything before this task (unit tests against a scripted fake
// executor) is code-reading assurance about the batch machinery; this suite actually boots two
// real sandbox containers per case and diffs the hashed RunOutcome.
//
// The short_after_pump fixture SIGNALS mid-tape (trades cluster around the pump), so small N (2, 3)
// forces batch boundaries to fall both inside the flat pre-signal stretch AND around the
// in-position stretch after entry — exercising the "batch resumes right after settle" seam, not
// just a single full-tape batch call. N=64 (>= tape length) collapses to (up to) one speculative
// full-tape batch call, exercising the opposite extreme.
//
// Mirrors dedup-equivalence.test.ts's strategy describe block (lines 132-180) verbatim in
// structure: same DOCKER_AVAILABLE skip guard, same materializeReadableBundle / per-runId bundle
// dirs + routers (own containerSuffix, no container-name collision), same
// buildSandboxStrategyBaselineDeps + buildOverlayDataset wiring, same normalize/restamp +
// contentRef comparison route as the dedup cache-hit correctness proof.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { BacktestRunRequest, ModuleBundle as InlineModuleBundle } from '@trading/research-contracts';
import { FixtureDataPort } from '../src/data/reader';
import { contentRef } from '../src/determinism/hash';
import { normalize, restamp } from '../src/jobs/dedup/restamp';
import { buildOverlayDataset } from '../src/engine/data-adapter.js';
import { runStrategyBacktest } from '../src/engine/run-strategy.js';
import type { MaterializedBundle } from '../src/engine/sandbox/bundle-materialize.js';
import { FIXTURES_DIR } from './helpers.js';
import {
  buildSandboxStrategyBaselineDeps,
  materializeReadableBundle,
} from './helpers-overlay-sandbox.js';
import { DOCKER_AVAILABLE } from './store-factories.js';

// ---------------------------------------------------------------------------------------------
// Fixture wiring — verbatim copy of dedup-equivalence.test.ts's strategy-block helpers.
// ---------------------------------------------------------------------------------------------

const OVERLAY_REQUESTS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/overlay/requests',
);

function loadOverlayRequest(name: string): BacktestRunRequest {
  return JSON.parse(readFileSync(resolve(OVERLAY_REQUESTS_DIR, name), 'utf8')) as BacktestRunRequest;
}

function loadInlineBundle(name: string): InlineModuleBundle {
  return JSON.parse(
    readFileSync(resolve(OVERLAY_REQUESTS_DIR, '../bundles', name), 'utf8'),
  ) as InlineModuleBundle;
}

const strategyBaselineReq = loadOverlayRequest('baseline.json'); // moduleRef = short_after_pump@0.1.0

describe.skipIf(!DOCKER_AVAILABLE)('bar-batching golden gate — strategy (Docker)', () => {
  // Falsifiable gate (17b): lockstep vs batched result_hash must be byte-identical for N=2/3/64.
  // The short_after_pump fixture SIGNALS mid-tape, so small N forces batch boundaries around both
  // flat stretches and the in-position cluster.
  for (const maxBars of [2, 3, 64]) {
    it(
      `batched (N=${maxBars}) result is byte-identical to lockstep`,
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
            const lockstep = await runStrategyBacktest(
              { ...strategyBaselineReq, runId: 'run-AAAAAAAA', engine: 'strategy' },
              { registry: depsA.registry, marketTape, router: depsA.router },
            );
            const batched = await runStrategyBacktest(
              { ...strategyBaselineReq, runId: 'run-BBBBBBBB', engine: 'strategy' },
              { registry: depsB.registry, marketTape, router: depsB.router, barBatching: { maxBars } },
            );

            const restamped = restamp(normalize('strategy', lockstep, 'run-AAAAAAAA'), 'run-BBBBBBBB');
            expect(contentRef(restamped)).toBe(contentRef(batched)); // result_hash, not status
          } finally {
            depsA.router.closeAll();
            depsB.router.closeAll();
          }
        } finally {
          await spA.cleanup();
          await spB.cleanup();
        }
      },
      180_000, // generous: two real container boots + NDJSON IPC over ~30 bars
    );
  }

  // Determinism: the batch path itself must be deterministic, independent of the lockstep
  // comparison above — run the SAME maxBars (N=3, mid-tape boundary case) twice through two fresh
  // sandbox containers and require identical contentRef via the same normalize/restamp route.
  it(
    'batched (N=3) is deterministic across repeated runs',
    async () => {
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
          const first = await runStrategyBacktest(
            { ...strategyBaselineReq, runId: 'run-AAAAAAAA', engine: 'strategy' },
            { registry: depsA.registry, marketTape, router: depsA.router, barBatching: { maxBars: 3 } },
          );
          const second = await runStrategyBacktest(
            { ...strategyBaselineReq, runId: 'run-BBBBBBBB', engine: 'strategy' },
            { registry: depsB.registry, marketTape, router: depsB.router, barBatching: { maxBars: 3 } },
          );

          const restamped = restamp(normalize('strategy', first, 'run-AAAAAAAA'), 'run-BBBBBBBB');
          expect(contentRef(restamped)).toBe(contentRef(second));
        } finally {
          depsA.router.closeAll();
          depsB.router.closeAll();
        }
      } finally {
        await spA.cleanup();
        await spB.cleanup();
      }
    },
    180_000,
  );
});
