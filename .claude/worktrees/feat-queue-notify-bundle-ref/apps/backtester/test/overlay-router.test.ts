import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { BacktestRunRequest } from '@trading/research-contracts';
import { runOverlayBacktest } from '../src/engine/run-overlay.js';
import { buildTrustedRegistry } from '../src/engine/trusted-registry.js';
import { buildOverlayDataset } from '../src/engine/data-adapter.js';
import { createTrustedRouter, type ExecutorRouter } from '../src/engine/module-executor.js';
import { FixtureDataPort } from '../src/data/reader.js';
import { contentRef } from '../src/determinism/hash.js';
import { FIXTURES_DIR } from './helpers.js';

const GV = readFileSync(
  new URL('./fixtures/overlay/goldens/variant.hash', import.meta.url),
  'utf8',
).trim();

const variantReq = JSON.parse(
  readFileSync(new URL('./fixtures/overlay/requests/variant.json', import.meta.url), 'utf8'),
) as BacktestRunRequest;

function selFrom(req: BacktestRunRequest) {
  return {
    datasetRef: req.datasetRef,
    symbols: req.symbols,
    timeframe: req.timeframe,
    period: req.period,
  };
}

describe('runOverlayBacktest router seam', () => {
  it('with NO router is byte-identical to 6a (variant golden)', async () => {
    const registry = buildTrustedRegistry();
    const marketTape = await buildOverlayDataset(new FixtureDataPort(FIXTURES_DIR), selFrom(variantReq));
    const out = await runOverlayBacktest(variantReq, { registry, marketTape }); // NO router → trusted path
    expect(contentRef(out)).toBe(GV);
  });

  it('forwards a provided router (it is actually used)', async () => {
    const registry = buildTrustedRegistry();
    const marketTape = await buildOverlayDataset(new FixtureDataPort(FIXTURES_DIR), selFrom(variantReq));
    let forStrategyCalled = false;
    const base = createTrustedRouter();
    const spy: ExecutorRouter = {
      forStrategy: (s) => {
        forStrategyCalled = true;
        return base.forStrategy(s);
      },
      forOverlay: (o) => base.forOverlay(o),
      closeAll: () => base.closeAll(),
    };
    const out = await runOverlayBacktest(variantReq, { registry, marketTape, router: spy });
    // Proves the runner reached into the provided router rather than building its own trusted default.
    expect(forStrategyCalled).toBe(true);
    // Routing through an equivalent trusted router is still byte-identical to 6a.
    expect(contentRef(out)).toBe(GV);
  });
});
