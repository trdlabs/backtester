// Task 9 — golden gate: universe ON (one container, N instances) is byte-identical to per-symbol
// OFF, for the SAME multi-symbol request. Mirrors bar-batching-equivalence.test.ts's Docker-gated
// golden pattern verbatim in structure (materializeReadableBundle, buildSandboxStrategyBaselineDeps,
// buildOverlayDataset, FixtureDataPort, runStrategyBacktest, normalize/restamp/contentRef) — this is
// the empirical byte-identity proof that Task 4's per-symbol harness dispatch rewire, Task 5's
// SandboxSession universe mode, Task 6's per-symbol fail-closed latch and Task 7's router universe
// threading collapse to ONE shared container without changing the hashed RunOutcome.
//
// The `universe-multi.json` fixture request (3 symbols: BTCUSDT/ETHUSDT/SOLUSDT) reads from a
// dedicated `universe-fixture-1m` candle dataset that replicates the short_after_pump golden's
// pump-fixture-1m series onto all 3 symbols — each symbol independently pumps mid-tape and triggers
// the same short entry, so a single-container/N-instance universe run and a one-container-per-symbol
// per-symbol run are directly comparable AND actually exercise the multi-symbol collapse (a
// single-symbol golden would not).

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
// Fixture wiring — verbatim copy of bar-batching-equivalence.test.ts's helpers.
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

// ≥3 symbols (BTCUSDT, ETHUSDT, SOLUSDT) — datasetRef 'universe-fixture-1m' (fixtures/candles),
// each symbol independently replays the same pump-fixture-1m candle series.
const req = loadOverlayRequest('universe-multi.json');

const UNIVERSE_ROUTER_DEPS = { enabled: true, n: req.symbols.length, memBaseMb: 128, memPerSymbolMb: 8 };
const UNIVERSE_RUN_DEPS = { enabled: true, maxN: 64, memBaseMb: 128, memPerSymbolMb: 8 };

describe.skipIf(!DOCKER_AVAILABLE)('universe-session golden gate (Docker)', () => {
  // Falsifiable gate (17c): per-symbol (universe OFF, N containers) vs universe (ON, 1 container /
  // N instances) result_hash must be byte-identical for the SAME ≥3-symbol request.
  it(
    'universe ON (one container, N instances) is byte-identical to per-symbol OFF',
    async () => {
      // Each runId gets its own materialized bundle dir + router (own containerSuffix) so the two
      // sandbox runs never collide on a session/universe container name.
      const spA: MaterializedBundle = await materializeReadableBundle(
        loadInlineBundle('short-after-pump.bundle.json'),
      );
      const spB: MaterializedBundle = await materializeReadableBundle(
        loadInlineBundle('short-after-pump.bundle.json'),
      );
      try {
        const marketTape = await buildOverlayDataset(new FixtureDataPort(FIXTURES_DIR), {
          datasetRef: req.datasetRef,
          symbols: req.symbols,
          timeframe: req.timeframe,
          period: req.period,
        });

        const depsA = buildSandboxStrategyBaselineDeps({ spDir: spA.bundleDir }); // universe OFF
        const depsB = buildSandboxStrategyBaselineDeps({
          spDir: spB.bundleDir,
          universe: UNIVERSE_ROUTER_DEPS, // universe ON: router collapses N symbols to 1 container
        });
        try {
          const perSymbol = await runStrategyBacktest(
            { ...req, runId: 'run-AAAAAAAA', engine: 'strategy' },
            { registry: depsA.registry, marketTape, router: depsA.router },
          );
          const universe = await runStrategyBacktest(
            { ...req, runId: 'run-BBBBBBBB', engine: 'strategy' },
            {
              registry: depsB.registry,
              marketTape,
              router: depsB.router,
              universe: UNIVERSE_RUN_DEPS,
            },
          );

          const restamped = restamp(normalize('strategy', perSymbol, 'run-AAAAAAAA'), 'run-BBBBBBBB');
          expect(contentRef(restamped)).toBe(contentRef(universe)); // result_hash, not status
        } finally {
          depsA.router.closeAll();
          depsB.router.closeAll();
        }
      } finally {
        await spA.cleanup();
        await spB.cleanup();
      }
    },
    300_000, // generous: two real container boots (1 vs N) + NDJSON IPC over 3 symbols x 30 bars
  );

  // Task 6/9 — per-symbol fail-closed: ETHUSDT's onBarClose always throws (fixture bundle). The
  // harness catches it, the session latches ETHUSDT to idle for ALL its remaining bars WITHOUT
  // tearing down the shared container; BTCUSDT/SOLUSDT are unaffected and trade normally. Proven
  // under BOTH per-symbol and universe routing, AND byte-identical to each other under the SAME
  // injected failure.
  it(
    "one symbol's instance failure degrades only that symbol; the run completes and is byte-identical to per-symbol under the same injected failure",
    async () => {
      const spA: MaterializedBundle = await materializeReadableBundle(
        loadInlineBundle('short-after-pump-failing.bundle.json'),
      );
      const spB: MaterializedBundle = await materializeReadableBundle(
        loadInlineBundle('short-after-pump-failing.bundle.json'),
      );
      try {
        const marketTape = await buildOverlayDataset(new FixtureDataPort(FIXTURES_DIR), {
          datasetRef: req.datasetRef,
          symbols: req.symbols,
          timeframe: req.timeframe,
          period: req.period,
        });

        const depsA = buildSandboxStrategyBaselineDeps({ spDir: spA.bundleDir }); // universe OFF
        const depsB = buildSandboxStrategyBaselineDeps({
          spDir: spB.bundleDir,
          universe: UNIVERSE_ROUTER_DEPS,
        });
        try {
          const perSymbol = await runStrategyBacktest(
            { ...req, runId: 'run-FAILAAAA', engine: 'strategy' },
            { registry: depsA.registry, marketTape, router: depsA.router },
          );
          const universe = await runStrategyBacktest(
            { ...req, runId: 'run-FAILBBBB', engine: 'strategy' },
            {
              registry: depsB.registry,
              marketTape,
              router: depsB.router,
              universe: UNIVERSE_RUN_DEPS,
            },
          );

          expect(perSymbol.status).toBe('completed');
          expect(universe.status).toBe('completed');
          if (perSymbol.status !== 'completed' || universe.status !== 'completed') {
            throw new Error('expected both runs to complete'); // unreachable after the assertions above
          }

          for (const outcome of [perSymbol, universe] as const) {
            const ethRecords = outcome.baseline.decisionRecords.filter((d) => d.symbol === 'ETHUSDT');
            expect(ethRecords.length).toBeGreaterThan(0); // ETHUSDT was actually processed (idle, latched)
            expect(ethRecords.every((d) => d.baseDecision.kind === 'idle')).toBe(true);
            expect(outcome.baseline.trades.some((t) => t.symbol === 'ETHUSDT')).toBe(false);
            expect(outcome.baseline.trades.some((t) => t.symbol === 'BTCUSDT')).toBe(true);
            expect(outcome.baseline.trades.some((t) => t.symbol === 'SOLUSDT')).toBe(true);
          }

          // Executor error diagnostics are symbol-tagged (surfaced to router.errors(), not part of
          // the hashed RunOutcome) on BOTH the per-symbol and universe path.
          expect(depsA.router.errors().some((e) => e.symbol === 'ETHUSDT')).toBe(true);
          expect(depsB.router.errors().some((e) => e.symbol === 'ETHUSDT')).toBe(true);

          // Byte-identical vs the per-symbol path under the SAME injected failure.
          const restamped = restamp(normalize('strategy', perSymbol, 'run-FAILAAAA'), 'run-FAILBBBB');
          expect(contentRef(restamped)).toBe(contentRef(universe));
        } finally {
          depsA.router.closeAll();
          depsB.router.closeAll();
        }
      } finally {
        await spA.cleanup();
        await spB.cleanup();
      }
    },
    300_000,
  );
});

// Task 8/9 — cap reject on the REAL strategy entrypoint. MUST run in every lane (no Docker gate):
// the cap fires BEFORE router/engine construction, so no container is ever spawned for an over-cap
// request (SC-003 pre-exec validation, not only the HTTP submit handler).
describe('universe-session cap (real strategy entrypoint, no Docker)', () => {
  it('runStrategyBacktest rejects when symbols exceed maxN, before spawning', async () => {
    const spA: MaterializedBundle = await materializeReadableBundle(
      loadInlineBundle('short-after-pump.bundle.json'),
    );
    try {
      const marketTape = await buildOverlayDataset(new FixtureDataPort(FIXTURES_DIR), {
        datasetRef: req.datasetRef,
        symbols: req.symbols,
        timeframe: req.timeframe,
        period: req.period,
      });
      const deps = buildSandboxStrategyBaselineDeps({ spDir: spA.bundleDir });
      try {
        const out = await runStrategyBacktest(
          { ...req, runId: 'run-CAP', engine: 'strategy' }, // req has 3 symbols
          {
            registry: deps.registry,
            marketTape,
            router: deps.router,
            universe: { enabled: true, maxN: 1, memBaseMb: 128, memPerSymbolMb: 8 },
          },
        );
        expect(out.status).toBe('rejected');
        if (out.status === 'rejected') {
          expect(out.validation.issues[0]?.path).toBe('/symbols');
        }
      } finally {
        deps.router.closeAll();
      }
    } finally {
      await spA.cleanup();
    }
  });
});
