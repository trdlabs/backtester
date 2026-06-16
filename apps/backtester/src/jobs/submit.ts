// Submit service — validate, fingerprint, idempotent insert, accepted -> queued.

import type { ContentHash, RunJobHandle, RunSubmitRequest } from '@trading/research-contracts';
import { METRIC_CATALOG } from '@trading/research-contracts';
import { validateBundle } from '../sandbox/bundle';
import type { BundleStore } from '../sandbox/bundle-store';
import { requestFingerprint } from './fingerprint';
import { toHandle, type JobEventRow, type JobStore, type NewJob } from './job-store';

export class SubmitError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SubmitError';
  }
}

export interface SubmitDeps {
  store: JobStore;
  clock: () => number;
  uid: () => string;
  defaultQueueTimeoutMs: number;
  defaultRunTimeoutMs: number;
  bundleStore?: BundleStore;
}

const VALID_MODES = new Set(['research', 'review', 'promotion']);
const VALID_METRICS = new Set<string>(METRIC_CATALOG);

function validate(req: RunSubmitRequest): void {
  if (!req || typeof req !== 'object') {
    throw new SubmitError(400, 'validation_error', 'request body must be an object');
  }
  if (typeof req.datasetRef !== 'string' || req.datasetRef.length === 0) {
    throw new SubmitError(400, 'validation_error', 'datasetRef is required');
  }
  if (!req.moduleRef || typeof req.moduleRef.id !== 'string' || typeof req.moduleRef.version !== 'string') {
    throw new SubmitError(400, 'validation_error', 'moduleRef {id, version} is required');
  }
  if (!Array.isArray(req.symbols) || req.symbols.length === 0) {
    throw new SubmitError(400, 'validation_error', 'symbols must be a non-empty array');
  }
  if (typeof req.timeframe !== 'string' || req.timeframe.length === 0) {
    throw new SubmitError(400, 'validation_error', 'timeframe is required');
  }
  if (!req.period || typeof req.period.from !== 'string' || typeof req.period.to !== 'string') {
    throw new SubmitError(400, 'validation_error', 'period {from, to} is required');
  }
  if (typeof req.mode !== 'string' || !VALID_MODES.has(req.mode)) {
    throw new SubmitError(400, 'validation_error', 'mode must be research|review|promotion');
  }
  if (typeof req.seed !== 'number' || !Number.isFinite(req.seed)) {
    throw new SubmitError(400, 'validation_error', 'seed must be a finite number');
  }
  if (req.metrics !== undefined) {
    if (!Array.isArray(req.metrics)) {
      throw new SubmitError(400, 'validation_error', 'metrics must be an array');
    }
    const unknown = req.metrics.filter((m) => !VALID_METRICS.has(m));
    if (unknown.length > 0) {
      throw new SubmitError(400, 'validation_error', `unknown_metric: ${unknown.join(', ')}`);
    }
  }
  if (req.moduleBundle !== undefined) {
    const issues = validateBundle(req.moduleBundle);
    if (issues.length > 0) {
      throw new SubmitError(400, 'validation_error', `invalid module bundle: ${issues.map((i) => i.code).join(', ')}`);
    }
  }
}

function eventRow(
  store: JobStore,
  uid: string,
  jobId: string,
  runId: string,
  eventType: JobEventRow['eventType'],
  atMs: number,
): JobEventRow {
  return { eventUid: uid, jobId, runId, eventType, payload: { eventType, runId, atMs }, createdAtMs: atMs };
}

export interface SubmitOutcome {
  handle: RunJobHandle;
  created: boolean;
}

export async function submitRun(deps: SubmitDeps, body: RunSubmitRequest): Promise<SubmitOutcome> {
  validate(body);

  const runId = body.runId ?? deps.uid();
  const fingerprint = requestFingerprint(body);
  const now = deps.clock();

  // Store a submitted bundle in the own content-addressed registry; the job keeps only the hash.
  let storedBundleHash: ContentHash | undefined;
  if (body.moduleBundle) {
    if (!deps.bundleStore) {
      throw new SubmitError(400, 'validation_error', 'module bundle submission is not enabled');
    }
    storedBundleHash = await deps.bundleStore.put(body.moduleBundle);
  }

  const { moduleBundle: _omitBundle, ...rest } = body;
  const newJob: NewJob = {
    jobId: runId,
    runId,
    resumeToken: body.resumeToken,
    requestFingerprint: fingerprint,
    correlationId: body.correlationId,
    workflowId: body.workflowId,
    request: { ...rest, runId, metrics: body.metrics ?? [] },
    effectiveSeed: body.seed,
    datasetRef: body.datasetRef,
    callbackUrl: body.callbackUrl,
    queueDeadlineMs: now + (body.queueTimeoutMs ?? deps.defaultQueueTimeoutMs),
    runTimeoutMs: body.runTimeoutMs ?? deps.defaultRunTimeoutMs,
    acceptedAtMs: now,
    ...(storedBundleHash ? { bundleHash: storedBundleHash } : {}),
  };

  const { job, created } = await deps.store.insertOrGet(newJob);
  if (!created) {
    if (job.requestFingerprint !== fingerprint) {
      throw new SubmitError(409, 'resume_token_conflict', 'resume token reused with a different request');
    }
    return { handle: toHandle(job, true), created: false };
  }

  await deps.store.appendEvent(eventRow(deps.store, deps.uid(), runId, runId, 'job_accepted', now));
  const queuedAt = deps.clock();
  await deps.store.transition(runId, 'accepted', 'queued', { atMs: queuedAt, queuedAtMs: queuedAt });
  await deps.store.appendEvent(eventRow(deps.store, deps.uid(), runId, runId, 'job_queued', queuedAt));

  return { handle: toHandle(job, false), created: true };
}
