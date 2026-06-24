import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BacktestRunRequest } from '@trading/research-contracts';
import { buildOverlayDataset } from '../src/engine/data-adapter.js';
import { runOverlayBacktest } from '../src/engine/run-overlay.js';
import { buildTrustedRegistry } from '../src/engine/trusted-registry.js';
import { FixtureDataPort } from '../src/data/reader.js';
import { contentRef } from '../src/determinism/hash.js';
import { FIXTURES_DIR } from './helpers.js';

const OVERLAY_REQUESTS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/overlay/requests',
);

function loadRequest(name: string): BacktestRunRequest {
  return JSON.parse(
    readFileSync(resolve(OVERLAY_REQUESTS_DIR, name), 'utf8'),
  ) as BacktestRunRequest;
}

async function overlayDeps(req: BacktestRunRequest) {
  const registry = buildTrustedRegistry();
  const marketTape = await buildOverlayDataset(new FixtureDataPort(FIXTURES_DIR), {
    datasetRef: req.datasetRef,
    symbols: req.symbols,
    timeframe: req.timeframe,
    period: req.period,
  });
  return { registry, marketTape };
}

// Platform-derived goldens: produced by running the PLATFORM runBacktest over the
// 018 request fixtures and hashing with the shared canonical-json
// (scripts/derive_slice6a_goldens.mjs in trading-platform). NEVER frozen from the
// backtester's own output — the backtester must MATCH these.
const GB = readFileSync(
  new URL('./fixtures/overlay/goldens/baseline.hash', import.meta.url),
  'utf8',
).trim();
const GV = readFileSync(
  new URL('./fixtures/overlay/goldens/variant.hash', import.meta.url),
  'utf8',
).trim();

describe('overlay parity — platform-derived result_hash goldens (Slice 6a CP3)', () => {
  it('request window covers all 30 fixture bars (period.to = 00:30 → half-open includes the last bar)', async () => {
    const req = loadRequest('variant.json');
    const { marketTape } = await overlayDeps(req);
    expect(marketTape.candles('BTCUSDT')).toHaveLength(30);
  });

  it('overlay baseline result_hash equals the platform-derived golden', async () => {
    const req = loadRequest('baseline.json');
    const out = await runOverlayBacktest(req, await overlayDeps(req));
    expect(contentRef(out)).toBe(GB);
  });

  it('overlay variant result_hash equals the platform-derived golden', async () => {
    const req = loadRequest('variant.json');
    const out = await runOverlayBacktest(req, await overlayDeps(req));
    expect(contentRef(out)).toBe(GV);
  });

  it('overlay output is byte-identical on replay', async () => {
    const req = loadRequest('variant.json');
    const a = await runOverlayBacktest(req, await overlayDeps(req));
    const b = await runOverlayBacktest(req, await overlayDeps(req));
    expect(contentRef(a)).toBe(contentRef(b));
  });
});
