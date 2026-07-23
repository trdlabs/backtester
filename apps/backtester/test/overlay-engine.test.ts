import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSchemaRegistry } from '../src/engine/validation/schema-registry.js';
import { SCHEMA_IDS } from '@trading/research-contracts/research';
import type {
  BacktestRunRequest,
  ModuleBundle,
  RunResultSummary,
  RunStatusView,
} from '@trading/research-contracts';
import { buildOverlayDataset } from '../src/engine/data-adapter.js';
import { runOverlayBacktest } from '../src/engine/run-overlay.js';
import { buildTrustedRegistry } from '../src/engine/trusted-registry.js';
import { FixtureDataPort } from '../src/data/reader.js';
import { AUTH, buildTestApp, FIXTURES_DIR } from './helpers.js';
import { bundleHash } from '../src/sandbox/bundle.js';
import { DOCKER_AVAILABLE } from './store-factories.js';

const OVERLAY_REQUESTS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/overlay/requests',
);
const OVERLAY_BUNDLES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/overlay/bundles',
);

function loadRequest(name: string): BacktestRunRequest {
  return JSON.parse(
    readFileSync(resolve(OVERLAY_REQUESTS_DIR, name), 'utf8'),
  ) as BacktestRunRequest;
}

function loadInlineBundle(name: string) {
  return JSON.parse(
    readFileSync(resolve(OVERLAY_BUNDLES_DIR, name), 'utf8'),
  ) as ModuleBundle;
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
    const out = await runOverlayBacktest(req, await overlayDeps(req));
    expect(out.status).toBe('completed');
    if (out.status === 'completed') {
      expect(out.variant).toBeNull();
      expect(out.comparison).toBeNull();
      expect(out.baseline.trades.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('zero-overlays edge case: variant === null, comparison === null, headline = baseline (≥1 trade)', async () => {
    // Impl-note 1: a no-overlay request yields a completed RunOutcome whose variant and
    // comparison are explicitly null (not undefined), and whose headline result is the baseline.
    const req = loadRequest('baseline.json');
    expect(req.overlayRefs ?? []).toHaveLength(0);
    const out = await runOverlayBacktest(req, await overlayDeps(req));
    expect(out.status).toBe('completed');
    if (out.status === 'completed') {
      expect(out.variant).toBeNull();
      expect(out.comparison).toBeNull();
      expect(out.baseline.trades.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('runs overlay-variant: completed with baseline + variant + comparison; overlay early-exit', async () => {
    const req = loadRequest('variant.json');
    const out = await runOverlayBacktest(req, await overlayDeps(req));
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
    const out = await runOverlayBacktest(req, await overlayDeps(req));
    // would be 'rejected' (additionalProperties:false) if `engine` leaked to 017 validation
    expect(out.status).toBe('completed');
  });
});

describe('buildOverlayDataset — period guard (Slice 6b-a)', () => {
  it('rejects an unparseable period with a RunnerError(validation_error)', async () => {
    await expect(
      buildOverlayDataset(new FixtureDataPort(FIXTURES_DIR), {
        datasetRef: 'pump-fixture-1m',
        symbols: ['BTCUSDT'],
        timeframe: '1m',
        period: { from: 'not-a-date', to: 'also-bad' },
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });
});

describe('overlay engine — end-to-end through the worker (Slice 6a CP4)', () => {
  // Committed golden, owned here (see overlay-golden.test.ts for provenance and how to regenerate).
  const GV = readFileSync(
    new URL('./fixtures/overlay/goldens/variant.hash', import.meta.url),
    'utf8',
  ).trim();

  async function submitDrainResult(
    body: BacktestRunRequest & { engine: 'overlay' },
  ): Promise<RunResultSummary> {
    const app = await buildTestApp({ enableOverlayEngine: true });
    try {
      const submit = await app.server.inject({
        method: 'POST',
        url: '/v1/runs',
        headers: AUTH,
        payload: body,
      });
      expect(submit.statusCode).toBe(202);

      expect(await app.drain()).toBe(1);

      const status = (
        await app.server.inject({ url: `/v1/runs/${body.runId}/status`, headers: AUTH })
      ).json() as RunStatusView;
      expect(status.status).toBe('completed');

      return (
        await app.server.inject({ url: `/v1/runs/${body.runId}/result`, headers: AUTH })
      ).json() as RunResultSummary;
    } finally {
      await app.dispose();
    }
  }

  it('overlay variant job runs end-to-end and result_hash hits the committed golden', async () => {
    const variantReq = loadRequest('variant.json');
    const result = await submitDrainResult({ ...variantReq, engine: 'overlay' });
    expect(result.resultHash).toBe(GV);
    expect(result.comparison).toBeDefined();
    expect(
      Object.values(result.comparison!.variants[0].metricDeltas).some((d) => d.delta !== 0),
    ).toBe(true);
    expect(result.evidence.datasetFingerprint).toMatch(/^sha256:/);
  });

  it('overlay baseline (no overlayRefs) completes with comparison omitted', async () => {
    const baselineReq = loadRequest('baseline.json');
    const result = await submitDrainResult({ ...baselineReq, engine: 'overlay' });
    expect(result.resultHash).toMatch(/^sha256:/);
    expect(result.comparison).toBeUndefined();
    expect('comparison' in result).toBe(false);
  });
});

describe.skipIf(!DOCKER_AVAILABLE)('overlay worker — sandboxed overlay bundle path', () => {
  it('accepts an overlay bundle, runs it in the sandbox, and preserves bundleHash evidence', async () => {
    const app = await buildTestApp({ enableOverlayEngine: true });
    try {
      const variantReq = loadRequest('variant.json');
      const bundle = loadInlineBundle('early-exit-short-after-pump.bundle.json');
      const submit = await app.server.inject({
        method: 'POST',
        url: '/v1/runs',
        headers: AUTH,
        payload: {
          ...variantReq,
          engine: 'overlay',
          moduleBundle: bundle,
        },
      });
      expect(submit.statusCode).toBe(202);

      expect(await app.drain()).toBe(1);

      const result = (
        await app.server.inject({ url: `/v1/runs/${variantReq.runId}/result`, headers: AUTH })
      ).json() as RunResultSummary;
      expect(result.status).toBe('completed');
      expect(result.evidence.bundleHash).toBe(bundleHash(bundle));
      expect(result.comparison).toBeDefined();
      expect(
        Object.values(result.comparison!.variants[0].metricDeltas).some((d) => d.delta !== 0),
      ).toBe(true);
      expect(result.metrics.win_rate).toBeDefined();
    } finally {
      await app.dispose();
    }
  }, 60_000);
});
