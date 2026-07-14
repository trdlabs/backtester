// E4b — worker orchestration `resolvePromotionGate` (Task 7 part B). Injected fixtures only, NO
// Docker/DB. Bundle fixture mirrors produce-strategy-evidence.test.ts (materializeBundle + loadBundle)
// so `bundleRejected` runs the REAL acceptance-gate over a real on-disk bundle — the acceptance-gate's
// `ModuleBundle` (engine/sandbox/bundle.js: bundleDir+manifest+descriptor) is NOT the in-memory
// `@trading/research-contracts` ModuleBundle (manifest+entry+files) that `makeBundle()` in helpers.ts
// returns, so `makeBundle()` is not usable here — see report anchor note.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EquityPoint, Trade } from '../src/engine/artifacts.js';
import type { CompletedOutcome } from '../src/engine/window-eval.js';
import { materializeBundle } from '../src/engine/sandbox/bundle-materialize.js';
import { loadBundle, type ModuleBundle } from '../src/engine/sandbox/bundle.js';
import type { ModuleBundle as InlineModuleBundle, RunPeriod, RunSubmitRequest } from '@trading/research-contracts';
import { generateSigningKey } from '../src/evidence/signing.js';
import { InMemoryPromotionAttemptLedger } from '../src/jobs/promotion/attempt-ledger.js';
import type { QualificationEpochResolver } from '../src/jobs/promotion/epoch-resolver.js';
import {
  buildPromotionPolicy,
  resolvePromotionGate,
  type PromotionCtx,
  type PromotionDeps,
} from '../src/jobs/promotion/resolve-promotion.js';
import { runBody } from './helpers.js';
import type { JobRow } from '../src/jobs/job-store.js';

const DAY = 86_400_000;
const pt = (d: number, e: number): EquityPoint => ({ barIndex: d, barTs: d * DAY, equity: e });
function oc(eq: EquityPoint[], tr: Trade[] = []): CompletedOutcome {
  return { status: 'completed', baseline: { trades: tr, evidence: { equityCurve: eq } } } as unknown as CompletedOutcome;
}
const trd = (entryDay: number, exitDay: number, pnl: number): Trade =>
  ({
    id: `t${entryDay}`, symbol: 'X', side: 'long', entryBarIndex: 0, entryTs: entryDay * DAY,
    entryFillPrice: 1, exitBarIndex: 1, exitTs: exitDay * DAY, exitFillPrice: 1 + pnl,
    size: 1, feePaid: 0, realizedPnl: pnl, closeReason: 'end_of_data',
  }) as Trade;

// Same shape as promotion-gate.test.ts: 3 pre-holdout steps (day 1,3,5), holdout window [6d,10d) via
// policy fraction 0.4 over coverage [0,10d] ⇒ window [6d,10d].
const warmEquity = [pt(1, 100), pt(3, 105), pt(5, 108), pt(7, 120), pt(8, 118), pt(9, 130)];
const RUN_PERIOD: RunPeriod = { from: new Date(0).toISOString(), to: new Date(10 * DAY).toISOString() };
const COVERAGE: RunPeriod = RUN_PERIOD;

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLES_DIR = join(HERE, 'fixtures/overlay/bundles');
function loadInlineBundle(name: string): InlineModuleBundle {
  return JSON.parse(readFileSync(join(BUNDLES_DIR, `${name}.bundle.json`), 'utf8')) as InlineModuleBundle;
}

function makeClaimed(over: Partial<RunSubmitRequest> = {}): JobRow {
  const request = runBody({
    mode: 'promotion',
    curatedBaselineRef: { id: 'base', version: '1' },
    period: RUN_PERIOD,
    symbols: ['BTCUSDT'],
    timeframe: '1m',
    ...over,
  });
  return {
    jobId: 'job-1',
    runId: 'run-1',
    requestFingerprint: 'fp',
    status: 'running',
    request,
    effectiveSeed: 42,
    datasetRef: request.datasetRef,
    attempts: 1,
    acceptedAtMs: 1,
    runTimeoutMs: 3_600_000,
    computeWaitAttempts: 0,
    timeline: [],
  };
}

describe('resolvePromotionGate (E4b)', () => {
  let bundle: ModuleBundle;
  let cleanupBundle: () => Promise<void>;

  beforeAll(async () => {
    const inline = loadInlineBundle('short-after-pump');
    const mat = await materializeBundle(inline);
    cleanupBundle = mat.cleanup;
    bundle = loadBundle(mat.bundleDir);
  });
  afterAll(async () => {
    await cleanupBundle?.();
  });

  function baseDeps(over: Partial<PromotionDeps> = {}): PromotionDeps {
    return {
      enabled: true,
      ledger: new InMemoryPromotionAttemptLedger(),
      epochResolver: { resolve: async () => ({ epochId: 'e' }) } as QualificationEpochResolver,
      policy: buildPromotionPolicy({ holdoutFraction: 0.4 }),
      ...over,
    };
  }
  function baseCtx(over: Partial<PromotionCtx> = {}): PromotionCtx {
    const passing = oc(warmEquity, [trd(7, 8, 5)]);
    return {
      candidate: passing,
      curated: passing,
      signingKey: generateSigningKey(),
      bundle,
      bundleBytes: new TextEncoder().encode('x'),
      datasetFingerprint: 'dsf',
      coverage: COVERAGE,
      runId: 'run-1',
      clock: () => 1,
      writeArtifact: vi.fn(async () => 'sha256:art'),
      ...over,
    };
  }

  it('deps.enabled=false ⇒ undefined', async () => {
    const deps = baseDeps({ enabled: false });
    const r = await resolvePromotionGate(deps, makeClaimed(), baseCtx());
    expect(r).toBeUndefined();
  });

  it("claimed.request.mode !== 'promotion' ⇒ undefined", async () => {
    const deps = baseDeps();
    const claimed = makeClaimed({ mode: 'research' });
    const r = await resolvePromotionGate(deps, claimed, baseCtx());
    expect(r).toBeUndefined();
  });

  it('ctx.signingKey undefined ⇒ not_qualified/signing_unavailable, no evidenceRef', async () => {
    const deps = baseDeps();
    const spy = vi.spyOn(deps.ledger, 'recordIfNewAndGetAttempt');
    const r = await resolvePromotionGate(deps, makeClaimed(), baseCtx({ signingKey: undefined }));
    expect(r?.promotion).toEqual({ verdict: 'not_qualified', reason: 'signing_unavailable', evaluatedOn: 'holdout' });
    expect(r?.evidenceRef).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it('ctx.curated === null ⇒ curated_unavailable', async () => {
    const deps = baseDeps();
    const r = await resolvePromotionGate(deps, makeClaimed(), baseCtx({ curated: null }));
    expect(r?.promotion).toMatchObject({ verdict: 'not_qualified', reason: 'curated_unavailable' });
    expect(r?.evidenceRef).toBeUndefined();
  });

  it('twin_divergent (divergent candidate) ⇒ reason twin_divergent, ledger NOT called', async () => {
    const deps = baseDeps();
    const spy = vi.spyOn(deps.ledger, 'recordIfNewAndGetAttempt');
    const curated = oc(warmEquity, [trd(7, 8, 5)]);
    const candidate = oc(warmEquity, [trd(7, 8, 999)]); // divergent trade ⇒ result_hash mismatch
    const r = await resolvePromotionGate(deps, makeClaimed(), baseCtx({ curated, candidate }));
    expect(r?.promotion).toMatchObject({ verdict: 'not_qualified', reason: 'twin_divergent' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('epochResolver.resolve → null ⇒ holdout_unavailable', async () => {
    const deps = baseDeps({ epochResolver: { resolve: async () => null } });
    const r = await resolvePromotionGate(deps, makeClaimed(), baseCtx());
    expect(r?.promotion).toMatchObject({ verdict: 'not_qualified', reason: 'holdout_unavailable' });
  });

  it('ctx.coverage === null ⇒ holdout_unavailable', async () => {
    const deps = baseDeps();
    const r = await resolvePromotionGate(deps, makeClaimed(), baseCtx({ coverage: null }));
    expect(r?.promotion).toMatchObject({ verdict: 'not_qualified', reason: 'holdout_unavailable' });
  });

  it('window not covered by runPeriod ⇒ holdout_not_covered, evaluationWindow set, ledger NOT called', async () => {
    const deps = baseDeps();
    const spy = vi.spyOn(deps.ledger, 'recordIfNewAndGetAttempt');
    const shortRun: RunPeriod = { from: new Date(0).toISOString(), to: new Date(5 * DAY).toISOString() };
    const claimed = makeClaimed({ period: shortRun });
    const r = await resolvePromotionGate(deps, claimed, baseCtx());
    expect(r?.promotion).toMatchObject({ verdict: 'not_qualified', reason: 'holdout_not_covered' });
    expect(r?.promotion.evaluationWindow).toBeDefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it("evaluated verdict 'failed' ⇒ ledger recorded, reason metrics_failed, attemptNumber set, no evidenceRef", async () => {
    const deps = baseDeps();
    const spy = vi.spyOn(deps.ledger, 'recordIfNewAndGetAttempt');
    const losing = oc(warmEquity, [trd(7, 8, -5)]); // losing trade ⇒ win_rate 0 ⇒ decideVerdict 'failed'
    const r = await resolvePromotionGate(deps, makeClaimed(), baseCtx({ candidate: losing, curated: losing }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(r?.promotion).toMatchObject({ verdict: 'not_qualified', reason: 'metrics_failed', attemptNumber: 1 });
    expect(r?.promotion.evaluationWindow).toBeDefined();
    expect(r?.evidenceRef).toBeUndefined();
  });

  it("evaluated verdict 'passed' ⇒ ledger recorded, writeArtifact called, evidenceRef present", async () => {
    const deps = baseDeps();
    const spy = vi.spyOn(deps.ledger, 'recordIfNewAndGetAttempt');
    const writeArtifact = vi.fn(async () => 'sha256:art');
    const r = await resolvePromotionGate(deps, makeClaimed(), baseCtx({ writeArtifact }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(writeArtifact).toHaveBeenCalledTimes(1);
    expect(r?.promotion.verdict).toBe('passed');
    if (r?.promotion.verdict === 'passed') {
      expect(r.promotion.attemptNumber).toBe(1);
      expect(r.promotion.evaluationWindow).toBeDefined();
      expect(r.promotion.evaluatedOn).toBe('holdout');
    }
    expect(r?.evidenceRef).toMatchObject({ artifactType: 'backtest-evidence/v2', availability: 'available' });
  });

  it('ledger.recordIfNewAndGetAttempt throws ⇒ attempt_record_failed, no evidenceRef', async () => {
    const deps = baseDeps();
    vi.spyOn(deps.ledger, 'recordIfNewAndGetAttempt').mockRejectedValue(new Error('ledger boom'));
    const r = await resolvePromotionGate(deps, makeClaimed(), baseCtx());
    expect(r?.promotion).toMatchObject({ verdict: 'not_qualified', reason: 'attempt_record_failed' });
    expect(r?.evidenceRef).toBeUndefined();
  });

  it('ctx.writeArtifact throws ⇒ internal_error, NOT passed, no evidenceRef', async () => {
    const deps = baseDeps();
    const writeArtifact = vi.fn(async () => {
      throw new Error('write boom');
    });
    const r = await resolvePromotionGate(deps, makeClaimed(), baseCtx({ writeArtifact }));
    expect(r?.promotion).toMatchObject({ verdict: 'not_qualified', reason: 'internal_error' });
    expect(r?.promotion.verdict).not.toBe('passed');
    expect(r?.evidenceRef).toBeUndefined();
  });
});
