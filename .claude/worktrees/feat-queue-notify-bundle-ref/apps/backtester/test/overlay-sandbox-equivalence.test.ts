// Slice-6b-A Task 10 — THE PARITY GATE (Docker-gated). Corrected invariant (the platform's own posture):
//   - SANDBOXED STRATEGY (baseline-only) is BYTE-IDENTICAL to the trusted run + the frozen golden
//     0be9931c…: the strategy session opens at bar 0 via `initStrategy`, so its in-harness
//     `closedCandles` buffer is the full prefix → identical decisions. Mirrors verify_020_equivalence.
//   - SANDBOXED OVERLAY (trusted strategy + sandboxed overlay variant) is DETERMINISTIC (replay
//     byte-identical) + STRUCTURALLY correct (non-zero metricDeltas, patch effect, overlay_early_exit)
//     but NOT byte-equal to the trusted overlay: there is no `initOverlay`, so the overlay session
//     opens lazily on its first `apply` (the entry bar) and its point-in-time `closedCandles` window
//     warms up late. This matches the platform — verify_019_overlay_variant asserts only structural
//     correctness, never sandboxed-overlay byte-parity. The sandboxed overlay is the AUTHORITATIVE
//     untrusted result, not required to byte-match a (different-topology) trusted run.
// Goldens are FROZEN — never refreeze. Skips (does not fail) where no Docker daemon is reachable.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  BacktestRunRequest,
  ModuleBundle as InlineModuleBundle,
} from '@trading/research-contracts';
import { buildOverlayDataset } from '../src/engine/data-adapter.js';
import { runOverlayBacktest } from '../src/engine/run-overlay.js';
import { buildTrustedRegistry } from '../src/engine/trusted-registry.js';
import type { MaterializedBundle } from '../src/engine/sandbox/bundle-materialize.js';
import { FixtureDataPort } from '../src/data/reader.js';
import { contentRef } from '../src/determinism/hash.js';
import { FIXTURES_DIR } from './helpers.js';
import {
  buildSandboxOverlayDeps,
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

/** Dataset selector from a request (same shape the trusted 6a path uses). */
function selFrom(req: BacktestRunRequest) {
  return {
    datasetRef: req.datasetRef,
    symbols: req.symbols,
    timeframe: req.timeframe,
    period: req.period,
  };
}

// Baseline golden (FROZEN — never edited). The sandboxed STRATEGY must MATCH it byte-for-byte.
// (No variant-golden assertion: the sandboxed OVERLAY is gated on determinism + structure, not byte
//  parity with the trusted overlay — see the header.)
const GB = readFileSync(
  new URL('./fixtures/overlay/goldens/baseline.hash', import.meta.url),
  'utf8',
).trim();

const baselineReq = loadRequest('baseline.json');
const variantReq = loadRequest('variant.json');

describe.skipIf(!DOCKER_AVAILABLE)(
  'sandbox-equivalence (strategy: byte-parity vs trusted+golden; overlay: deterministic + structural)',
  () => {
    // Overlay bundle (eeDir) for the VARIANT topology; strategy bundle (spDir) for the BASELINE one.
    let ee: MaterializedBundle;
    let sp: MaterializedBundle;
    // Market tapes built ONCE up-front (before any container churn): the FixtureDataPort reads the
    // fixture JSON off disk, and building per-test races the previous test's Docker FS teardown
    // (loadFixture swallows transient readFile errors → spurious "unknown dataset"). Reused read-only.
    let baselineTape: Awaited<ReturnType<typeof buildOverlayDataset>>;
    let variantTape: Awaited<ReturnType<typeof buildOverlayDataset>>;

    beforeAll(async () => {
      ee = await materializeReadableBundle(
        loadInlineBundle('early-exit-short-after-pump.bundle.json'),
      );
      sp = await materializeReadableBundle(
        loadInlineBundle('short-after-pump.bundle.json'),
      );
      baselineTape = await buildOverlayDataset(new FixtureDataPort(FIXTURES_DIR), selFrom(baselineReq));
      variantTape = await buildOverlayDataset(new FixtureDataPort(FIXTURES_DIR), selFrom(variantReq));
    });

    afterAll(async () => {
      await ee?.cleanup();
      await sp?.cleanup();
    });

    it(
      'BASELINE via SANDBOXED strategy (baseline-only) is byte-identical to trusted + golden 0be9931c',
      async () => {
        const marketTape = baselineTape;

        // Trusted result (6a in-process path).
        const trusted = await runOverlayBacktest(baselineReq, {
          registry: buildTrustedRegistry(),
          marketTape,
        });

        // Sandboxed strategy, NO overlays → single target → strategy `onBarClose` in the container.
        const { registry, router } = buildSandboxStrategyBaselineDeps({ spDir: sp.bundleDir });
        let sandboxed;
        try {
          sandboxed = await runOverlayBacktest(baselineReq, { registry, router, marketTape });
          expect(router.errors()).toEqual([]);
        } finally {
          router.closeAll();
        }

        expect(sandboxed.status).toBe('completed');
        expect(contentRef(sandboxed)).toBe(contentRef(trusted));
        expect(contentRef(sandboxed)).toBe(GB);
      },
      60_000,
    );

    it(
      'VARIANT via trusted-strategy + SANDBOXED overlay: deterministic + structurally correct (NOT byte-equal to trusted — lazy overlay-session PIT window)',
      async () => {
        const marketTape = variantTape;

        // Sandboxed-overlay result (trusted strategy in-process, overlay `apply` in the container).
        const { registry, router } = buildSandboxOverlayDeps({ eeDir: ee.bundleDir });
        let sandboxed;
        try {
          sandboxed = await runOverlayBacktest(variantReq, { registry, router, marketTape });
          expect(router.errors()).toEqual([]);
        } finally {
          router.closeAll();
        }

        // Structural correctness (mirrors trading-platform verify_019_overlay_variant). The sandboxed
        // overlay is the authoritative untrusted result; byte-parity with the trusted overlay is NOT
        // expected (no initOverlay → lazy session → PIT closedCandles window warms late). Determinism
        // is proven by the replay test below.
        expect(sandboxed.status).toBe('completed');
        if (sandboxed.status === 'completed') {
          expect(sandboxed.variant).not.toBeNull();
          expect(sandboxed.comparison).not.toBeNull();
          const v = sandboxed.comparison!.variants[0];
          expect(Object.values(v.metricDeltas).some((d) => d.delta !== 0)).toBe(true);
          expect(v.tradeOutcomeChanged).toBe(true);
          expect(v.overlayEffectsSummary.patch).toBeGreaterThanOrEqual(1);
          expect(
            sandboxed.variant!.trades.some((t) => t.closeReason === 'overlay_early_exit'),
          ).toBe(true);
        }
      },
      60_000,
    );

    it(
      'sandboxed overlay variant is byte-identical on replay (determinism)',
      async () => {
        const marketTape = variantTape;

        const first = buildSandboxOverlayDeps({ eeDir: ee.bundleDir });
        let a;
        try {
          a = await runOverlayBacktest(variantReq, {
            registry: first.registry,
            router: first.router,
            marketTape,
          });
          expect(first.router.errors()).toEqual([]);
        } finally {
          first.router.closeAll();
        }

        const second = buildSandboxOverlayDeps({ eeDir: ee.bundleDir });
        let b;
        try {
          b = await runOverlayBacktest(variantReq, {
            registry: second.registry,
            router: second.router,
            marketTape,
          });
          expect(second.router.errors()).toEqual([]);
        } finally {
          second.router.closeAll();
        }

        expect(contentRef(a)).toBe(contentRef(b));
      },
      60_000,
    );
  },
);
