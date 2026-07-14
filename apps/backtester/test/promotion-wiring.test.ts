// E4b Task 8 — worker wiring for the held-out promotion gate (advisory field + v2 evidence swap).
//
// Drives ONE strategy-engine job through the real worker loop (processNextQueued) with a bundle-carrying
// request (short_after_pump lifecycle bundle via InMemoryBundleStore — sandboxBundleFor/overlayRouterFor
// run for REAL, no Docker container is ever spawned because the candidate engine call itself
// (runStrategyBacktest) is mocked below; sandboxBundleFor only materializes bundle bytes to a temp dir,
// which is plain file I/O). vi.spyOn(workerInternals, 'resolvePromotionGate') stands in for the real
// gate (integrity/window/ledger — already covered by resolve-promotion.test.ts), so this test proves
// ONLY the wiring: the worker calls the gate for enabled+promotion, threads `promotion` onto the summary
// post-hash, swaps evidenceRef to v2, skips the v1 evidence block for promotion runs, and never fails
// the run on a gate throw.
//
// Contract table (task-8-brief.md):
//   flag OFF                                          ⇒ summary.promotion undefined; gate never called
//   flag ON + mode:'promotion' + gate→passed           ⇒ summary.promotion.verdict==='passed' AND
//                                                         evidenceRef.artifactType==='backtest-evidence/v2'
//                                                         (v1 evidence block is skipped, not just overwritten)
//   flag ON + mode:'promotion' + gate→not_qualified    ⇒ summary.promotion set, reason correct, no v2 ref
//   mode!=='promotion' (research) with flag ON         ⇒ summary.promotion undefined; gate never called
//   resolvePromotionGate THROWS                        ⇒ summary.promotion={verdict:'not_qualified',
//                                                         reason:'internal_error'}; run still completes

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BacktestRunRequest, ModuleBundle, RunSubmitRequest } from '@trading/research-contracts';
import { processNextQueued, workerInternals, type WorkerDeps } from '../src/jobs/worker.js';
import type { ContentHash } from '@trading-backtester/sdk/artifacts';
import { InMemoryJobStore, type NewJob } from '../src/jobs/job-store.js';
import { InMemoryArtifactStore } from '../src/artifacts/store.js';
import { InMemoryBundleStore } from '../src/sandbox/bundle-store.js';
import { FixtureDataPort } from '../src/data/reader.js';
import { FIXTURES_DIR } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { InMemoryPromotionAttemptLedger } from '../src/jobs/promotion/attempt-ledger.js';
import { DatasetIdentityEpochResolver } from '../src/jobs/promotion/epoch-resolver.js';
import { buildPromotionPolicy } from '../src/jobs/promotion/resolve-promotion.js';
import { generateSigningKey } from '../src/evidence/signing.js';
import * as runStrategyModule from '../src/engine/run-strategy.js';
import * as runOverlayModule from '../src/engine/run-overlay.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OVERLAY_REQUESTS_DIR = resolve(HERE, 'fixtures/overlay/requests');
const OVERLAY_BUNDLES_DIR = resolve(HERE, 'fixtures/overlay/bundles');

const loadOverlayRequest = (n: string): BacktestRunRequest =>
  JSON.parse(readFileSync(resolve(OVERLAY_REQUESTS_DIR, n), 'utf8')) as BacktestRunRequest;
const loadInlineBundle = (n: string): ModuleBundle =>
  JSON.parse(readFileSync(resolve(OVERLAY_BUNDLES_DIR, n), 'utf8')) as ModuleBundle;

const CLOCK = 1_700_000_000_000;
// baseline.json: moduleRef short_after_pump@0.1.0, datasetRef 'pump-fixture-1m' — matches the bundle
// manifest below (strategy pre-flight validation requires moduleRef == manifest.id/version).
const { runId: _baselineRunId, ...STRATEGY_REQ_BASE } = loadOverlayRequest('baseline.json');
const STRATEGY_BUNDLE = loadInlineBundle('short-after-pump.bundle.json');

// Minimal-but-runtime-complete CompletedOutcome — only the fields finalizeResult / persistOverlayArtifacts
// / toOverlaySummary actually read (mirrors walk-forward-integration.test.ts's cannedOutcome).
function cannedOutcome(): unknown {
  return {
    status: 'completed',
    baseline: {
      runId: 'unused',
      metrics: { pnl: 10 },
      trades: [],
      decisionRecords: [],
      evidence: {
        seed: 12345,
        contractVersion: '1.0.0',
        moduleVersions: [{ id: 'short_after_pump', version: '0.1.0' }],
        datasetRef: STRATEGY_REQ_BASE.datasetRef,
        equityCurve: [],
      },
    },
    variant: null,
    comparison: null,
  };
}

function strategyJob(
  runId: string,
  bundleHash: ContentHash,
  opts: { mode?: 'research' | 'review' | 'promotion'; curatedBaselineRef?: { id: string; version: string } } = {},
): NewJob {
  return {
    jobId: runId,
    runId,
    requestFingerprint: `fp-${runId}`,
    request: {
      ...STRATEGY_REQ_BASE,
      engine: 'strategy',
      mode: opts.mode ?? 'promotion',
      metrics: ['pnl', 'win_rate'],
      ...(opts.curatedBaselineRef ? { curatedBaselineRef: opts.curatedBaselineRef } : {}),
    } as unknown as RunSubmitRequest,
    effectiveSeed: STRATEGY_REQ_BASE.seed,
    datasetRef: STRATEGY_REQ_BASE.datasetRef,
    bundleHash,
    runTimeoutMs: 3_600_000,
    acceptedAtMs: CLOCK,
  };
}

async function makeDeps(overrides: Partial<WorkerDeps> = {}): Promise<{
  deps: WorkerDeps;
  store: InMemoryJobStore;
  bundleStore: InMemoryBundleStore;
}> {
  const config = loadConfig();
  const store = new InMemoryJobStore();
  const bundleStore = new InMemoryBundleStore();
  const deps = {
    store,
    clock: () => CLOCK,
    uid: () => randomUUID(),
    postWebhook: async () => {},
    dataPort: new FixtureDataPort(FIXTURES_DIR),
    artifactStore: new InMemoryArtifactStore(),
    bundleStore,
    overlaySandbox: config.overlaySandbox,
    ...overrides,
  } as WorkerDeps;
  return { deps, store, bundleStore };
}

function promotionDepsField() {
  return {
    enabled: true,
    ledger: new InMemoryPromotionAttemptLedger(),
    epochResolver: new DatasetIdentityEpochResolver(new FixtureDataPort(FIXTURES_DIR)),
    policy: buildPromotionPolicy({ holdoutFraction: 0.2 }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('E4b — worker promotion-gate wiring', () => {
  it('flag OFF (deps.promotion absent) ⇒ no summary.promotion; gate never called', async () => {
    const { deps, store, bundleStore } = await makeDeps();
    const bundleHash = await bundleStore.put(STRATEGY_BUNDLE);
    vi.spyOn(runStrategyModule, 'runStrategyBacktest').mockResolvedValue(cannedOutcome() as never);
    const gateSpy = vi.spyOn(workerInternals, 'resolvePromotionGate');

    const runId = 'run-promo-off';
    await store.insertOrGet(strategyJob(runId, bundleHash));
    await store.transition(runId, 'accepted', 'queued', { atMs: CLOCK, queuedAtMs: CLOCK });

    const row = await processNextQueued(deps);
    expect(row?.status).toBe('completed');
    expect(row?.resultSummary?.promotion).toBeUndefined();
    expect(gateSpy).not.toHaveBeenCalled();
  });

  it("flag ON + mode:'promotion' + gate→passed ⇒ summary.promotion.verdict='passed' + v2 evidenceRef (v1 skipped)", async () => {
    const { deps, store, bundleStore } = await makeDeps({
      promotion: promotionDepsField(),
      evidenceSigningKey: generateSigningKey(),
    });
    const bundleHash = await bundleStore.put(STRATEGY_BUNDLE);
    vi.spyOn(runStrategyModule, 'runStrategyBacktest').mockResolvedValue(cannedOutcome() as never);
    vi.spyOn(runOverlayModule, 'runOverlayBacktest').mockResolvedValue(cannedOutcome() as never);
    const gateSpy = vi.spyOn(workerInternals, 'resolvePromotionGate').mockResolvedValue({
      promotion: {
        verdict: 'passed',
        attemptNumber: 1,
        evaluationWindow: { from: '2025-01-01T00:00:00Z', to: '2025-01-01T00:10:00Z' },
        evaluatedOn: 'holdout',
      },
      evidenceRef: { artifactId: 'sha256:v2', artifactType: 'backtest-evidence/v2', availability: 'available' },
    } as never);

    const runId = 'run-promo-passed';
    await store.insertOrGet(
      strategyJob(runId, bundleHash, { curatedBaselineRef: { id: 'short_after_pump', version: '0.1.0' } }),
    );
    await store.transition(runId, 'accepted', 'queued', { atMs: CLOCK, queuedAtMs: CLOCK });

    const row = await processNextQueued(deps);
    expect(row?.status).toBe('completed');
    expect(gateSpy).toHaveBeenCalledTimes(1);
    expect((row?.resultSummary?.promotion as { verdict: string } | undefined)?.verdict).toBe('passed');
    expect((row?.resultSummary?.evidenceRef as { artifactType: string } | undefined)?.artifactType).toBe(
      'backtest-evidence/v2',
    );
  });

  it("flag ON + mode:'promotion' + gate→not_qualified/holdout_not_covered ⇒ summary.promotion set, no v2 evidenceRef", async () => {
    const { deps, store, bundleStore } = await makeDeps({
      promotion: promotionDepsField(),
      evidenceSigningKey: generateSigningKey(),
    });
    const bundleHash = await bundleStore.put(STRATEGY_BUNDLE);
    vi.spyOn(runStrategyModule, 'runStrategyBacktest').mockResolvedValue(cannedOutcome() as never);
    vi.spyOn(runOverlayModule, 'runOverlayBacktest').mockResolvedValue(cannedOutcome() as never);
    const gateSpy = vi.spyOn(workerInternals, 'resolvePromotionGate').mockResolvedValue({
      promotion: { verdict: 'not_qualified', reason: 'holdout_not_covered', evaluatedOn: 'holdout' },
    } as never);

    const runId = 'run-promo-not-qualified';
    await store.insertOrGet(
      strategyJob(runId, bundleHash, { curatedBaselineRef: { id: 'short_after_pump', version: '0.1.0' } }),
    );
    await store.transition(runId, 'accepted', 'queued', { atMs: CLOCK, queuedAtMs: CLOCK });

    const row = await processNextQueued(deps);
    expect(row?.status).toBe('completed');
    expect(gateSpy).toHaveBeenCalledTimes(1);
    const promotion = row?.resultSummary?.promotion as { verdict: string; reason?: string } | undefined;
    expect(promotion?.verdict).toBe('not_qualified');
    expect(promotion?.reason).toBe('holdout_not_covered');
    expect(row?.resultSummary?.evidenceRef).toBeUndefined();
  });

  it("mode!=='promotion' (research) with flag ON ⇒ no summary.promotion; gate never called", async () => {
    const { deps, store, bundleStore } = await makeDeps({ promotion: promotionDepsField() });
    const bundleHash = await bundleStore.put(STRATEGY_BUNDLE);
    vi.spyOn(runStrategyModule, 'runStrategyBacktest').mockResolvedValue(cannedOutcome() as never);
    const gateSpy = vi.spyOn(workerInternals, 'resolvePromotionGate');

    const runId = 'run-promo-research-mode';
    await store.insertOrGet(strategyJob(runId, bundleHash, { mode: 'research' }));
    await store.transition(runId, 'accepted', 'queued', { atMs: CLOCK, queuedAtMs: CLOCK });

    const row = await processNextQueued(deps);
    expect(row?.status).toBe('completed');
    expect(row?.resultSummary?.promotion).toBeUndefined();
    expect(gateSpy).not.toHaveBeenCalled();
  });

  it('resolvePromotionGate THROWS ⇒ promotion={verdict:not_qualified, reason:internal_error}; run still completes', async () => {
    const { deps, store, bundleStore } = await makeDeps({ promotion: promotionDepsField() });
    const bundleHash = await bundleStore.put(STRATEGY_BUNDLE);
    vi.spyOn(runStrategyModule, 'runStrategyBacktest').mockResolvedValue(cannedOutcome() as never);
    const gateSpy = vi.spyOn(workerInternals, 'resolvePromotionGate').mockRejectedValue(new Error('boom'));

    const runId = 'run-promo-throw';
    await store.insertOrGet(strategyJob(runId, bundleHash));
    await store.transition(runId, 'accepted', 'queued', { atMs: CLOCK, queuedAtMs: CLOCK });

    const row = await processNextQueued(deps);
    expect(row?.status).toBe('completed');
    expect(gateSpy).toHaveBeenCalledTimes(1);
    const promotion = row?.resultSummary?.promotion as { verdict: string; reason?: string } | undefined;
    expect(promotion?.verdict).toBe('not_qualified');
    expect(promotion?.reason).toBe('internal_error');
  });
});
