// Worker — claims the oldest queued job, runs the backtest in-process, persists artifacts, transitions
// to a terminal state, and publishes the completion event. claimNextQueued is the concurrency-safe
// handoff (FOR UPDATE SKIP LOCKED in Pg). A job with a bundleHash runs in the Docker sandbox; otherwise
// the trusted momentum executor. Sandbox limit/▶failures map to a clean terminal status + terminal_code
// (never a service crash).

import type { BacktestRunRequest, RunPeriod, RunResultSummary } from '@trading/research-contracts';
import { CONTRACT_VERSION } from '@trading/research-contracts';
import { contentRef } from '../determinism/hash';
import { persistRunArtifacts, type ArtifactStore } from '../artifacts/store';
import { datasetFingerprint, materialize, type BacktesterDataPort } from '../data/reader';
import { RunnerError } from '../runner/errors';
import { TrustedMomentumExecutor, type ModuleExecutor } from '../runner/module-executor';
import { runBacktest } from '../runner/run-backtest';
import { SandboxModuleExecutor, type SandboxConfig } from '../sandbox/sandbox-executor';
import type { BundleStore } from '../sandbox/bundle-store';
import { publishCompletion, type CompletionDeps } from './completion';
import type { JobRow, JobStore } from './job-store';

export { RunnerError };

export interface WorkerDeps extends CompletionDeps {
  store: JobStore;
  dataPort: BacktesterDataPort;
  artifactStore: ArtifactStore;
  bundleStore?: BundleStore;
  sandbox?: SandboxConfig;
}

function periodMs(period: RunPeriod): { tsFrom: number; tsTo: number } {
  const from = Date.parse(period.from);
  const to = Date.parse(period.to);
  return {
    tsFrom: Number.isNaN(from) ? 0 : from,
    tsTo: Number.isNaN(to) ? Number.MAX_SAFE_INTEGER : to,
  };
}

async function executorFor(deps: WorkerDeps, job: JobRow): Promise<ModuleExecutor> {
  if (!job.bundleHash) return new TrustedMomentumExecutor();
  if (!deps.bundleStore || !deps.sandbox) {
    throw new RunnerError('sandbox_unavailable', 'sandbox execution is not configured');
  }
  const bundle = await deps.bundleStore.get(job.bundleHash);
  if (!bundle) throw new RunnerError('missing_module', `unknown bundle: ${job.bundleHash}`);
  return new SandboxModuleExecutor(bundle, deps.sandbox);
}

/** Claim and run one queued job. Returns the (now terminal) row, or undefined if the queue was empty. */
export async function processNextQueued(deps: WorkerDeps): Promise<JobRow | undefined> {
  const claimed = await deps.store.claimNextQueued(deps.clock());
  if (!claimed) return undefined;
  const runId = claimed.runId;

  let executor: ModuleExecutor | undefined;
  try {
    executor = await executorFor(deps, claimed);

    const reader = await deps.dataPort.openDataset(claimed.datasetRef);
    if (!reader) throw new RunnerError('missing_dataset', `unknown dataset: ${claimed.datasetRef}`);

    const { tsFrom, tsTo } = periodMs(claimed.request.period);
    const dataset = await materialize(reader, claimed.datasetRef, {
      tsFrom,
      tsTo,
      symbols: claimed.request.symbols,
    });
    const dsFingerprint = datasetFingerprint(dataset);

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
    const { manifest, artifactRefs } = await persistRunArtifacts(
      deps.artifactStore,
      result,
      dsFingerprint,
    );
    const resultHash = contentRef(result);

    const summary: RunResultSummary = {
      runId,
      status: 'completed',
      metrics: result.metrics,
      artifactRefs,
      evidence: {
        seed: request.seed,
        contractVersion: CONTRACT_VERSION,
        moduleVersions: [request.moduleRef],
        datasetRef: request.datasetRef,
        datasetFingerprint: dsFingerprint,
        ...(claimed.bundleHash !== undefined ? { bundleHash: claimed.bundleHash } : {}),
      },
      resultHash,
    };

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
