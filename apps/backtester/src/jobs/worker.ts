// Worker — claims the oldest queued job, runs the backtest in-process, persists artifacts, transitions
// to a terminal state, and publishes the completion event. claimNextQueued is the concurrency-safe
// handoff (FOR UPDATE SKIP LOCKED in Pg). A job with a bundleHash runs in the Docker sandbox; otherwise
// the trusted momentum executor. Sandbox limit/▶failures map to a clean terminal status + terminal_code
// (never a service crash).

import type { ArtifactManifest, ContentHash } from '@trading-backtester/sdk/artifacts';
import type {
  BacktestRunRequest,
  RunPeriod,
  RunResultSummary,
} from '@trading-backtester/sdk/contracts';
import { API_CONTRACT_VERSION } from '@trading-backtester/sdk/contracts';
import { contentRef } from '../determinism/hash';
import { persistRunArtifacts, type ArtifactStore } from '../artifacts/store';
import { persistOverlayArtifacts } from '../artifacts/overlay-store';
import { datasetFingerprint, materialize, type BacktesterDataPort } from '../data/reader';
import { buildOverlayDataset } from '../engine/data-adapter';
import { runOverlayBacktest } from '../engine/run-overlay';
import { buildInlineOverlayRegistry, buildTrustedRegistry } from '../engine/trusted-registry';
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
import { runBacktest } from '../runner/run-backtest';
import { SandboxModuleExecutor, type SandboxConfig } from '../sandbox/sandbox-executor';
import type { BundleStore } from '../sandbox/bundle-store';
import type { OverlaySandboxSettings } from '../config';
import { publishCompletion, type CompletionDeps } from './completion';
import type { JobRow, JobStore } from './job-store';

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

/** Claim and run one queued job. Returns the (now terminal) row, or undefined if the queue was empty. */
export async function processNextQueued(deps: WorkerDeps): Promise<JobRow | undefined> {
  const claimed = await deps.store.claimNextQueued(deps.clock());
  if (!claimed) return undefined;
  const runId = claimed.runId;

  let executor: ModuleExecutor | undefined;
  let sandboxRouter: ExecutorRouter | undefined;
  let sandboxBundle: SandboxBundleHandle | undefined;
  try {
    let summary: RunResultSummary;
    let resultHash: ContentHash;
    let manifest: ArtifactManifest;
    let dsFingerprint: string;

    if (claimed.bundleHash !== undefined) {
      sandboxBundle = await sandboxBundleFor(deps, claimed.bundleHash);
    }

    if (claimed.request.engine === 'overlay') {
      // ===== OVERLAY PATH — lifted engine end-to-end (Slice 6a) =====
      const r = claimed.request;
      const marketTape = await buildOverlayDataset(deps.dataPort, {
        datasetRef: r.datasetRef,
        symbols: r.symbols,
        timeframe: r.timeframe,
        period: r.period,
      });
      // Wire-summary fingerprint only — NOT part of the hashed RunOutcome (platform golden).
      dsFingerprint = contentRef(r.symbols.map((s) => marketTape.candles(s)));

      const engineRequest: BacktestRunRequest = {
        runId,
        mode: r.mode,
        moduleRef: r.moduleRef,
        ...(r.overlayRefs !== undefined ? { overlayRefs: r.overlayRefs } : {}),
        datasetRef: r.datasetRef,
        symbols: r.symbols,
        timeframe: r.timeframe,
        period: r.period,
        ...(r.params !== undefined ? { params: r.params } : {}),
        ...(r.riskProfileRef !== undefined ? { riskProfileRef: r.riskProfileRef } : {}),
        ...(r.executionProfileRef !== undefined
          ? { executionProfileRef: r.executionProfileRef }
          : {}),
        seed: claimed.effectiveSeed,
        metrics: r.metrics,
        ...(r.robustnessChecks !== undefined ? { robustnessChecks: r.robustnessChecks } : {}),
      };

      let registry = buildTrustedRegistry();
      if (claimed.bundleHash !== undefined) {
        // Build the inline execution registry from the SAME canonical definition that `/v1/registry`
        // advertises, adding only the submitted overlay bundle — so discovery and execution can't drift.
        registry = buildInlineOverlayRegistry([sandboxBundle!.bundle]);
        sandboxRouter = overlayRouterFor(deps);
      }

      const outcome = runOverlayBacktest(engineRequest, {
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
      resultHash = contentRef(outcome);
      const persisted = await persistOverlayArtifacts(
        deps.artifactStore,
        outcome,
        dsFingerprint,
      );
      manifest = persisted.manifest;
      summary = toOverlaySummary(
        outcome,
        runId,
        persisted.artifactRefs,
        resultHash,
        dsFingerprint,
        claimed.bundleHash,
      );
    } else {
      // ===== MOMENTUM PATH — unchanged (golden eff10116… must not move) =====
      executor = await executorFor(deps, claimed);

      const reader = await deps.dataPort.openDataset(claimed.datasetRef);
      if (!reader) {
        throw new RunnerError('missing_dataset', `unknown dataset: ${claimed.datasetRef}`);
      }

      const { tsFrom, tsTo } = periodMs(claimed.request.period);
      const dataset = await materialize(reader, claimed.datasetRef, {
        tsFrom,
        tsTo,
        symbols: claimed.request.symbols,
      });
      dsFingerprint = datasetFingerprint(dataset);

      const request: BacktestRunRequest = {
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

      const result = await runBacktest(request, {
        dataset,
        executor,
        ...(claimed.bundleHash !== undefined ? { bundleHash: claimed.bundleHash } : {}),
      });
      const persisted = await persistRunArtifacts(deps.artifactStore, result, dsFingerprint);
      manifest = persisted.manifest;
      resultHash = contentRef(result);

      summary = {
        runId,
        status: 'completed',
        metrics: result.metrics,
        artifactRefs: persisted.artifactRefs,
        evidence: {
          seed: request.seed,
          contractVersion: API_CONTRACT_VERSION,
          moduleVersions: [request.moduleRef],
          datasetRef: request.datasetRef,
          datasetFingerprint: dsFingerprint,
          ...(claimed.bundleHash !== undefined ? { bundleHash: claimed.bundleHash } : {}),
        },
        resultHash,
      };
    }

    const now = deps.clock();
    await deps.store.transition(runId, 'running', 'completed', {
      atMs: now,
      terminalAtMs: now,
      lastActivityMs: now,
      resultSummary: summary,
      resultHash,
      artifactManifest: manifest,
      datasetFingerprint: dsFingerprint,
    });
  } catch (err) {
    const code = err instanceof RunnerError ? err.code : 'runner_failure';
    const terminalStatus = err instanceof RunnerError ? err.terminalStatus : 'failed';
    const now = deps.clock();
    await deps.store.transition(runId, 'running', terminalStatus, {
      atMs: now,
      terminalAtMs: now,
      terminalCode: code,
    });
  } finally {
    await executor?.close?.();
    sandboxRouter?.closeAll();
    await sandboxBundle?.cleanup();
  }

  const finished = await deps.store.get(runId);
  if (finished) await publishCompletion(deps, finished);
  return finished;
}

/** Drain every currently-queued job. Returns the number processed. */
export async function drainQueue(deps: WorkerDeps): Promise<number> {
  let processed = 0;
  while ((await processNextQueued(deps)) !== undefined) processed += 1;
  return processed;
}
