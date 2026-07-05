// Task 2: `strategyBundles` channel through `buildInlineOverlayRegistry`.
// Verifies: submitted strategy bundle resolves with provenance:'bundle'; single-arg call still
// resolves the trusted short_after_pump with provenance:'trusted' (overlay path byte-identical).
// Pure host-side (materializeBundle is fs-only, no Docker required).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BacktestRunRequest, ModuleBundle as InlineModuleBundle } from '@trading/research-contracts';
import { buildInlineOverlayRegistry } from '../src/engine/trusted-registry.js';
import { materializeBundle } from '../src/engine/sandbox/bundle-materialize.js';
import { loadBundle } from '../src/engine/sandbox/bundle.js';
import { buildOverlayDataset } from '../src/engine/data-adapter.js';
import { FixtureDataPort } from '../src/data/reader.js';
import { FIXTURES_DIR } from './helpers.js';
import { runStrategyBacktest } from '../src/engine/run-strategy.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE_PATH = resolve(HERE, 'fixtures/overlay/bundles/short-after-pump.bundle.json');

describe('strategy-bundle registration (019 registry)', () => {
  it('submitted strategy bundle resolves as baseline with provenance:"bundle"', async () => {
    const inline = JSON.parse(readFileSync(BUNDLE_PATH, 'utf8')) as InlineModuleBundle;
    const { bundleDir, cleanup } = await materializeBundle(inline);
    try {
      // Assemble ModuleBundle (disk layout: descriptor + manifest + bundleDir) same as loadBundle in tests
      const bundle = loadBundle(bundleDir);
      const registry = buildInlineOverlayRegistry([], [bundle]);
      const resolved = registry.resolveStrategy({ id: 'short_after_pump', version: '0.1.0' });
      expect(resolved).toBeDefined();
      expect(resolved!.provenance).toBe('bundle');

      // Overlay path unchanged: single-arg buildInlineOverlayRegistry([]) still resolves
      // the trusted short_after_pump with provenance:'trusted'.
      expect(
        buildInlineOverlayRegistry([]).resolveStrategy({ id: 'short_after_pump', version: '0.1.0' })
          ?.provenance,
      ).toBe('trusted');
    } finally {
      await cleanup();
    }
  });
});

// Task 3: runStrategyBacktest wrapper — baseline-only in-process run, no Docker required.
it('runStrategyBacktest strips engine field and completes baseline-only run (trusted)', async () => {
  const req = JSON.parse(
    readFileSync(resolve(HERE, 'fixtures/overlay/requests/baseline.json'), 'utf8'),
  ) as BacktestRunRequest;
  const reqStrategy = { ...req, engine: 'strategy' as const };
  const registry = buildInlineOverlayRegistry([]);
  const marketTape = await buildOverlayDataset(new FixtureDataPort(FIXTURES_DIR), {
    datasetRef: req.datasetRef,
    symbols: req.symbols,
    timeframe: req.timeframe,
    period: req.period,
  });
  const out = await runStrategyBacktest(reqStrategy, { registry, marketTape });
  expect(out.status).toBe('completed');
});
