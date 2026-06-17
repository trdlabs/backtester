// Slice-6b-A — Docker-gated SMOKE: an overlay backtest driven THROUGH the lifted sandbox executor
// router completes against a REAL container. Boots a session container, drives the overlay `apply`
// hook over NDJSON IPC per bar, revalidates returned decisions, and tears the session down.
//
// This is NOT the byte-parity gate (Task 10) — it asserts only that the sandbox path COMPLETES with
// no router errors. Skips (does not fail) where no Docker daemon is reachable — mirrors the Slice-3
// `sandbox.test.ts` gating.
//
// Topology: trusted strategy + sandboxed overlay (see helpers-overlay-sandbox.ts) — the canonical
// lifted overlay-sandbox shape mirrored from the platform's verify_019_overlay_variant.mjs.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BacktestRunRequest, ModuleBundle as InlineModuleBundle } from '@trading/research-contracts';
import { buildOverlayDataset } from '../src/engine/data-adapter.js';
import { runOverlayBacktest } from '../src/engine/run-overlay.js';
import type { MaterializedBundle } from '../src/engine/sandbox/bundle-materialize.js';
import { FixtureDataPort } from '../src/data/reader.js';
import { FIXTURES_DIR } from './helpers.js';
import { buildSandboxOverlayDeps, materializeReadableBundle } from './helpers-overlay-sandbox.js';
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

describe.skipIf(!DOCKER_AVAILABLE)('overlay sandbox session (real container)', () => {
  let ee: MaterializedBundle;

  beforeAll(async () => {
    ee = await materializeReadableBundle(loadInlineBundle('early-exit-short-after-pump.bundle.json'));
  });

  afterAll(async () => {
    await ee?.cleanup();
  });

  it(
    'runs an overlay backtest THROUGH the sandbox executor: completes, no router errors, sessions torn down',
    async () => {
      const req = loadRequest('variant.json');
      const marketTape = await buildOverlayDataset(new FixtureDataPort(FIXTURES_DIR), {
        datasetRef: req.datasetRef,
        symbols: req.symbols,
        timeframe: req.timeframe,
        period: req.period,
      });

      const { registry, router } = buildSandboxOverlayDeps({ eeDir: ee.bundleDir });

      try {
        const out = runOverlayBacktest(req, { registry, router, marketTape });

        expect(out.status).toBe('completed');
        if (out.status === 'completed') {
          // The overlay variant was produced (baseline + overlay-composed variant).
          expect(out.variant).not.toBeNull();
          // The overlay `apply` hook actually executed in the container → the variant traded.
          expect(out.variant!.trades.length).toBeGreaterThanOrEqual(1);
        }

        // Clean sandbox run: container booted, IPC round-tripped, decisions revalidated — no errors.
        expect(router.errors()).toEqual([]);
      } finally {
        // Tears down session containers (docker rm -f) — deterministic cleanup.
        router.closeAll();
      }
    },
    60_000, // generous: real container boot + 30 bars of synchronous NDJSON IPC
  );
});
