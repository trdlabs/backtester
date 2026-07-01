// Worker — claims the oldest queued job, runs the backtest in-process, persists artifacts, transitions
// to a terminal state, and publishes the completion event. claimNextQueued is the concurrency-safe
// handoff (FOR UPDATE SKIP LOCKED in Pg). A job with a bundleHash runs in the Docker sandbox; otherwise
// the trusted momentum executor. Sandbox limit/▶failures map to a clean terminal status + terminal_code
// (never a service crash).

import type { ArtifactManifest, ArtifactReference, ContentHash } from '@trading-backtester/sdk/artifacts';
import type {
  BacktestRunRequest,
  RunPeriod,
  RunResultSummary,
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
import { TrustedMomentumExecutor, type ModuleExecutor } from '../runner/module-executor';
import { runBacktest, type BacktestResult } from '../runner/run-backtest';
import type { RunOutcome } from '../engine/artifacts';
import { SandboxModuleExecutor, type SandboxConfig } from '../sandbox/sandbox-executor';
import type { BundleStore } from '../sandbox/bundle-store';
import type { OverlaySandboxSettings } from '../config';
import { publishCompletion, reapAndPublish, type CompletionDeps } from './completion';
import type { JobRow, JobStore } from './job-store';
import { overlayTapeCache, momentumTapeCache, tapeCacheKey } from '../data/tape-cache.js';
import type { SigningKey } from '../evidence/signing.js';
import { produceStrategyEvidence } from '../evidence/produce-strategy-evidence.js';
import type { EvidenceScope } from '../evidence/body.js';
import { runBoundedPool } from './pool.js';
import { normalize, restamp, type DedupTemplate } from './dedup/restamp.js';
import { computeIdentity } from './dedup/compute-identity.js';
import type { ResultCache } from './dedup/result-cache.js';
import { DEDUP_COMPUTE_VERSION, DEDUP_TEMPLATE_VERSION } from './dedup/version.js';

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
}

function periodMs(period: RunPeriod): { tsFrom: number; tsTo: number } {
  const from = Date.parse(period.from);
  const to = Date.parse(period.to);
  return {
    tsFrom: Number.isNaN(from) ? 0 : from,
    tsTo: Number.isNaN(to) ? Number.MAX_SAFE_INTEGER : to,
  };
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

function overlayRouterFor(deps: WorkerDeps): ExecutorRouter {
  const policy = deps.overlaySandbox.policy;
  return createExecutorRouter({
    sandboxPolicies: createSandboxPolicyRegistry([policy]),
    sandboxPolicyRef: { id: policy.id, version: policy.version },
    sandboxDeps: overlaySandboxDeps(deps.overlaySandbox),
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

/**
 * Boundary indirection: processNextQueued invokes bundle/executor/router construction through this
 * object so tests can `vi.spyOn(workerInternals, 'sandboxBundleFor')` and prove a dedup HIT performs
 * NONE of them (a bare intra-module call would not be interceptable by the spy). Compute-skip proof.
 */
export const workerInternals = { sandboxBundleFor, executorFor, overlayRouterFor };

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
  const summary = toOverlaySummary(
    outcome,
    claimed.runId,
    persisted.artifactRefs,
    resultHash,
    datasetFingerprint,
    claimed.bundleHash,
    evidenceRef,
  );
  return { summary, manifest: persisted.manifest, resultHash };
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
  const claimed = await deps.store.claimNextQueued(
    deps.clock(),
    deps.lease ? { workerId: deps.lease.workerId, ttlMs: deps.lease.ttlMs } : undefined,
  );
  if (!claimed) return undefined;
  const runId = claimed.runId;

  let executor: ModuleExecutor | undefined;
  let sandboxRouter: ExecutorRouter | undefined;
  let sandboxBundle: SandboxBundleHandle | undefined;
  try {
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

    // ── DEDUP GATE ────────────────────────────────────────────────────────────
    // dedup engages only when the kill-switch is on AND a cache is wired.
    const dedupOn = deps.dedupEnabled === true && deps.resultCache !== undefined;
    // bypassCache skips the LOOKUP (force fresh) but a fresh successful run STILL populates below.
    const doLookup = dedupOn && claimed.request.bypassCache !== true;
    let sandboxPolicyVersion = '';
    if (dedupOn) {
      const policy = deps.overlaySandbox.policy;
      sandboxPolicyVersion = `${policy.id}@${policy.version}`;
    }

    let finalized: Finalized | undefined;
    let dedupedFrom: string | undefined;

    if (doLookup) {
      const identity = computeIdentity({
        requestFingerprint: claimed.requestFingerprint,
        datasetFingerprint: dsFingerprint,
        sandboxPolicyVersion,
      });
      const hit = await deps.resultCache!.lookup(identity);
      if (hit) {
        const template = (await deps.artifactStore.read(hit.templateRef as ContentHash)) as DedupTemplate;
        if (template.engine === engine && template.templateVersion === DEDUP_TEMPLATE_VERSION) {
          // Cache HIT: re-stamp the cached template under this runId. Deliberately performs NONE of
          // sandboxBundleFor / executorFor / router / engine — the whole point of dedup.
          const payload = restamp(template, runId);
          finalized = await finalizeResult(deps, engine, payload, claimed, dsFingerprint);
          dedupedFrom = hit.computeIdentity;
        }
      }
    }

    if (!finalized) {
      // ===== MISS PATH — the ONLY place engine execution happens =====
      let payload: unknown;
      if (claimed.request.engine === 'overlay') {
      // ===== OVERLAY PATH — lifted engine end-to-end (Slice 6a) =====
      const marketTape = materialized.marketTape!;

      let registry = buildTrustedRegistry();
      if (claimed.bundleHash !== undefined) {
        // Build the inline execution registry from the SAME canonical definition that `/v1/registry`
        // advertises, adding only the submitted overlay bundle — so discovery and execution can't drift.
        registry = buildInlineOverlayRegistry([sandboxBundle!.bundle]);
        sandboxRouter = workerInternals.overlayRouterFor(deps);
      }

      const outcome = await runOverlayBacktest(engineRequest, {
        registry,
        marketTape,
        ...(sandboxRouter ? { router: sandboxRouter } : {}),
      });
      if (outcome.status !== 'completed') {
        throw new RunnerError(
          'validation_error',
          `overlay run rejected: ${JSON.stringify(outcome.validation.issues)}`,
        );
      }
      payload = outcome;
      finalized = await finalizeResult(deps, 'overlay', outcome, claimed, dsFingerprint);
    } else if (claimed.request.engine === 'strategy') {
      // ===== STRATEGY PATH — kind:'strategy' lifecycle-bundle via sandbox (closes gap PR #57) =====
      // Pre-flight guards (bundle present, manifest.kind, moduleRef match) already ran above.
      const r = claimed.request;
      const marketTape = materialized.marketTape!;
      const registry = buildInlineOverlayRegistry([], [sandboxBundle!.bundle]);
      sandboxRouter = workerInternals.overlayRouterFor(deps);
      const outcome = await runStrategyBacktest(engineRequest, {
        registry,
        marketTape,
        ...(sandboxRouter ? { router: sandboxRouter } : {}),
      });
      if (outcome.status !== 'completed') {
        throw new RunnerError(
          'validation_error',
          `strategy run rejected: ${JSON.stringify(outcome.validation.issues)}`,
        );
      }
      // ── E4: evidence block (run-once, additive) ──────────────────────────────
      // Runs ONLY when curatedBaselineRef is set AND a signing key is present.
      // Any failure leaves evidenceRef undefined — the run still completes with resultHash.
      // curatedBaselineRef is NOT added to engineRequest (never reaches the 017 validator).
      let evidenceRef: ArtifactReference | undefined;
      if (claimed.request.curatedBaselineRef !== undefined && deps.evidenceSigningKey !== undefined) {
        try {
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
      const result = await runBacktest(engineRequest, {
        dataset,
        executor,
        ...(claimed.bundleHash !== undefined ? { bundleHash: claimed.bundleHash } : {}),
      });
      payload = result;
      finalized = await finalizeResult(deps, 'momentum', result, claimed, dsFingerprint);
    }

      // Populate the cache on ANY completed fresh run — INCLUDING a bypassCache run (bypass skips
      // lookup, not populate). Reachable only after the engine returned, before the terminal
      // transition, so failed/timeout/validation_error runs (which threw) never cache.
      if (dedupOn) {
        const normalized = normalize(engine, payload, runId);
        const templateRef = await deps.artifactStore.write(normalized);
        await deps.resultCache!.put({
          computeIdentity: computeIdentity({
            requestFingerprint: claimed.requestFingerprint,
            datasetFingerprint: dsFingerprint,
            sandboxPolicyVersion,
          }),
          requestFingerprint: claimed.requestFingerprint,
          datasetFingerprint: dsFingerprint,
          computeVersion: DEDUP_COMPUTE_VERSION,
          sandboxPolicyVersion,
          templateRef,
          createdAtMs: deps.clock(),
        });
      }
    }

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
    const code = err instanceof RunnerError ? err.code : 'runner_failure';
    const terminalStatus = err instanceof RunnerError ? err.terminalStatus : 'failed';
    const now = deps.clock();
    await deps.store.transition(runId, 'running', terminalStatus, {
      atMs: now,
      terminalAtMs: now,
      terminalCode: code,
    }, deps.lease?.workerId);
  } finally {
    await executor?.close?.();
    sandboxRouter?.closeAll();
    await sandboxBundle?.cleanup();
  }

  const finished = await deps.store.get(runId);
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
  opts: { concurrency: number; heartbeatMs: number; pollMs: number; signal: AbortSignal },
): Promise<void> {
  let pendingRenew: Promise<unknown> = Promise.resolve();
  const beat = setInterval(() => {
    if (deps.lease) {
      pendingRenew = deps.store
        .renewLease(deps.lease.workerId, deps.clock() + deps.lease.ttlMs)
        .catch(() => {}); // ignore post-shutdown errors (pool may be tearing down)
    }
  }, opts.heartbeatMs);
  try {
    while (!opts.signal.aborted) {
      const processed = await drainQueue(deps, opts.concurrency);
      await reapAndPublish(deps, { leaseMaxAttempts: deps.lease?.maxAttempts });
      if (opts.signal.aborted) break;
      if (processed === 0) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, opts.pollMs);
          opts.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
        });
      }
    }
  } finally {
    clearInterval(beat);
    await pendingRenew; // drain the last in-flight heartbeat so it can't reject after the loop resolves
  }
}
