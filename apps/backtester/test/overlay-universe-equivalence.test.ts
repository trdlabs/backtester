// Universe-session (17c) scope fix — the OVERLAY-engine run path (`engine:'overlay'`, baseline-vs-
// variant) was NOT universe-threaded: Task 8 wired `runStrategyBacktest`/`worker.ts`'s strategy branch
// but left `runOverlayBacktest` (`OverlayRunDeps`) and `worker.ts`'s overlay branch untouched, so an
// `engine:'overlay'` run with the flag ON still spawned one sandbox session PER SYMBOL for the
// sandboxed overlay bundle (no collapse) — violating the approved spec's "strategy + overlay symmetric"
// requirement.
//
// Mirrors `universe-session-equivalence.test.ts`'s Docker-gated golden pattern verbatim in structure,
// but drives it through the OVERLAY entrypoint (`runOverlayBacktest`, `OverlayRunDeps.universe`,
// `buildSandboxOverlayDeps`'s sandboxed-overlay topology from `overlay-sandbox-equivalence.test.ts`)
// instead of the strategy one: universe ON (router collapses the sandboxed overlay bundle's N
// per-symbol sessions into ONE shared container) must be byte-identical to universe OFF (N sessions),
// for the SAME multi-symbol `engine:'overlay'` variant request.
//
// Reuses the `universe-multi.json` fixture (3 symbols: BTCUSDT/ETHUSDT/SOLUSDT, `universe-fixture-1m`
// dataset) extended in-test with `overlayRefs: [early_exit_short_after_pump]` — the overlay bundle
// logic is symbol-agnostic (operates on `ctx.position`), so it applies uniformly across all 3 symbols'
// independent pump-and-short-then-adverse-drift replays.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { BacktestRunRequest, ModuleBundle as InlineModuleBundle } from '@trading/research-contracts';
import { FixtureDataPort } from '../src/data/reader';
import { contentRef } from '../src/determinism/hash';
import { normalize, restamp } from '../src/jobs/dedup/restamp';
import { buildOverlayDataset } from '../src/engine/data-adapter.js';
import { runOverlayBacktest } from '../src/engine/run-overlay.js';
import type { MaterializedBundle } from '../src/engine/sandbox/bundle-materialize.js';
import { FIXTURES_DIR } from './helpers.js';
import { buildSandboxOverlayDeps, materializeReadableBundle } from './helpers-overlay-sandbox.js';
import { DOCKER_AVAILABLE } from './store-factories.js';

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

// ≥3 symbols (BTCUSDT, ETHUSDT, SOLUSDT), extended with an overlay ref so the SAME multi-symbol
// dataset drives an `engine:'overlay'` variant run (not the strategy-engine path Task 9 covered).
const baseReq = loadOverlayRequest('universe-multi.json');
const variantReq: BacktestRunRequest = {
  ...baseReq,
  overlayRefs: [{ id: 'early_exit_short_after_pump', version: '0.1.0' }],
};

const UNIVERSE_ROUTER_DEPS = { enabled: true, n: variantReq.symbols.length, memBaseMb: 128, memPerSymbolMb: 8 };
const UNIVERSE_RUN_DEPS = { enabled: true, maxN: 64, memBaseMb: 128, memPerSymbolMb: 8 };

describe.skipIf(!DOCKER_AVAILABLE)('overlay-engine universe-session golden gate (Docker)', () => {
  // Falsifiable gate (17c, overlay-path scope fix): per-symbol (universe OFF, N sandboxed-overlay
  // sessions) vs universe (ON, 1 shared container / N instances) result_hash must be byte-identical
  // for the SAME ≥3-symbol `engine:'overlay'` variant request — proving the overlay-engine run path
  // now engages universe collapse, symmetric with the strategy path.
  it(
    'universe ON (one container, N instances) is byte-identical to per-symbol OFF for the overlay-engine variant path',
    async () => {
      // Each runId gets its own materialized overlay-bundle dir + router (own containerSuffix) so the
      // two sandbox runs never collide on a session/universe container name.
      const eeA: MaterializedBundle = await materializeReadableBundle(
        loadInlineBundle('early-exit-short-after-pump.bundle.json'),
      );
      const eeB: MaterializedBundle = await materializeReadableBundle(
        loadInlineBundle('early-exit-short-after-pump.bundle.json'),
      );
      try {
        const marketTape = await buildOverlayDataset(new FixtureDataPort(FIXTURES_DIR), {
          datasetRef: variantReq.datasetRef,
          symbols: variantReq.symbols,
          timeframe: variantReq.timeframe,
          period: variantReq.period,
        });

        const depsA = buildSandboxOverlayDeps({ eeDir: eeA.bundleDir }); // universe OFF
        const depsB = buildSandboxOverlayDeps({
          eeDir: eeB.bundleDir,
          universe: UNIVERSE_ROUTER_DEPS, // universe ON: router collapses N symbols to 1 container
        });
        try {
          const perSymbol = await runOverlayBacktest(
            { ...variantReq, runId: 'run-OVAAAAAA' },
            { registry: depsA.registry, marketTape, router: depsA.router },
          );
          const universe = await runOverlayBacktest(
            { ...variantReq, runId: 'run-OVBBBBBB' },
            {
              registry: depsB.registry,
              marketTape,
              router: depsB.router,
              universe: UNIVERSE_RUN_DEPS,
            },
          );

          expect(perSymbol.status).toBe('completed');
          expect(universe.status).toBe('completed');

          const restamped = restamp(normalize('overlay', perSymbol, 'run-OVAAAAAA'), 'run-OVBBBBBB');
          expect(contentRef(restamped)).toBe(contentRef(universe)); // result_hash, not status
        } finally {
          depsA.router.closeAll();
          depsB.router.closeAll();
        }
      } finally {
        await eeA.cleanup();
        await eeB.cleanup();
      }
    },
    300_000, // generous: two real container boots (1 vs N) + NDJSON IPC over 3 symbols x 30 bars
  );
});

// Task 8/9-style cap reject on the REAL overlay entrypoint. MUST run in every lane (no Docker gate):
// the cap fires BEFORE router/engine construction, so no container is ever spawned for an over-cap
// `engine:'overlay'` request — proving `OverlayRunDeps.universe` threading reaches `runBacktest`'s
// pre-exec validation (SC-003), the same as the strategy entrypoint.
describe('overlay-engine universe-session cap (real overlay entrypoint, no Docker)', () => {
  it('runOverlayBacktest rejects when symbols exceed maxN, before spawning', async () => {
    const marketTape = await buildOverlayDataset(new FixtureDataPort(FIXTURES_DIR), {
      datasetRef: variantReq.datasetRef,
      symbols: variantReq.symbols,
      timeframe: variantReq.timeframe,
      period: variantReq.period,
    });
    const { buildTrustedRegistry } = await import('../src/engine/trusted-registry.js');
    const out = await runOverlayBacktest(
      { ...variantReq, runId: 'run-OVCAP' }, // variantReq has 3 symbols
      {
        registry: buildTrustedRegistry(),
        marketTape,
        universe: { enabled: true, maxN: 1, memBaseMb: 128, memPerSymbolMb: 8 },
      },
    );
    expect(out.status).toBe('rejected');
    if (out.status === 'rejected') {
      expect(out.validation.issues[0]?.path).toBe('/symbols');
    }
  });
});
