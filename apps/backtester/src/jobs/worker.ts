// Worker — claims the oldest queued job, runs the backtest in-process, persists artifacts, and
// transitions to a terminal state. Slice 1 drains synchronously; the queue (the store) is the durable
// boundary, so Slice 2's Postgres store + multiple workers need no change here.

import type {
  BacktestRunRequest,
  RunPeriod,
  RunResultSummary,
} from '@trading/research-contracts';
import { CONTRACT_VERSION } from '@trading/research-contracts';
import { contentRef } from '../determinism/hash';
import { persistRunArtifacts, type ArtifactStore } from '../artifacts/store';
import {
  datasetFingerprint,
  materialize,
  type BacktesterDataPort,
} from '../data/reader';
import { runBacktest } from '../runner/run-backtest';
import type { JobEventRow, JobEventType, JobRow, JobStore } from './job-store';

export class RunnerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RunnerError';
  }
}

export interface WorkerDeps {
  store: JobStore;
  dataPort: BacktesterDataPort;
  artifactStore: ArtifactStore;
  clock: () => number;
  uid: () => string;
}

function periodMs(period: RunPeriod): { tsFrom: number; tsTo: number } {
  const from = Date.parse(period.from);
  const to = Date.parse(period.to);
  return {
    tsFrom: Number.isNaN(from) ? 0 : from,
    tsTo: Number.isNaN(to) ? Number.MAX_SAFE_INTEGER : to,
  };
}

function event(deps: WorkerDeps, job: JobRow, eventType: JobEventType, payload: unknown): JobEventRow {
  return {
    eventUid: deps.uid(),
    jobId: job.jobId,
    runId: job.runId,
    eventType,
    payload,
    createdAtMs: deps.clock(),
  };
}

/** Claim and run one queued job. Returns the (now terminal) row, or undefined if the queue was empty. */
export async function processNextQueued(deps: WorkerDeps): Promise<JobRow | undefined> {
  const claimed = await deps.store.claimNextQueued(deps.clock());
  if (!claimed) return undefined;
  const runId = claimed.runId;

  try {
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

    const result = runBacktest(request, { dataset });
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
    await deps.store.appendEvent(
      event(deps, claimed, 'job_completed', {
        eventType: 'job_completed',
        jobId: claimed.jobId,
        runId,
        status: 'completed',
        summary,
        emittedAtMs: now,
      }),
    );
  } catch (err) {
    const code = err instanceof RunnerError ? err.code : 'runner_failure';
    const now = deps.clock();
    await deps.store.transition(runId, 'running', 'failed', {
      atMs: now,
      terminalAtMs: now,
      terminalCode: code,
    });
    await deps.store.appendEvent(
      event(deps, claimed, 'job_failed', {
        eventType: 'job_failed',
        jobId: claimed.jobId,
        runId,
        status: 'failed',
        terminalCode: code,
        emittedAtMs: now,
      }),
    );
  }

  return deps.store.get(runId);
}

/** Drain every currently-queued job. Returns the number processed. */
export async function drainQueue(deps: WorkerDeps): Promise<number> {
  let processed = 0;
  while ((await processNextQueued(deps)) !== undefined) processed += 1;
  return processed;
}
