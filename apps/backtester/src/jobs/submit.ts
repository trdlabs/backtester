// Submit service — validate, fingerprint, idempotent insert, accepted -> queued.

import type { ContentHash } from '@trading-backtester/sdk/artifacts';
import type { RunJobHandle, RunSubmitRequest } from '@trading-backtester/sdk/contracts';
import { METRIC_CATALOG } from '@trading/research-contracts';
import { METRIC_CATALOG as OVERLAY_METRIC_CATALOG } from '@trading/research-contracts/research';
import { validateBundle } from '../sandbox/bundle';
import type { BundleStore } from '../sandbox/bundle-store';
import { requestFingerprint, storedRequestFingerprint } from './fingerprint';
import { toHandle, type JobEventRow, type JobRow, type JobStore, type NewJob } from './job-store';

export class SubmitError extends Error {
  readonly category: string;
  readonly retryAfterS?: number;
  readonly extras?: Record<string, number>;
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    opts?: { category?: string; retryAfterS?: number; extras?: Record<string, number> },
  ) {
    super(message);
    this.name = 'SubmitError';
    this.category = opts?.category ?? 'validation_error';
    if (opts?.retryAfterS !== undefined) this.retryAfterS = opts.retryAfterS;
    if (opts?.extras !== undefined) this.extras = opts.extras;
  }
}

export interface SubmitDeps {
  store: JobStore;
  clock: () => number;
  uid: () => string;
  defaultQueueTimeoutMs: number;
  defaultRunTimeoutMs: number;
  enableOverlayEngine: boolean;
  bundleStore?: BundleStore;
  queueMaxDepth?: number;
  queueRetryAfterS?: number;
}

const CONTENT_HASH_RE = /^sha256:[0-9a-f]{64}$/;

const VALID_MODES = new Set(['research', 'review', 'promotion']);
const VALID_METRICS = new Set<string>(METRIC_CATALOG);
// Overlay runs execute the lifted engine, whose metric vocabulary is the platform/research catalog
// (sharpe, max_drawdown, …) rather than the momentum catalog. Gate accordingly.
const VALID_OVERLAY_METRICS = new Set<string>(OVERLAY_METRIC_CATALOG);

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
    if (req.engine === 'strategy' && req.metrics.length === 0) {
      throw new SubmitError(400, 'validation_error', 'metrics must be a non-empty array');
    }
    const catalog = req.engine === 'overlay' || req.engine === 'strategy' ? VALID_OVERLAY_METRICS : VALID_METRICS;
    const unknown = req.metrics.filter((m) => !catalog.has(m));
    if (unknown.length > 0) {
      throw new SubmitError(400, 'validation_error', `unknown_metric: ${unknown.join(', ')}`);
    }
  }
  if (req.moduleBundle !== undefined) {
    const issues = validateBundle(req.moduleBundle);
    if (issues.length > 0) {
      throw new SubmitError(400, 'validation_error', `invalid module bundle: ${issues.map((i) => i.code).join(', ')}`);
    }
    const expectedKind = req.engine === 'overlay' ? 'overlay' : 'strategy';
    if (req.moduleBundle.manifest.kind !== expectedKind) {
      throw new SubmitError(
        400,
        'validation_error',
        `module bundle kind must be ${expectedKind} for engine ${req.engine ?? 'momentum'}`,
      );
    }
  }
}

/** Replay contract: same resumeToken must carry the same run-affecting request. */
function assertReplayFingerprint(job: JobRow, fingerprint: string): void {
  if (storedRequestFingerprint(job.request, job.bundleHash ?? null) !== fingerprint) {
    throw new SubmitError(409, 'resume_token_conflict', 'resume token reused with a different request');
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
  // Gate the overlay engine BEFORE validate(): a disabled overlay request must surface the
  // engine-disabled message, not an incidental validation error (e.g. an overlay-only metric that
  // the momentum catalog would reject as unknown_metric).
  // Guard the dereference: a null / undefined / non-object body must NOT crash here (TypeError → 500);
  // it falls through to validate(), which returns a clean 400 'request body must be an object'.
  if (body != null && typeof body === 'object' && body.engine === 'overlay' && !deps.enableOverlayEngine) {
    throw new SubmitError(400, 'validation_error', 'overlay engine is disabled');
  }

  validate(body);

  const runId = body.runId ?? deps.uid();
  const fingerprint = requestFingerprint(body);
  const now = deps.clock();

  // Anchored flow: cheap replay pre-lookup BEFORE any bundle write. Guarantee is for ESTABLISHED
  // replays (the token's job already exists): they re-attach without paying bundleStore.put and
  // (Task 4) without seeing the queue cap. A CONCURRENT first-submit race (two initial submits with
  // one token, neither committed yet) may still pay one extra bundle put before the insertOrGet
  // backstop below deduplicates the job — accepted; content-addressed puts are idempotent.
  if (body.resumeToken !== undefined) {
    const existing = await deps.store.findByResumeToken(body.resumeToken);
    if (existing) {
      assertReplayFingerprint(existing, fingerprint);
      return { handle: toHandle(existing, true), created: false };
    }
  }

  // Backpressure backstop (approximate by design — a small race near the cap is acceptable):
  // only NEW jobs are capped; replays re-attached above never reach here.
  const cap = deps.queueMaxDepth ?? 0;
  if (cap > 0) {
    const { depth } = await deps.store.countQueueStats(now);
    if (depth >= cap) {
      throw new SubmitError(429, 'queue_full', `queue depth ${depth} >= cap ${cap}`, {
        category: 'rate_limit',
        retryAfterS: deps.queueRetryAfterS ?? 30,
        extras: { queueDepth: depth, maxDepth: cap },
      });
    }
  }

  // Store a submitted bundle in the own content-addressed registry; the job keeps only the hash.
  // A caller may reference an already-uploaded bundle by hash (bundleRef) instead of resending its
  // bytes (moduleBundle) — the two are mutually exclusive.
  if (body.moduleBundle && body.bundleRef) {
    throw new SubmitError(400, 'validation_error', 'provide either moduleBundle or bundleRef, not both');
  }
  let storedBundleHash: ContentHash | undefined;
  if (body.bundleRef) {
    if (!CONTENT_HASH_RE.test(body.bundleRef)) {
      throw new SubmitError(400, 'validation_error', `malformed bundleRef: ${body.bundleRef}`);
    }
    if (!deps.bundleStore) {
      throw new SubmitError(400, 'validation_error', 'module bundle submission is not enabled');
    }
    if (!(await deps.bundleStore.has(body.bundleRef))) {
      throw new SubmitError(409, 'unknown_bundle', `unknown bundle: ${body.bundleRef}`);
    }
    storedBundleHash = body.bundleRef;
  } else if (body.moduleBundle) {
    if (!deps.bundleStore) {
      throw new SubmitError(400, 'validation_error', 'module bundle submission is not enabled');
    }
    storedBundleHash = await deps.bundleStore.put(body.moduleBundle);
  }

  const { moduleBundle: _omitBundle, bundleRef: _omitRef, ...rest } = body;
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
    assertReplayFingerprint(job, fingerprint);
    return { handle: toHandle(job, true), created: false };
  }

  await deps.store.appendEvent(eventRow(deps.store, deps.uid(), runId, runId, 'job_accepted', now));
  const queuedAt = deps.clock();
  await deps.store.transition(runId, 'accepted', 'queued', { atMs: queuedAt, queuedAtMs: queuedAt });
  await deps.store.appendEvent(eventRow(deps.store, deps.uid(), runId, runId, 'job_queued', queuedAt));

  return { handle: toHandle(job, false), created: true };
}
