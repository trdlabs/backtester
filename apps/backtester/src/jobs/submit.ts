// Submit service — validate, fingerprint, idempotent insert, accepted -> queued.

import type { ContentHash } from '@trading-backtester/sdk/artifacts';
import type { RunJobHandle, RunSubmitRequest } from '@trading-backtester/sdk/contracts';
import { METRIC_CATALOG } from '@trading/research-contracts';
import { METRIC_CATALOG as OVERLAY_METRIC_CATALOG } from '@trading/research-contracts/research';
import { E1A_METRIC_CATALOG } from '../engine/metrics';
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
const VALID_OVERLAY_METRICS = new Set<string>([...OVERLAY_METRIC_CATALOG, ...E1A_METRIC_CATALOG]);

/** True when an IPv4 literal falls in a loopback / private / link-local range (incl. 169.254.169.254
 *  cloud metadata). Returns false for anything that is not a dotted-quad literal (a real hostname is
 *  allowed — this is a literal-only guard, not a DNS resolver). */
function isBlockedIpv4(s: string): boolean {
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]), b = Number(m[2]), c = Number(m[3]), d = Number(m[4]);
  if (a > 255 || b > 255 || c > 255 || d > 255) return false;
  return (
    a === 0 || a === 127 || a === 10 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/** Extract the embedded dotted-quad IPv4 from an IPv4-mapped ('::ffff:…') or deprecated IPv4-compatible
 *  ('::AABB:CCDD') IPv6 literal, or null when the host is neither. WHATWG URL normalizes these to their
 *  hex short form (e.g. `::ffff:127.0.0.1` → `::ffff:7f00:1`), so we must parse the hex groups — a naive
 *  dotted-quad check misses the normalized loopback/private literal entirely. */
function embeddedMappedIpv4(h: string): string | null {
  let tail: string | null = null;
  if (h.startsWith('::ffff:')) tail = h.slice(7); // IPv4-mapped
  else if (h.startsWith('::') && h.slice(2).split(':').length === 2) tail = h.slice(2); // IPv4-compatible (deprecated)
  if (tail === null) return null;
  if (tail.includes('.')) return tail; // already dotted-quad
  const g = tail.split(':');
  if (g.length !== 2) return null;
  const hi = parseInt(g[0], 16), lo = parseInt(g[1], 16);
  if (Number.isNaN(hi) || Number.isNaN(lo) || hi < 0 || lo < 0 || hi > 0xffff || lo > 0xffff) return null;
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

/** True when a URL hostname is a loopback / private / link-local / metadata literal — the classic SSRF
 *  targets. Literal checks only (no DNS resolution): a DNS-rebinding host that resolves to an internal
 *  IP is a residual risk tracked separately; this closes the direct-literal vectors. */
function isBlockedWebhookHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (h === '' || h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.includes(':')) {
    // IPv6 literal: loopback / unspecified / link-local (fe80::/10) / unique-local (fc00::/7).
    if (h === '::1' || h === '::') return true;
    if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
    const mapped = embeddedMappedIpv4(h); // IPv4-mapped / IPv4-compatible → check as IPv4
    if (mapped !== null) return isBlockedIpv4(mapped);
    return false;
  }
  return isBlockedIpv4(h);
}

/** SSRF guard for the completion webhook URL (P1-6). Blocks non-http(s) schemes and internal-literal
 *  hosts so a submitter cannot make the server POST to cloud metadata / internal ports on completion. */
export function assertSafeCallbackUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SubmitError(400, 'validation_error', 'callbackUrl must be a valid absolute URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SubmitError(400, 'validation_error', 'callbackUrl must use http or https');
  }
  if (isBlockedWebhookHost(url.hostname)) {
    throw new SubmitError(400, 'validation_error', `callbackUrl host not allowed: ${url.hostname}`);
  }
}

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
  // P2-13: from/to must be parseable timestamps with from < to. Without this an unparseable period is
  // silently coerced to the full dataset span (momentum path) and — worse — signed into the evidence
  // scope window as {0, MAX_SAFE_INTEGER}. Reject uniformly at the front door for every engine.
  {
    const fromMs = Date.parse(req.period.from);
    const toMs = Date.parse(req.period.to);
    if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
      throw new SubmitError(400, 'validation_error', 'period {from, to} must be ISO-8601 timestamps');
    }
    if (fromMs >= toMs) {
      throw new SubmitError(400, 'validation_error', 'period.from must be strictly before period.to');
    }
  }
  // P1-6: SSRF guard — a submitter must not be able to make the server POST to an internal address.
  if (req.callbackUrl !== undefined) {
    assertSafeCallbackUrl(req.callbackUrl);
  }
  if (typeof req.mode !== 'string' || !VALID_MODES.has(req.mode)) {
    throw new SubmitError(400, 'validation_error', 'mode must be research|review|promotion');
  }
  if (typeof req.seed !== 'number' || !Number.isFinite(req.seed)) {
    throw new SubmitError(400, 'validation_error', 'seed must be a finite number');
  }
  // E3b: walkForward is arbitrary inbound JSON at runtime — the object guard MUST run before any
  // `.folds`/`.mode` access, else `walkForward: null` (or a string/array) crashes instead of 400ing.
  if (req.walkForward !== undefined) {
    const wf = req.walkForward as unknown;
    if (typeof wf !== 'object' || wf === null || Array.isArray(wf)) {
      throw new SubmitError(400, 'validation_error', 'walkForward must be an object { folds, mode }');
    }
    const { folds, mode } = wf as { folds?: unknown; mode?: unknown };
    if (!Number.isSafeInteger(folds) || (folds as number) < 1) {
      throw new SubmitError(400, 'validation_error', 'walkForward.folds must be an integer >= 1');
    }
    if (mode !== 'rolling' && mode !== 'expanding') {
      throw new SubmitError(400, 'validation_error', "walkForward.mode must be 'rolling' or 'expanding'");
    }
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
  // P2-5 race (#138 §1): honor the CAS. reapDeadlines now expires an `accepted` job past its queue
  // deadline, so a concurrent reaper may terminalize this row between insertOrGet and here. If the
  // accepted->queued transition loses that race, DO NOT append job_queued (it would land AFTER a terminal
  // state) — re-read and return the canonical (terminal) row instead of a stale accepted snapshot.
  const enqueued = await deps.store.transition(runId, 'accepted', 'queued', { atMs: queuedAt, queuedAtMs: queuedAt });
  if (!enqueued) {
    const canonical = (await deps.store.get(runId)) ?? job;
    return { handle: toHandle(canonical, false), created: true };
  }
  await deps.store.appendEvent(eventRow(deps.store, deps.uid(), runId, runId, 'job_queued', queuedAt));

  return { handle: toHandle(job, false), created: true };
}
