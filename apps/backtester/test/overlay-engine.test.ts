import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSchemaRegistry } from '../src/engine/validation/schema-registry.js';
import { SCHEMA_IDS } from '@trading/research-contracts/research';
import type { BacktestRunRequest } from '@trading/research-contracts';
import { buildOverlayDataset } from '../src/engine/data-adapter.js';
import { runOverlayBacktest } from '../src/engine/run-overlay.js';
import { buildTrustedRegistry } from '../src/engine/trusted-registry.js';
import { FixtureDataPort } from '../src/data/reader.js';
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

describe('lifted 017 validation runtime', () => {
  it('compiles the core schema registry and resolves a decision branch ref', () => {
    const reg = createSchemaRegistry();
    expect(typeof reg.validateRef).toBe('function');
    // A valid minimal idle decision passes the strategy-decision IdleDecision branch
    // (IdleDecision requires only `kind: 'idle'`, additionalProperties:false).
    const okErrs = reg.validateRef(
      `${SCHEMA_IDS['strategy-decision']}#/definitions/IdleDecision`,
      { kind: 'idle' },
    );
    expect(okErrs).toEqual([]);

    // An obviously-invalid payload (wrong const + extra prop) returns errors.
    const badErrs = reg.validateRef(
      `${SCHEMA_IDS['strategy-decision']}#/definitions/IdleDecision`,
      { kind: 'enter', bogus: true },
    );
    expect(badErrs.length).toBeGreaterThan(0);
  });

  it('materializes an engine MarketTapeDataset from the fixture data port', async () => {
    const port = new FixtureDataPort(FIXTURES_DIR);
    const ds = await buildOverlayDataset(port, {
      datasetRef: 'smoke-btc-1m',
      symbols: ['BTCUSDT'],
      timeframe: '1m',
      period: { from: '2023-11-14T00:00:00.000Z', to: '2023-11-15T00:00:00.000Z' },
    });
    expect(ds.symbols()).toContain('BTCUSDT');
    expect(ds.candles('BTCUSDT').length).toBeGreaterThan(0);
  });
});

describe('runOverlayBacktest — trusted overlay run path (Slice 6a)', () => {
  it('runs baseline (no overlay): completed, no variant/comparison', async () => {
    const req = loadRequest('baseline.json');
    const out = runOverlayBacktest(req, await overlayDeps(req));
    expect(out.status).toBe('completed');
    if (out.status === 'completed') {
      expect(out.variant).toBeNull();
      expect(out.comparison).toBeNull();
      expect(out.baseline.trades.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('runs overlay-variant: completed with baseline + variant + comparison; overlay early-exit', async () => {
    const req = loadRequest('variant.json');
    const out = runOverlayBacktest(req, await overlayDeps(req));
    expect(out.status).toBe('completed');
    if (out.status === 'completed') {
      expect(out.variant).not.toBeNull();
      expect(out.comparison).not.toBeNull();
      expect(out.variant!.trades.some((t) => t.closeReason === 'overlay_early_exit')).toBe(true);
      const deltas = out.comparison!.variants[0].metricDeltas;
      expect(Object.values(deltas).some((d) => d.delta !== 0)).toBe(true);
    }
  });

  it('strips engine before the engine (engine:overlay request still runs)', async () => {
    const req = { ...loadRequest('variant.json'), engine: 'overlay' as const };
    const out = runOverlayBacktest(req, await overlayDeps(req));
    // would be 'rejected' (additionalProperties:false) if `engine` leaked to 017 validation
    expect(out.status).toBe('completed');
  });
});
