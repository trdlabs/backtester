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

// Owned here. These were once derived by running the PLATFORM runBacktest over the 018 request
// fixtures (`scripts/derive_slice6a_goldens.mjs` in trading-platform) — that script and that engine
// no longer exist: 041 removed research/backtest from the platform, which now owns only the
// contract acceptance gates. Ownership moves to `@trdlabs/engine` at Ф2 of `shared-execution-engine`.
//
// Regenerate deliberately, never by hand:
//   pnpm exec tsx apps/backtester/scripts/derive_goldens.mjs           # check (default)
//   pnpm exec tsx apps/backtester/scripts/derive_goldens.mjs --write   # rebase
// A rebase must carry a migration proof — see `contract-version-migration.test.ts`.
const GB = readFileSync(
  new URL('./fixtures/overlay/goldens/baseline.hash', import.meta.url),
  'utf8',
).trim();
const GV = readFileSync(
  new URL('./fixtures/overlay/goldens/variant.hash', import.meta.url),
  'utf8',
).trim();

describe('overlay parity — committed result_hash goldens (Slice 6a CP3)', () => {
  it('request window covers all 30 fixture bars (period.to = 00:30 → half-open includes the last bar)', async () => {
    const req = loadRequest('variant.json');
    const { marketTape } = await overlayDeps(req);
    expect(marketTape.candles('BTCUSDT')).toHaveLength(30);
  });

  it('overlay baseline result_hash equals the committed golden', async () => {
    const req = loadRequest('baseline.json');
    const out = await runOverlayBacktest(req, await overlayDeps(req));
    expect(contentRef(out)).toBe(GB);
  });

  it('overlay variant result_hash equals the committed golden', async () => {
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

  // Grounds the variant/comparison equivalence invariant (overlay-store.test.ts) on the REAL
  // producer: baseline.json carries no overlayRefs (variant/comparison both null), variant.json
  // carries one (variant/comparison both set) — runBacktest sets them together in one branch.
  it('variant != null iff comparison != null on real runOverlayBacktest output (baseline + variant)', async () => {
    const baseReq = loadRequest('baseline.json');
    const baseOut = await runOverlayBacktest(baseReq, await overlayDeps(baseReq));
    expect(baseOut.status).toBe('completed');
    if (baseOut.status === 'completed') {
      expect(baseOut.variant).toBeNull();
      expect(baseOut.variant != null).toBe(baseOut.comparison != null);
    }

    const varReq = loadRequest('variant.json');
    const varOut = await runOverlayBacktest(varReq, await overlayDeps(varReq));
    expect(varOut.status).toBe('completed');
    if (varOut.status === 'completed') {
      expect(varOut.variant).not.toBeNull();
      expect(varOut.variant != null).toBe(varOut.comparison != null);
    }
  });
});
