// Worker — claims the oldest queued job, runs the backtest in-process, persists artifacts, transitions
// to a terminal state, and publishes the completion event. claimNextQueued is the concurrency-safe
// handoff (FOR UPDATE SKIP LOCKED in Pg). A job with a bundleHash runs in the Docker sandbox; otherwise
// the trusted momentum executor. Sandbox limit/▶failures map to a clean terminal status + terminal_code
// (never a service crash).

import type { ArtifactManifest, ArtifactReference, ContentHash } from '@trading-backtester/sdk/artifacts';
import type {
  BacktestRunRequest,
  HoldoutMarker,
  Novelty,
  RunDiagnostics,
  RunPeriod,
  RunResultSummary,
  WalkForward,
  WalkForwardFailureCode,
} from '@trading-backtester/sdk/contracts';
import { API_CONTRACT_VERSION } from '@trading-backtester/sdk/contracts';
import { contentRef } from '../determinism/hash';
import { persistRunArtifacts, type ArtifactStore } from '../artifacts/store';
import { persistOverlayArtifacts } from '../artifacts/overlay-store';
import {
  datasetFingerprint,
  materialize,
  type BacktesterDataPort,
  type MaterializedDataset,
} from '../data/reader';
import type { MarketTapeDataset } from '@trading/research-contracts/research';
import { buildOverlayDataset } from '../engine/data-adapter';
import { runOverlayBacktest } from '../engine/run-overlay';
import { runStrategyBacktest } from '../engine/run-strategy';
import { buildInlineOverlayRegistry, buildTrustedRegistry } from '../engine/trusted-registry';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadBundle, type ModuleBundle as SandboxModuleBundle } from '../engine/sandbox/bundle';
import { materializeBundle } from '../engine/sandbox/bundle-materialize';
import { mountConfigFor } from '../engine/sandbox/mounts';
import { ensureHarnessInVolume } from '../engine/sandbox/harness-volume';
import { createExecutorRouter, type ExecutorRouter } from '../engine/sandbox/routing';
import { createSandboxPolicyRegistry } from '../engine/sandbox-policy';
import type { SandboxExecutorDeps } from '../engine/sandbox/sandbox-executor';
import { toOverlaySummary } from './overlay-summary';
import { RunnerError } from '../runner/errors';
import { boundedErrorDetail } from './bounded-error-detail.js';
import { RealDataUnavailableError } from '../data/rows-data-port';
import { TrustedMomentumExecutor, type ModuleExecutor } from '../runner/module-executor';
import { runBacktest, type BacktestResult } from '../runner/run-backtest';
import type { RunOutcome } from '../engine/artifacts';
import { SandboxModuleExecutor, type SandboxConfig } from '../sandbox/sandbox-executor';
import type { BundleStore } from '../sandbox/bundle-store';
import type { OverlaySandboxSettings } from '../config';
import { deliverOutbox, publishCompletion, reapAndPublish, type CompletionDeps } from './completion';
import type { JobRow, JobStore } from './job-store';
import { overlayTapeCache, momentumTapeCache, tapeCacheKey } from '../data/tape-cache.js';
import type { SigningKey } from '../evidence/signing.js';
import { produceStrategyEvidence } from '../evidence/produce-strategy-evidence.js';
import type { EvidenceScope } from '../evidence/body.js';
import { runBoundedPool } from './pool.js';
import { normalize, restamp, type DedupTemplate } from './dedup/restamp.js';
import { computeIdentity } from './dedup/compute-identity.js';
import { type ComputeLockStore } from './coalesce/compute-lock.js';
import { wakeComputeWaiters } from './coalesce/wake.js';
import type { ResultCache } from './dedup/result-cache.js';
import { DEDUP_COMPUTE_VERSION, DEDUP_TEMPLATE_VERSION } from './dedup/version.js';
import { ObsRegistry, type DedupClass, type JobObsSample } from './obs-registry.js';
import type { TrialLedger } from './ledger/trial-ledger.js';
import { recordTrialAndComputeContext } from './ledger/record-trial.js';
import { buildHoldoutMarker } from '../engine/holdout.js';
import { computeRunDiagnostics } from '../engine/diagnostics.js';
import { toDailyPnlDeltas, computeNovelty } from '../engine/novelty.js';
import { computeComparabilityKey, type NoveltyPool } from './ledger/novelty-pool.js';
import { runWalkForward, WalkForwardFoldError, type RunFold } from '../engine/walk-forward-exec.js';

export { RunnerError };

interface SandboxBundleHandle {
  readonly bundle: SandboxModuleBundle;
  readonly cleanup: () => Promise<void>;
}

export interface WorkerDeps extends CompletionDeps {
  store: JobStore;
  dataPort: BacktesterDataPort;
  artifactStore: ArtifactStore;
  bundleStore?: BundleStore;
  sandbox?: SandboxConfig;
  overlaySandbox: OverlaySandboxSettings;
  /** When set, the worker claims with a lease and owner-guards its terminal transitions. */
  lease?: { workerId: string; ttlMs: number; maxAttempts: number };
  /** Ed25519 signing key for backtest evidence. Absent ⇒ evidence signing is OFF. */
  evidenceSigningKey?: SigningKey;
  /** Fingerprint-based completed-result cache. Absent ⇒ dedup is OFF (kill-switch). */
  resultCache?: ResultCache;
  /** Master kill-switch: dedup only engages when true AND resultCache is present. */
  dedupEnabled?: boolean;
  /** In-flight compute coordination lock. Absent ⇒ coalescing OFF. */
  computeLock?: ComputeLockStore;
  /** Master coalescing kill-switch: engages only when true AND computeLock present AND dedup on. */
  coalesceEnabled?: boolean;
  computeLockTtlMs?: number;
  computeWaitMaxAttempts?: number;
  /** Heartbeat hooks — the drain loop renews leader locks (Task 8). Here we register on lock-win and
   *  unregister in the finally; both are best-effort (absent ⇒ no-op). */
  registerLeader?: (computeIdentity: string) => void;
  unregisterLeader?: (computeIdentity: string) => void;
  /** Per-job observability registry. Absent ⇒ observability is OFF (no timing, no log line). */
  obs?: ObsRegistry;
  /** 17b: batch flat-stretch onBarClose calls into one sandbox message. Default off (dark launch). */
  barBatching?: boolean;
  /** 17d: bar-major execution mode — one bar across all symbols before advancing. Default off (dark launch). */
  barMajor?: boolean;
  /** Slice B: collapse bar-major per-bar IPC into 3-phase batched transport. Pure sub-mode of barMajor — inert unless barMajor is also on. Default off (dark launch). */
  barMajorBatch?: boolean;
  /** 17b: max bars per hookBatch (clamped >= 2 by config). */
  batchBars?: number;
  /** 17c: universe-session cap + scaled-policy memory knobs. Absent/disabled ⇒ no cap, no scaled policy (byte-identical). */
  universe?: { enabled: boolean; maxN: number; memBaseMb: number; memPerSymbolMb: number };
  /** E2: per-hypothesis-family trial ledger. Absent ⇒ trial ledger + DSR OFF (kill-switch). */
  trialLedger?: TrialLedger;
  /** E2 master kill-switch: DSR/trialContext engages only when true AND trialLedger present. */
  trialLedgerEnabled?: boolean;
  /** E2: N at/above which V[SR] switches asymptotic→empirical (default 5). */
  trialEmpiricalMinN?: number;
  /** E4a: held-out OOS marker. Absent/disabled ⇒ no `holdout` field (byte-identical). */
  holdout?: { enabled: boolean; fraction: number };
  /** E1b: structured run diagnostics. Absent/disabled ⇒ no `diagnostics` field (byte-identical). */
  diagnostics?: { enabled: boolean; minTrades: number; concentrationPct: number };
  /** E5a: behavioral-novelty gate. Absent/disabled ⇒ no `novelty` field (byte-identical). */
  novelty?: { enabled: boolean; threshold: number; minOverlapDays: number; pool: NoveltyPool };
  /** E3b: walk-forward per-fold execution. Absent/disabled ⇒ no `walkForward` field (byte-identical). */
  walkForward?: { enabled: boolean; maxFolds: number };
}

export function periodMs(period: RunPeriod): { tsFrom: number; tsTo: number } {
  const from = Date.parse(period.from);
  const to = Date.parse(period.to);
  // Submit-time validation (submit.ts::validate) already guarantees parseable, ordered bounds. Throw
  // rather than silently coerce to {0, MAX_SAFE_INTEGER} so a bad period can never be signed into an
  // evidence scope window (P2-13 / P2-21) even if a future caller bypasses submit validation — mirror
  // the same two checks (parseable AND from < to) here.
  if (Number.isNaN(from) || Number.isNaN(to)) {
    throw new RunnerError('validation_error', `unparseable period: ${period.from}..${period.to}`);
  }
  if (from >= to) {
    throw new RunnerError('validation_error', `period.from must be before period.to: ${period.from}..${period.to}`);
  }
  return { tsFrom: from, tsTo: to };
}

async function sandboxBundleFor(deps: WorkerDeps, hash: ContentHash): Promise<SandboxBundleHandle> {
  if (!deps.bundleStore) {
    throw new RunnerError('sandbox_unavailable', 'sandbox execution is not configured');
  }
  const bundle = await deps.bundleStore.get(hash);
  if (!bundle) throw new RunnerError('missing_module', `unknown bundle: ${hash}`);
  const materialized = await materializeBundle(bundle, bundleBaseDir(deps.overlaySandbox));
  return { bundle: loadBundle(materialized.bundleDir), cleanup: materialized.cleanup };
}

async function executorFor(
  deps: WorkerDeps,
  job: JobRow,
): Promise<ModuleExecutor> {
  if (!job.bundleHash) return new TrustedMomentumExecutor();
  if (!deps.bundleStore || !deps.sandbox) {
    throw new RunnerError('sandbox_unavailable', 'sandbox execution is not configured');
  }
  const bundle = await deps.bundleStore.get(job.bundleHash);
  if (!bundle) throw new RunnerError('missing_module', `unknown bundle: ${job.bundleHash}`);
  return new SandboxModuleExecutor(bundle, deps.sandbox);
}

function overlayRouterFor(deps: WorkerDeps, symbolsCount?: number): ExecutorRouter {
  const policy = deps.overlaySandbox.policy;
  const universe = deps.universe;
  return createExecutorRouter({
    sandboxPolicies: createSandboxPolicyRegistry([policy]),
    sandboxPolicyRef: { id: policy.id, version: policy.version },
    sandboxDeps: overlaySandboxDeps(deps.overlaySandbox),
    ...(universe?.enabled === true && symbolsCount !== undefined
      ? { universe: { enabled: true, n: symbolsCount, memBaseMb: universe.memBaseMb, memPerSymbolMb: universe.memPerSymbolMb } }
      : {}),
  });
}

/** Per-run base dir for materialized bundles: under the shared volume in volume mode, else tmpdir. */
export function bundleBaseDir(s: OverlaySandboxSettings): string | undefined {
  const mount = mountConfigFor(s.volume, s.volumeMountpoint);
  return mount.mode === 'volume' ? join(mount.mountpoint, 'bundles') : undefined;
}

/** Sandbox executor deps for the overlay router: bind (dev) or volume (DooD). */
export function overlaySandboxDeps(s: OverlaySandboxSettings): SandboxExecutorDeps {
  const mount = mountConfigFor(s.volume, s.volumeMountpoint);
  if (mount.mode === 'bind') return { harnessDir: s.harnessDir };
  const harnessDir = ensureHarnessInVolume(s.harnessDir, mount.mountpoint);
  return { harnessDir, mount };
}

/** I/O collaborators a fold needs: build the per-fold tape, make a fresh sandbox router, run the
 *  engine. Defaulted to the real collaborators below; injected in tests so the factory's OWN control
 *  flow (fresh router per fold, closeAll on success+throw, error-code mapping) is unit-testable
 *  without Docker. */
interface WalkForwardFoldIO {
  buildTape(period: RunPeriod): Promise<MarketTapeDataset>;
  makeRouter(): ExecutorRouter;
  runEngine(request: BacktestRunRequest, tape: MarketTapeDataset, router: ExecutorRouter): Promise<RunOutcome>;
}

/** Normalize a RunnerError.code into the SDK's WalkForwardFailureCode taxonomy. */
function mapRunnerCode(code: string): WalkForwardFailureCode {
  if (code === 'sandbox_error' || code === 'sandbox_unavailable') return 'sandbox_failure';
  if (code === 'validation_error') return 'validation_error';
  if (code.includes('timeout')) return 'timeout';
  return 'runner_failure';
}

/**
 * E3b: build the per-fold executor. ONE FRESH sandbox session per fold (no shared mutable router —
 * load-bearing while P1-4 IPC/sequence is open); assertSandboxClean before accepting; failures classified
 * into normalized codes. Registry is built once from the OUTER bundle (pure, reused); the outer bundle's
 * cleanup stays with the worker (no reload here). engineRequest is the outer one — only `period` changes.
 */
function makeWalkForwardRunFold(
  deps: WorkerDeps,
  engine: Engine,
  engineRequest: BacktestRunRequest,
  sandboxBundle?: SandboxBundleHandle,
  io?: WalkForwardFoldIO,
): RunFold {
  const registry =
    engine === 'strategy'
      ? buildInlineOverlayRegistry([], sandboxBundle ? [sandboxBundle.bundle] : [])
      : sandboxBundle
        ? buildInlineOverlayRegistry([sandboxBundle.bundle])
        : buildTrustedRegistry();
  const r = engineRequest;
  const realIo: WalkForwardFoldIO = {
    buildTape: (period) =>
      overlayTapeCache.getOrBuild(
        tapeCacheKey({ datasetRef: r.datasetRef, symbols: r.symbols, timeframe: r.timeframe, from: period.from, to: period.to }),
        () => buildOverlayDataset(deps.dataPort, { datasetRef: r.datasetRef, symbols: r.symbols, timeframe: r.timeframe, period }),
      ),
    makeRouter: () => workerInternals.overlayRouterFor(deps, r.symbols.length),
    runEngine: (request, tape, router) =>
      engine === 'strategy'
        ? runStrategyBacktest(request, {
            registry, marketTape: tape, router,
            ...(deps.barBatching === true ? { barBatching: { maxBars: deps.batchBars ?? 64 } } : {}),
            ...(deps.barMajor === true ? { barMajor: true } : {}),
            ...(deps.barMajorBatch === true ? { barMajorBatch: true } : {}),
            ...(deps.universe ? { universe: deps.universe } : {}),
          })
        : runOverlayBacktest(request, { registry, marketTape: tape, router, ...(deps.universe ? { universe: deps.universe } : {}) }),
  };
  const foldIo = io ?? realIo;

  return async (fold) => {
    const period = { from: fold.train.from, to: fold.test.to };
    let tape: MarketTapeDataset;
    try {
      tape = await foldIo.buildTape(period);
    } catch (err) {
      throw new WalkForwardFoldError('missing_dataset', `fold ${fold.index} tape build failed: ${String(err)}`);
    }
    let router: ExecutorRouter | undefined;
    try {
      router = foldIo.makeRouter();
      const outcome = await foldIo.runEngine({ ...r, period }, tape, router);
      if (outcome.status !== 'completed') throw new WalkForwardFoldError('validation_error', `fold ${fold.index} rejected`);
      assertSandboxClean(router); // throws RunnerError('sandbox_error') if the session left errors → mapped below
      return { outcome, hash: contentRef(outcome) };
    } catch (err) {
      if (err instanceof WalkForwardFoldError) throw err;
      const code = err instanceof RunnerError ? mapRunnerCode(err.code) : 'runner_failure';
      throw new WalkForwardFoldError(code, `fold ${fold.index}: ${String(err)}`);
    } finally {
      router?.closeAll();
    }
  };
}

/**
 * Boundary indirection: processNextQueued invokes bundle/executor/router construction through this
 * object so tests can `vi.spyOn(workerInternals, 'sandboxBundleFor')` and prove a dedup HIT performs
 * NONE of them (a bare intra-module call would not be interceptable by the spy). Compute-skip proof.
 */
export const workerInternals = { sandboxBundleFor, executorFor, overlayRouterFor, makeWalkForwardRunFold };

/**
 * P0-1: a sandboxed run degrades internal hook failures to `idle` and only RECORDS them on the router
 * (sandbox-executor.ts) — the run can still return status:'completed' with trades truncated from the
 * crash bar onward. Surface those recorded errors as a hard RunnerError BEFORE finalize/cache so a
 * crashed / OOM container never finalizes as `completed` nor poisons the dedup cache. Mirrors the
 * evidence driver's H1 guard (strategy-evidence-driver.ts). No-op on the trusted / momentum path.
 */
export function assertSandboxClean(router: ExecutorRouter | undefined): void {
  if (!router) return;
  const errors = router.errors();
  if (errors.length > 0) {
    throw new RunnerError('sandbox_error', `sandbox execution failed: ${JSON.stringify(errors)}`);
  }
}

type Engine = 'momentum' | 'overlay' | 'strategy';

interface Finalized {
  summary: RunResultSummary;
  manifest: ArtifactManifest;
  resultHash: ContentHash;
}

/**
 * Post-payload finalize: persist artifacts + build the wire RunResultSummary + resultHash. Pure move
 * of the per-branch tail — momentum uses persistRunArtifacts + the inline momentum summary; overlay
 * and strategy use persistOverlayArtifacts + toOverlaySummary. `resultHash = contentRef(payload)`.
 */
async function finalizeResult(
  deps: WorkerDeps,
  engine: Engine,
  payload: unknown,
  claimed: JobRow,
  datasetFingerprint: string,
  evidenceRef?: ArtifactReference,
): Promise<Finalized> {
  const resultHash = contentRef(payload);
  if (engine === 'momentum') {
    const result = payload as BacktestResult;
    const persisted = await persistRunArtifacts(deps.artifactStore, result, datasetFingerprint);
    const summary: RunResultSummary = {
      runId: claimed.runId,
      status: 'completed',
      metrics: result.metrics,
      artifactRefs: persisted.artifactRefs,
      evidence: {
        seed: claimed.effectiveSeed,
        contractVersion: API_CONTRACT_VERSION,
        moduleVersions: [claimed.request.moduleRef],
        datasetRef: claimed.datasetRef,
        datasetFingerprint,
        ...(claimed.bundleHash !== undefined ? { bundleHash: claimed.bundleHash } : {}),
      },
      resultHash,
    };
    return { summary, manifest: persisted.manifest, resultHash };
  }
  const outcome = payload as Extract<RunOutcome, { status: 'completed' }>;
  const persisted = await persistOverlayArtifacts(deps.artifactStore, outcome, datasetFingerprint);
  let summary = toOverlaySummary(
    outcome,
    claimed.runId,
    persisted.artifactRefs,
    resultHash,
    datasetFingerprint,
    claimed.bundleHash,
    evidenceRef,
  );
  // E2 (advisory, flag-gated): record this run as a trial and attach the Deflated Sharpe / N context.
  // Runs AFTER resultHash is fixed; trialContext lives on the summary projection ONLY (never hashed),
  // so flag-OFF is byte-identical. Momentum has no equity curve → not laddered.
  if (deps.trialLedger && deps.trialLedgerEnabled) {
    const trialContext = await recordTrialAndComputeContext(
      { ledger: deps.trialLedger, empiricalMinN: deps.trialEmpiricalMinN ?? 5, clock: deps.clock },
      {
        request: claimed.request,
        requestFingerprint: claimed.requestFingerprint,
        runId: claimed.runId,
        resultHash,
        equity: outcome.baseline.evidence.equityCurve,
      },
    );
    if (trialContext) summary = { ...summary, trialContext };
  }
  // E4a (advisory, flag-gated): mark whether this run touched the server-reserved held-out OOS window.
  // Non-hashed (config-derived); flag-OFF ⇒ field absent ⇒ byte-identical.
  const holdout = await resolveHoldoutMarker(deps, claimed);
  if (holdout) summary = { ...summary, holdout };
  // E1b (advisory, flag-gated): structured run diagnostics (facts + engine-derivable flags).
  // Non-hashed; flag-OFF ⇒ field absent ⇒ byte-identical.
  const diagnostics = resolveRunDiagnostics(deps, outcome);
  if (diagnostics) summary = { ...summary, diagnostics };
  // E5a (advisory, flag-gated): behavioral-novelty vs the prior pool (query → score → record, self-
  // excluding this fingerprint). Non-hashed projection; flag-OFF ⇒ field absent ⇒ byte-identical.
  const novelty = await resolveNovelty(deps, claimed, outcome, resultHash);
  if (novelty) summary = { ...summary, novelty };
  return { summary, manifest: persisted.manifest, resultHash };
}

/**
 * E4a: resolve the held-out marker for a completed run. `undefined` when the feature is off (field
 * omitted ⇒ byte-identical). When on but the dataset's coverage span can't be found, returns an
 * explicit `unknown` marker (so a consumer distinguishes "feature off" from "coverage missing").
 */
/**
 * E1b: compute the advisory run diagnostics for a completed overlay/strategy run. `undefined` when
 * the feature is off (field omitted ⇒ byte-identical). Pure over the run's trades/equity + the
 * operator policy; the returned diagnostics ride the summary projection only.
 */
export function resolveRunDiagnostics(
  deps: WorkerDeps,
  outcome: Extract<RunOutcome, { status: 'completed' }>,
): RunDiagnostics | undefined {
  if (!deps.diagnostics?.enabled) return undefined;
  return computeRunDiagnostics({
    trades: outcome.baseline.trades,
    equity: outcome.baseline.evidence.equityCurve,
    barsProcessed: outcome.baseline.summary.barsProcessed,
    orderCount: outcome.baseline.summary.ordersCount,
    policy: { minTrades: deps.diagnostics.minTrades, concentrationPct: deps.diagnostics.concentrationPct },
  });
}

/**
 * E5a: compute the advisory novelty signal for a completed overlay/strategy run. `undefined` when
 * the gate is off. Order is query → score → record; `query` self-excludes this run's fingerprint so a
 * replay is not scored against itself (idempotent projection). A degenerate run (<2 daily deltas) is
 * scored `no_comparators:empty_candidate` and NOT recorded, so it never pollutes the pool.
 *
 * Fault-tolerant by design: this is an advisory, dark-launched signal and must NEVER fail an
 * otherwise-successful job. A failed pool read drops the signal entirely (returns `undefined`); a
 * failed pool write is a best-effort insert only — it does NOT discard an already-computed score.
 */
export async function resolveNovelty(
  deps: WorkerDeps,
  claimed: JobRow,
  outcome: Extract<RunOutcome, { status: 'completed' }>,
  resultHash: string,
): Promise<Novelty | undefined> {
  if (!deps.novelty?.enabled) return undefined;
  const candidateDeltas = toDailyPnlDeltas(outcome.baseline.evidence.equityCurve);
  const comparabilityKey = computeComparabilityKey({
    datasetRef: claimed.datasetRef,
    symbols: claimed.request.symbols,
    timeframe: claimed.request.timeframe,
  });
  let pool: Awaited<ReturnType<NoveltyPool['query']>>;
  try {
    pool = await deps.novelty.pool.query(comparabilityKey, {
      excludeRequestFingerprint: claimed.requestFingerprint,
    });
  } catch {
    return undefined;
  }
  const novelty = computeNovelty(
    candidateDeltas,
    pool.map((r) => ({ ref: r.resultHash, runId: r.runId, dailyDeltas: r.dailyDeltas })),
    { minOverlapDays: deps.novelty.minOverlapDays, threshold: deps.novelty.threshold, comparabilityKey },
  );
  if (candidateDeltas.length >= 2) {
    try {
      await deps.novelty.pool.recordIfNew({
        comparabilityKey,
        requestFingerprint: claimed.requestFingerprint,
        runId: claimed.runId,
        resultHash,
        dailyDeltas: candidateDeltas,
        createdAtMs: deps.clock(), // WorkerDeps.clock is `() => number` (not an object)
      });
    } catch {
      // best-effort insert; a failed write must not discard the already-computed score
    }
  }
  return novelty;
}

/**
 * E3b: run the advisory walk-forward folds for a completed overlay/strategy run. `undefined` ONLY for
 * the gate (flag off / no scheme / momentum); when enabled-with-scheme it always resolves to a
 * WalkForward (fail-open — a fault becomes `unavailable: internal_error`, never a rejection). The
 * production runFold (built from the outer engineRequest + sandboxBundle) executes one FRESH sandbox
 * session per fold; tests pass `runFoldOverride`.
 */
export async function resolveWalkForward(
  deps: WorkerDeps,
  claimed: JobRow,
  engine: Engine,
  ctx: { engineRequest: BacktestRunRequest; sandboxBundle?: SandboxBundleHandle },
  runFoldOverride?: RunFold,
): Promise<WalkForward | undefined> {
  if (!deps.walkForward?.enabled) return undefined;
  if (engine !== 'overlay' && engine !== 'strategy') return undefined;
  const scheme = claimed.request.walkForward;
  if (scheme === undefined) return undefined;
  try {
    const runFold = runFoldOverride ?? workerInternals.makeWalkForwardRunFold(deps, engine, ctx.engineRequest, ctx.sandboxBundle);
    const deadlineMs = claimed.runDeadlineMs;
    return await runWalkForward(
      {
        scheme,
        period: claimed.request.period,
        requestedMetrics: claimed.request.metrics ?? [],
        maxFolds: deps.walkForward.maxFolds,
        deadlineExceeded: () => deadlineMs !== undefined && deps.clock() >= deadlineMs,
      },
      runFold,
    );
  } catch {
    return { status: 'unavailable', scheme, reason: 'internal_error', failedFolds: [], insufficientFolds: [] };
  }
}

export async function resolveHoldoutMarker(deps: WorkerDeps, claimed: JobRow): Promise<HoldoutMarker | undefined> {
  if (!deps.holdout?.enabled) return undefined;
  let coverage: RunPeriod | undefined;
  try {
    const datasets = await deps.dataPort.listDatasets();
    coverage = datasets.find((d) => d.datasetRef === claimed.datasetRef)?.period;
  } catch {
    coverage = undefined;
  }
  if (coverage === undefined) return { status: 'unknown', reason: 'coverage_not_found' };
  return buildHoldoutMarker(coverage, deps.holdout.fraction, claimed.request.period);
}

function engineOf(claimed: JobRow): Engine {
  const e = claimed.request.engine;
  return e === 'overlay' || e === 'strategy' ? e : 'momentum';
}

interface Materialized {
  engine: Engine;
  datasetFingerprint: string;
  engineRequest: BacktestRunRequest;
  /** overlay/strategy tape (absent for momentum). */
  marketTape?: MarketTapeDataset;
  /** momentum dataset (absent for overlay/strategy). */
  dataset?: MaterializedDataset;
}

/**
 * Materialize the tape/dataset + compute the datasetFingerprint + build the engineRequest for a
 * claimed job. Pure move of the per-branch "materialize" preamble — overlayTapeCache/momentumTapeCache
 * usage is identical. Called ONCE before any sandbox/engine work so the dedup gate can key on the
 * datasetFingerprint before deciding to run the engine.
 */
async function materializeFor(deps: WorkerDeps, claimed: JobRow): Promise<Materialized> {
  const engine = engineOf(claimed);
  const runId = claimed.runId;
  if (engine === 'overlay' || engine === 'strategy') {
    const r = claimed.request;
    const marketTape = await overlayTapeCache.getOrBuild(
      tapeCacheKey({
        datasetRef: r.datasetRef,
        symbols: r.symbols,
        timeframe: r.timeframe,
        from: r.period.from,
        to: r.period.to,
      }),
      () =>
        buildOverlayDataset(deps.dataPort, {
          datasetRef: r.datasetRef,
          symbols: r.symbols,
          timeframe: r.timeframe,
          period: r.period,
        }),
    );
    // Wire-summary fingerprint only — NOT part of the hashed RunOutcome (platform golden).
    const dsFingerprint = contentRef(r.symbols.map((s) => marketTape.candles(s)));
    const engineRequest: BacktestRunRequest = {
      runId,
      mode: r.mode,
      moduleRef: r.moduleRef,
      // overlayRefs is an overlay-only field — the strategy path never carried it (exact-behavior parity).
      ...(engine === 'overlay' && r.overlayRefs !== undefined ? { overlayRefs: r.overlayRefs } : {}),
      datasetRef: r.datasetRef,
      symbols: r.symbols,
      timeframe: r.timeframe,
      period: r.period,
      ...(r.params !== undefined ? { params: r.params } : {}),
      ...(r.riskProfileRef !== undefined ? { riskProfileRef: r.riskProfileRef } : {}),
      ...(r.executionProfileRef !== undefined ? { executionProfileRef: r.executionProfileRef } : {}),
      seed: claimed.effectiveSeed,
      metrics: r.metrics,
      ...(r.robustnessChecks !== undefined ? { robustnessChecks: r.robustnessChecks } : {}),
    };
    return { engine, datasetFingerprint: dsFingerprint, engineRequest, marketTape };
  }
  // ===== MOMENTUM =====
  const { tsFrom, tsTo } = periodMs(claimed.request.period);
  const dataset = await momentumTapeCache.getOrBuild(
    tapeCacheKey({
      datasetRef: claimed.datasetRef,
      symbols: claimed.request.symbols,
      from: tsFrom,
      to: tsTo,
    }),
    async () => {
      const reader = await deps.dataPort.openDataset(claimed.datasetRef);
      if (!reader) {
        throw new RunnerError('missing_dataset', `unknown dataset: ${claimed.datasetRef}`);
      }
      return materialize(reader, claimed.datasetRef, {
        tsFrom,
        tsTo,
        symbols: claimed.request.symbols,
      });
    },
  );
  const dsFingerprint = datasetFingerprint(dataset);
  const engineRequest: BacktestRunRequest = {
    runId,
    mode: claimed.request.mode,
    moduleRef: claimed.request.moduleRef,
    datasetRef: claimed.datasetRef,
    symbols: claimed.request.symbols,
    timeframe: claimed.request.timeframe,
    period: claimed.request.period,
    ...(claimed.request.params !== undefined ? { params: claimed.request.params } : {}),
    seed: claimed.effectiveSeed,
    metrics: claimed.request.metrics,
  };
  return { engine, datasetFingerprint: dsFingerprint, engineRequest, dataset };
}

/** Claim and run one queued job. Returns the (now terminal) row, or undefined if the queue was empty. */
export async function processNextQueued(deps: WorkerDeps): Promise<JobRow | undefined> {
  // Under coalescing the claim DEFERS the `attempts++` charge to engine-commit (INV-5). The defer
  // decision can only use deps-level flags (the request is not yet known); the per-request refinement
  // (dedupOn / bypassCache) happens at the engine-commit charge below.
  const claimCoalesce = deps.coalesceEnabled === true && deps.computeLock !== undefined && deps.lease !== undefined;
  const claimed = await deps.store.claimNextQueued(
    deps.clock(),
    deps.lease ? { workerId: deps.lease.workerId, ttlMs: deps.lease.ttlMs } : undefined,
    { coalesceEnabled: claimCoalesce },
  );
  if (!claimed) return undefined;
  const runId = claimed.runId;

  const tClaim = deps.obs ? deps.clock() : undefined;
  let tMaterialized: number | undefined;
  let tEngineDone: number | undefined;
  let dedupClass: DedupClass = 'off';

  let executor: ModuleExecutor | undefined;
  let sandboxRouter: ExecutorRouter | undefined;
  let sandboxBundle: SandboxBundleHandle | undefined;
  // Coalescing state hoisted to function scope so the catch/finally (proactive lock-expire + leader
  // unregister) can read what the try body computed. All stay unset/false when coalescing is off.
  let identity: string | undefined;
  let coalesceOn = false;
  let engineCharged = false;
  let leaderIdentity: string | undefined;
  // Bounded, log-safe detail from the caught error (Task 5) — set in the catch, read by the obs
  // sample below so a failed job's job_terminal line carries the same detail as its job_error line.
  let caughtErrorDetail: string | undefined;
  try {
    // NOTE: the bundle is loaded here (pre-flight) rather than lazily in the miss-path so the strategy
    // validation guards fire before tape materialization — preserving the sandbox error taxonomy
    // (validation_error, not missing_dataset). Consequence: a dedup HIT on a bundle-carrying run still
    // loads the bundle (cheap); it skips the expensive engine + sandbox EXECUTION, which is the dedup win.
    // Follow-up: split into loadBundleManifest (early, for validation) + materializeBundleToDisk (lazy,
    // miss-path) to let a bundle-path HIT skip the bundle materialization too.
    if (claimed.bundleHash !== undefined) {
      sandboxBundle = await workerInternals.sandboxBundleFor(deps, claimed.bundleHash);
    }

    // Strategy pre-flight validation — MUST run before tape materialization: the strategy-dispatch
    // tests drive an empty dataPort and assert these guards fire before any market-tape allocation.
    if (claimed.request.engine === 'strategy') {
      if (claimed.bundleHash === undefined || sandboxBundle === undefined) {
        throw new RunnerError('validation_error', 'strategy run requires a submitted bundle (ESM bytes)');
      }
      if (sandboxBundle.bundle.manifest.kind !== 'strategy') {
        throw new RunnerError(
          'validation_error',
          `strategy engine requires manifest.kind="strategy", got "${sandboxBundle.bundle.manifest.kind}"`,
        );
      }
      if (
        claimed.request.moduleRef.id !== sandboxBundle.bundle.manifest.id ||
        claimed.request.moduleRef.version !== sandboxBundle.bundle.manifest.version
      ) {
        throw new RunnerError(
          'validation_error',
          `strategy run moduleRef ${claimed.request.moduleRef.id}@${claimed.request.moduleRef.version} does not match submitted bundle manifest ${sandboxBundle.bundle.manifest.id}@${sandboxBundle.bundle.manifest.version}`,
        );
      }
    }

    // Materialize the tape/dataset + datasetFingerprint + engineRequest ONCE, before any
    // engine execution (the dedup gate keys on datasetFingerprint before deciding to run).
    const materialized = await materializeFor(deps, claimed);
    const dsFingerprint = materialized.datasetFingerprint;
    const engineRequest = materialized.engineRequest;
    const engine = materialized.engine;
    if (deps.obs) tMaterialized = deps.clock();

    // ── DEDUP GATE ────────────────────────────────────────────────────────────
    // dedup engages only when the kill-switch is on AND a cache is wired.
    // Evidence runs (curatedBaselineRef set) MUST always compute fresh: the signed evidenceRef is produced
    // only on the miss path and is NOT part of computeIdentity, so a HIT would silently drop it. Bypass
    // dedup entirely for them (no lookup, no populate).
    const dedupOn = deps.dedupEnabled === true && deps.resultCache !== undefined && claimed.request.curatedBaselineRef === undefined;
    // bypassCache skips the LOOKUP (force fresh) but a fresh successful run STILL populates below.
    const doLookup = dedupOn && claimed.request.bypassCache !== true;
    let sandboxPolicyVersion = '';
    if (dedupOn) {
      const policy = deps.overlaySandbox.policy;
      sandboxPolicyVersion = `${policy.id}@${policy.version}`;
      // Compute once and reuse for lookup / coalescing lock / populate (do NOT recompute).
      identity = computeIdentity({
        requestFingerprint: claimed.requestFingerprint,
        datasetFingerprint: dsFingerprint,
        sandboxPolicyVersion,
      });
    }

    if (deps.dedupEnabled === true && deps.resultCache !== undefined && claimed.request.curatedBaselineRef !== undefined) {
      dedupClass = 'evidence_bypass';
    } else if (!dedupOn) {
      dedupClass = 'off';
    } else if (!doLookup) {
      dedupClass = 'bypass';
    } else {
      dedupClass = 'miss'; // refined below to 'hit' / 'stale_recompute' by the lookup
    }

    // ── COALESCING FLAGS ──────────────────────────────────────────────────────
    // coalesceCapable MIRRORS the claim-time defer decision EXACTLY (same static condition, no
    // dedupOn, no bypassCache) — the claim already deferred attempts++ under coalescing whenever this
    // condition held, so EVERY engine path that had its charge deferred must be able to charge it at
    // engine-commit, INCLUDING an evidence run (curatedBaselineRef set ⇒ dedupOn === false) and a
    // bypassCache run. Including dedupOn here would leave evidence_bypass runs at attempts === 0
    // despite having run the engine (INV-5 lists evidence_bypass explicitly).
    // coalesceOn is the (stricter) LOCK-ELECTION gate: only genuinely coalescable requests — dedupOn
    // true AND not bypassCache — contend the compute lock / can defer to waiting_for_compute.
    const coalesceCapable = deps.coalesceEnabled === true && deps.computeLock !== undefined && deps.lease !== undefined;
    coalesceOn = coalesceCapable && dedupOn && claimed.request.bypassCache !== true;

    // INV-5: the attempts charge moves to engine-commit. Under coalescing the claim deferred it, so
    // charge it here — once, idempotently — immediately before the engine runs on ANY path. No-op when
    // coalescing is not capable (the claim already charged ⇒ INV-6 byte-identical).
    const chargeEngineAttempt = async (): Promise<void> => {
      if (!coalesceCapable || engineCharged) return;
      engineCharged = true;
      await deps.store.transition(runId, 'running', 'running', {
        atMs: deps.clock(),
        attempts: claimed.attempts + 1,
        engineAttemptCharged: true,
      }, deps.lease?.workerId);
    };

    let finalized: Finalized | undefined;
    let dedupedFrom: string | undefined;

    if (doLookup) {
      const hit = await deps.resultCache!.lookup(identity!);
      if (hit) {
        try {
          const template = (await deps.artifactStore.read(hit.templateRef as ContentHash)) as DedupTemplate;
          if (template.engine === engine && template.templateVersion === DEDUP_TEMPLATE_VERSION) {
            // Cache HIT: re-stamp the cached template under this runId. Performs NONE of executorFor /
            // router / engine — the dedup win. (For a bundle-carrying run, sandboxBundleFor already ran
            // in the pre-gate to preserve strategy validation error-taxonomy — the accepted partial;
            // momentum HITs have no bundle and skip everything.)
            const payload = restamp(template, runId);
            finalized = await finalizeResult(deps, engine, payload, claimed, dsFingerprint);
            dedupedFrom = hit.computeIdentity;
            dedupClass = 'hit';
          } else {
            // shape/engine/version mismatch → leave finalized undefined → miss path recomputes.
            dedupClass = 'stale_recompute';
          }
        } catch {
          // A shared/durable cache (PgResultCache) can return a HIT for a template that lives only on
          // another worker's disk (host-local FileArtifactStore) → read throws. A cache MUST degrade to
          // recompute, never hard-fail: leave finalized undefined and fall through to the miss path.
          finalized = undefined;
          dedupClass = 'stale_recompute';
        }
      }
    }

    if (!finalized) {
      // ===== MISS PATH — the ONLY place engine execution happens =====
      // ── COALESCING GATE ──────────────────────────────────────────────────────
      // INV-1 cache-first preserved: reached only on a genuine MISS (no HIT, no stale re-stamp).
      // Elect a single leader per computeIdentity; a follower (lost the lock) defers to
      // waiting_for_compute WITHOUT running the engine (attempts unchanged — the claim deferred them).
      // bypassCache never coalesces (coalesceOn excludes it), so it always falls through to run fresh.
      if (coalesceOn) {
        const workerId = deps.lease!.workerId;
        const lockTtl = deps.computeLockTtlMs ?? deps.lease!.ttlMs;
        const won = await deps.computeLock!.acquire(identity!, runId, workerId, deps.clock(), lockTtl);
        if (!won) {
          // Follower: lost the election → defer. NO engine, attempts unchanged (INV-5). The finally
          // block still runs cleanup; do NOT publishCompletion (waiting_for_compute is non-terminal).
          const now = deps.clock();
          // waitDeadlineMs is intentionally NOT set here: follower self-heal rides lock-TTL expiry
          // (wakeComputeWaiters re-elects once the leader's lock lapses) + the run_deadline reaper +
          // the compute_wait attempts cap, not a separate per-waiter deadline (dead-field cleanup —
          // the field was written but listComputeWaiters never read it against nowMs).
          await deps.store.transition(runId, 'running', 'waiting_for_compute', {
            atMs: now,
            computeIdentity: identity!,
            computeWaitAttempts: claimed.computeWaitAttempts + 1,
            engineAttemptCharged: false,
          }, workerId);
          return await deps.store.get(runId);
        }
        // Won → leader: register for heartbeat renewal (best-effort), then run the engine, charging
        // the deferred attempt at engine-commit (below).
        leaderIdentity = identity!;
        deps.registerLeader?.(identity!);
      }
      let payload: unknown;
      if (claimed.request.engine === 'overlay') {
      // ===== OVERLAY PATH — lifted engine end-to-end (Slice 6a) =====
      const marketTape = materialized.marketTape!;

      let registry = buildTrustedRegistry();
      if (claimed.bundleHash !== undefined) {
        // Build the inline execution registry from the SAME canonical definition that `/v1/registry`
        // advertises, adding only the submitted overlay bundle — so discovery and execution can't drift.
        registry = buildInlineOverlayRegistry([sandboxBundle!.bundle]);
        sandboxRouter = workerInternals.overlayRouterFor(deps, claimed.request.symbols.length);
      }

      await chargeEngineAttempt(); // INV-5: engine-commit charge (overlay path)
      const outcome = await runOverlayBacktest(engineRequest, {
        registry,
        marketTape,
        ...(sandboxRouter ? { router: sandboxRouter } : {}),
        ...(deps.universe ? { universe: deps.universe } : {}),
      });
      if (outcome.status !== 'completed') {
        throw new RunnerError(
          'validation_error',
          `overlay run rejected: ${JSON.stringify(outcome.validation.issues)}`,
        );
      }
      assertSandboxClean(sandboxRouter); // P0-1: crashed sandbox must fail, never finalize completed
      payload = outcome;
      finalized = await finalizeResult(deps, 'overlay', outcome, claimed, dsFingerprint);
    } else if (claimed.request.engine === 'strategy') {
      // ===== STRATEGY PATH — kind:'strategy' lifecycle-bundle via sandbox (closes gap PR #57) =====
      // Pre-flight guards (bundle present, manifest.kind, moduleRef match) already ran above.
      const r = claimed.request;
      const marketTape = materialized.marketTape!;
      const registry = buildInlineOverlayRegistry([], [sandboxBundle!.bundle]);
      sandboxRouter = workerInternals.overlayRouterFor(deps, r.symbols.length);
      await chargeEngineAttempt(); // INV-5: engine-commit charge (strategy path)
      const outcome = await runStrategyBacktest(engineRequest, {
        registry,
        marketTape,
        ...(sandboxRouter ? { router: sandboxRouter } : {}),
        ...(deps.barBatching === true ? { barBatching: { maxBars: deps.batchBars ?? 64 } } : {}),
        ...(deps.barMajor === true ? { barMajor: true } : {}),
        ...(deps.barMajorBatch === true ? { barMajorBatch: true } : {}),
        ...(deps.universe ? { universe: deps.universe } : {}),
      });
      if (outcome.status !== 'completed') {
        throw new RunnerError(
          'validation_error',
          `strategy run rejected: ${JSON.stringify(outcome.validation.issues)}`,
        );
      }
      assertSandboxClean(sandboxRouter); // P0-1: a crashed candidate must fail here, before evidence/finalize
      // ── E4: evidence block (run-once, additive) ──────────────────────────────
      // Runs ONLY when curatedBaselineRef is set AND a signing key is present.
      // Any failure leaves evidenceRef undefined — the run still completes with resultHash.
      // curatedBaselineRef is NOT added to engineRequest (never reaches the 017 validator).
      let evidenceRef: ArtifactReference | undefined;
      if (claimed.request.curatedBaselineRef !== undefined && deps.evidenceSigningKey !== undefined) {
        try {
          await chargeEngineAttempt(); // INV-5: engine-commit charge (curated-evidence baseline run; idempotent)
          const curated = await runOverlayBacktest(
            { ...engineRequest, moduleRef: claimed.request.curatedBaselineRef },
            { registry: buildTrustedRegistry(), marketTape },
          );
          if (curated.status !== 'completed') throw new Error('curated baseline run not completed');
          const entryAbs = join(sandboxBundle!.bundle.bundleDir, sandboxBundle!.bundle.descriptor.entryPoint);
          const bundleBytes = readFileSync(entryAbs);
          const { tsFrom, tsTo } = periodMs(r.period);
          const scope: EvidenceScope = {
            datasetRef: r.datasetRef,
            window: { fromMs: tsFrom, toMs: tsTo },
            symbols: [...r.symbols].sort(),
            timeframe: r.timeframe,
          };
          const result = produceStrategyEvidence({
            bundle: sandboxBundle!.bundle,
            bundleBytes,
            curated,
            candidate: outcome,
            scope,
            key: deps.evidenceSigningKey,
            backtesterRunId: runId,
          });
          const evidenceHash = await deps.artifactStore.write(result.artifact);
          evidenceRef = { artifactId: evidenceHash, artifactType: 'backtest-evidence/v1', availability: 'available' };
        } catch (err) {
          // gate-reject / non-equivalent / verdict != passed → additive: leave evidenceRef undefined,
          // the run still completes with resultHash intact. (Do NOT rethrow.)
          console.warn(`[evidence] strategy run ${runId}: evidence not produced: ${err instanceof Error ? err.message : String(err)}`);
          evidenceRef = undefined;
        }
      }

      payload = outcome;
      finalized = await finalizeResult(deps, 'strategy', outcome, claimed, dsFingerprint, evidenceRef);
    } else {
      // ===== MOMENTUM PATH — unchanged (golden eff10116… must not move) =====
      executor = await workerInternals.executorFor(deps, claimed);

      const dataset = materialized.dataset!;
      await chargeEngineAttempt(); // INV-5: engine-commit charge (momentum path)
      const result = await runBacktest(engineRequest, {
        dataset,
        executor,
        ...(claimed.bundleHash !== undefined ? { bundleHash: claimed.bundleHash } : {}),
      });
      payload = result;
      finalized = await finalizeResult(deps, 'momentum', result, claimed, dsFingerprint);
    }

      if (deps.obs) tEngineDone = deps.clock();

      // Populate the cache on ANY completed fresh run — INCLUDING a bypassCache run (bypass skips
      // lookup, not populate). Reachable only after the engine returned, before the terminal
      // transition, so failed/timeout/validation_error runs (which threw) never cache.
      if (dedupOn) {
        const normalized = normalize(engine, payload, runId);
        const templateRef = await deps.artifactStore.write(normalized);
        await deps.resultCache!.put({
          computeIdentity: identity!,
          requestFingerprint: claimed.requestFingerprint,
          datasetFingerprint: dsFingerprint,
          computeVersion: DEDUP_COMPUTE_VERSION,
          sandboxPolicyVersion,
          templateRef,
          createdAtMs: deps.clock(),
        });
      }
    }

    // E3b (advisory, flag-gated): per-fold walk-forward OOS stability. Runs on both the canonical miss AND
    // hit paths and AFTER the result-cache is populated (a crash mid-folds still leaves the canonical result
    // cached for the retry). Merged onto the summary projection ⇒ result_hash byte-identical when OFF.
    const walkForward = await resolveWalkForward(deps, claimed, engineOf(claimed), { engineRequest, sandboxBundle });
    if (walkForward) finalized = { ...finalized, summary: { ...finalized.summary, walkForward } };

    const now = deps.clock();
    await deps.store.transition(runId, 'running', 'completed', {
      atMs: now,
      terminalAtMs: now,
      lastActivityMs: now,
      resultSummary: finalized.summary,
      resultHash: finalized.resultHash,
      artifactManifest: finalized.manifest,
      datasetFingerprint: dsFingerprint,
      ...(dedupedFrom !== undefined ? { dedupedFrom } : {}),
    }, deps.lease?.workerId);
  } catch (err) {
    const code = err instanceof RunnerError
      ? err.code
      : err instanceof RealDataUnavailableError
      ? 'missing_dataset'
      : 'runner_failure';
    caughtErrorDetail = boundedErrorDetail(err);
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({
      evt: 'job_error',
      runId,
      code,
      detail: caughtErrorDetail,
    }));
    const terminalStatus = err instanceof RunnerError ? err.terminalStatus : 'failed';
    const now = deps.clock();
    await deps.store.transition(runId, 'running', terminalStatus, {
      atMs: now,
      terminalAtMs: now,
      terminalCode: code,
    }, deps.lease?.workerId);
    // INV-4: this run OWNS the compute lock (won the election, registered as leader) and then
    // failed/timed out → proactively expire it so a waiting follower wakes promptly (leader_failed)
    // instead of blocking for the full ttl. Gated on lock OWNERSHIP (leaderIdentity), not on whether
    // the engine-commit charge fired: a leader that throws BEFORE charging (e.g. executorFor throws)
    // still holds the lock and must release it. Best-effort.
    if (leaderIdentity !== undefined) {
      await deps.computeLock!.expire(leaderIdentity, deps.lease!.workerId, deps.clock()).catch(() => {});
    }
  } finally {
    await executor?.close?.();
    sandboxRouter?.closeAll();
    await sandboxBundle?.cleanup();
    if (leaderIdentity !== undefined) deps.unregisterLeader?.(leaderIdentity);
  }

  const finished = await deps.store.get(runId);

  if (deps.obs && tClaim !== undefined) {
    try {
      const tTerminal = deps.clock();
      const sample: JobObsSample = {
        runId,
        engine: claimed.request.engine ?? 'momentum',
        outcome: finished?.status ?? 'unknown',
        ...(finished?.terminalCode !== undefined ? { terminalCode: finished.terminalCode } : {}),
        dedup: dedupClass,
        queueWaitMs: claimed.queuedAtMs !== undefined ? tClaim - claimed.queuedAtMs : null,
        materializeMs: tMaterialized !== undefined ? tMaterialized - tClaim : null,
        engineMs: tEngineDone !== undefined && tMaterialized !== undefined ? tEngineDone - tMaterialized : null,
        totalMs: tTerminal - tClaim,
        ...(caughtErrorDetail !== undefined ? { errorDetail: caughtErrorDetail } : {}),
      };
      deps.obs.recordJob(sample);
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ evt: 'job_terminal', ...sample, ts: tTerminal }));
    } catch {
      // Observability is best-effort: it must never fail a job.
    }
  }

  if (finished) await publishCompletion(deps, finished);
  return finished;
}

/** Drain queued jobs with up to `concurrency` runs in flight (default 1 = serial). Returns count processed. */
export async function drainQueue(deps: WorkerDeps, concurrency = 1): Promise<number> {
  return runBoundedPool(concurrency, async () => (await processNextQueued(deps)) !== undefined);
}

/**
 * Long-lived worker drain loop. Drains via the bounded pool, heartbeats its leases on in-flight jobs,
 * recovers orphans via reapAndPublish, idles on pollMs when empty, and resolves when `signal` aborts.
 */
export async function runWorkerLoop(
  deps: WorkerDeps,
  opts: {
    concurrency: number;
    heartbeatMs: number;
    pollMs: number;
    signal: AbortSignal;
    /** Wakes the idle wait early on a queue NOTIFY. Absent ⇒ today's inline-timeout poll (unchanged). */
    waker?: import('./queue-notify.js').QueueWaker;
  },
): Promise<void> {
  let pendingRenew: Promise<unknown> = Promise.resolve();
  // Active-leader identities for this worker: populated by the gate's registerLeader (Task 6, lock-win)
  // and cleared by unregisterLeader (terminal/defer finally). The beat below renews each so a long
  // engine run never lets the compute-lock lapse into a spurious takeover.
  const activeLeaders = new Set<string>();
  deps.registerLeader = (computeIdentity: string) => activeLeaders.add(computeIdentity);
  deps.unregisterLeader = (computeIdentity: string) => activeLeaders.delete(computeIdentity);
  const beat = setInterval(() => {
    if (deps.lease) {
      pendingRenew = deps.store
        .renewLease(deps.lease.workerId, deps.clock() + deps.lease.ttlMs)
        .catch(() => {}); // ignore post-shutdown errors (pool may be tearing down)
      // Compute-lock renew is SEPARATE from and additional to the job-lease renew above — only when
      // coalescing is on (INV-6: coalescing-off loop behavior unchanged). Best-effort, like the lease renew.
      if (deps.computeLock && deps.coalesceEnabled) {
        const until = deps.clock() + (deps.computeLockTtlMs ?? deps.lease.ttlMs);
        for (const ci of activeLeaders) {
          void deps.computeLock.renew(ci, deps.lease.workerId, until).catch(() => {});
        }
      }
    }
  }, opts.heartbeatMs);
  try {
    while (!opts.signal.aborted) {
      const processed = await drainQueue(deps, opts.concurrency);
      await reapAndPublish(deps, {
        leaseMaxAttempts: deps.lease?.maxAttempts,
        coalesceEnabled: deps.coalesceEnabled,
        computeWaitMaxAttempts: deps.computeWaitMaxAttempts,
      });
      // P1-2: in the multi-process topology ONLY this loop runs — the app-level tick() that flushes the
      // durable outbox never fires, so a webhook that failed once is never retried. Redeliver each pass.
      await deliverOutbox(deps);
      if (deps.coalesceEnabled && deps.computeLock && deps.resultCache) {
        await wakeComputeWaiters({
          store: deps.store,
          resultCache: deps.resultCache,
          computeLock: deps.computeLock,
          clock: deps.clock,
          computeWaitMaxAttempts: deps.computeWaitMaxAttempts ?? 3,
        });
      }
      if (opts.signal.aborted) break;
      if (processed === 0) {
        if (opts.waker) {
          await opts.waker.waitForWake(opts.pollMs, opts.signal);
        } else {
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, opts.pollMs);
            opts.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
          });
        }
      }
    }
  } finally {
    clearInterval(beat);
    await pendingRenew; // drain the last in-flight heartbeat so it can't reject after the loop resolves
  }
}
