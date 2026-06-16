// Postgres JobStore — behaviorally equivalent to InMemoryJobStore, durable across restarts.
//
// Concurrency/atomicity guarantees:
//  - transition: conditional UPDATE ... WHERE run_id=$id AND status=$from (atomic CAS); terminal
//    statuses are immutable because canTransition(terminal, *) is false (guarded before the UPDATE).
//  - claimNextQueued: SELECT ... FOR UPDATE SKIP LOCKED inside a CTE, so two workers never claim the
//    same job.
//  - insertOrGet: INSERT ... ON CONFLICT DO NOTHING on the resume_token partial-unique index (or the
//    run_id PK when no token) — idempotency survives process restart over the same DB.

import type { Pool } from 'pg';
import type {
  ArtifactManifest,
  ContentHash,
  RunResultSummary,
  RunStatus,
  RunSubmitRequest,
  RunTimelineEntry,
} from '@trading/research-contracts';
import { canTransition } from './lifecycle';
import type {
  JobEventRow,
  JobRow,
  JobRowPatch,
  JobStore,
  NewJob,
} from './job-store';

interface JobDbRow {
  run_id: string;
  job_id: string;
  resume_token: string | null;
  request_fingerprint: string;
  correlation_id: string | null;
  workflow_id: string | null;
  status: RunStatus;
  request_json: RunSubmitRequest;
  effective_seed: string;
  dataset_ref: string;
  dataset_fingerprint: string | null;
  bundle_hash: string | null;
  callback_url: string | null;
  queue_deadline_ms: string | null;
  run_timeout_ms: string;
  run_deadline_ms: string | null;
  accepted_at_ms: string;
  queued_at_ms: string | null;
  started_at_ms: string | null;
  terminal_at_ms: string | null;
  last_activity_ms: string | null;
  result_summary_json: RunResultSummary | null;
  result_hash: string | null;
  artifact_manifest_json: ArtifactManifest | null;
  terminal_code: string | null;
  timeline_json: RunTimelineEntry[];
}

const num = (v: string | null): number | undefined => (v == null ? undefined : Number(v));
const str = (v: string | null): string | undefined => (v == null ? undefined : v);

function rowToJob(r: JobDbRow): JobRow {
  return {
    jobId: r.job_id,
    runId: r.run_id,
    resumeToken: str(r.resume_token),
    requestFingerprint: r.request_fingerprint,
    correlationId: str(r.correlation_id),
    workflowId: str(r.workflow_id),
    status: r.status,
    request: r.request_json,
    effectiveSeed: Number(r.effective_seed),
    datasetRef: r.dataset_ref,
    datasetFingerprint: str(r.dataset_fingerprint),
    bundleHash: (r.bundle_hash as ContentHash | null) ?? undefined,
    callbackUrl: str(r.callback_url),
    queueDeadlineMs: num(r.queue_deadline_ms),
    runTimeoutMs: Number(r.run_timeout_ms),
    runDeadlineMs: num(r.run_deadline_ms),
    acceptedAtMs: Number(r.accepted_at_ms),
    queuedAtMs: num(r.queued_at_ms),
    startedAtMs: num(r.started_at_ms),
    terminalAtMs: num(r.terminal_at_ms),
    lastActivityMs: num(r.last_activity_ms),
    resultSummary: r.result_summary_json ?? undefined,
    resultHash: (r.result_hash as ContentHash | null) ?? undefined,
    artifactManifest: r.artifact_manifest_json ?? undefined,
    terminalCode: str(r.terminal_code),
    timeline: r.timeline_json,
  };
}

interface EventDbRow {
  event_uid: string;
  job_id: string;
  run_id: string;
  event_type: JobEventRow['eventType'];
  payload_json: unknown;
  delivery_state: JobEventRow['deliveryState'] | null;
  delivery_attempts: number;
  created_at_ms: string;
}

function rowToEvent(r: EventDbRow): JobEventRow {
  return {
    eventUid: r.event_uid,
    jobId: r.job_id,
    runId: r.run_id,
    eventType: r.event_type,
    payload: r.payload_json,
    createdAtMs: Number(r.created_at_ms),
    deliveryState: r.delivery_state ?? undefined,
    deliveryAttempts: r.delivery_attempts,
  };
}

const SELECT_COLS = '*';

export class PgJobStore implements JobStore {
  constructor(private readonly pool: Pool) {}

  async insertOrGet(job: NewJob): Promise<{ job: JobRow; created: boolean }> {
    const timeline: RunTimelineEntry[] = [{ status: 'accepted', atMs: job.acceptedAtMs }];
    const values = [
      job.runId,
      job.jobId,
      job.resumeToken ?? null,
      job.requestFingerprint,
      job.correlationId ?? null,
      job.workflowId ?? null,
      JSON.stringify(job.request),
      job.effectiveSeed,
      job.datasetRef,
      job.callbackUrl ?? null,
      job.queueDeadlineMs ?? null,
      job.runTimeoutMs,
      job.acceptedAtMs,
      JSON.stringify(timeline),
      job.bundleHash ?? null,
    ];
    const conflict = job.resumeToken
      ? 'ON CONFLICT (resume_token) WHERE resume_token IS NOT NULL DO NOTHING'
      : 'ON CONFLICT (run_id) DO NOTHING';
    const inserted = await this.pool.query<JobDbRow>(
      `INSERT INTO backtest_job
         (run_id, job_id, resume_token, request_fingerprint, correlation_id, workflow_id,
          request_json, effective_seed, dataset_ref, callback_url, queue_deadline_ms, run_timeout_ms,
          accepted_at_ms, timeline_json, bundle_hash, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,'accepted')
       ${conflict}
       RETURNING ${SELECT_COLS}`,
      values,
    );
    if (inserted.rows[0]) return { job: rowToJob(inserted.rows[0]), created: true };

    const existing = job.resumeToken
      ? await this.pool.query<JobDbRow>('SELECT * FROM backtest_job WHERE resume_token = $1', [
          job.resumeToken,
        ])
      : await this.pool.query<JobDbRow>('SELECT * FROM backtest_job WHERE run_id = $1', [job.runId]);
    return { job: rowToJob(existing.rows[0]!), created: false };
  }

  async get(runId: string): Promise<JobRow | undefined> {
    const r = await this.pool.query<JobDbRow>('SELECT * FROM backtest_job WHERE run_id = $1', [runId]);
    return r.rows[0] ? rowToJob(r.rows[0]) : undefined;
  }

  async transition(
    runId: string,
    from: RunStatus,
    to: RunStatus,
    patch: JobRowPatch,
  ): Promise<boolean> {
    if (!canTransition(from, to)) return false;
    const entry: RunTimelineEntry[] = [{ status: to, atMs: patch.atMs }];
    const r = await this.pool.query(
      `UPDATE backtest_job SET
         status = $1,
         queued_at_ms           = COALESCE($4, queued_at_ms),
         started_at_ms          = COALESCE($5, started_at_ms),
         terminal_at_ms         = COALESCE($6, terminal_at_ms),
         last_activity_ms       = COALESCE($7, last_activity_ms),
         run_deadline_ms        = COALESCE($8, run_deadline_ms),
         result_summary_json    = COALESCE($9::jsonb, result_summary_json),
         result_hash            = COALESCE($10, result_hash),
         artifact_manifest_json = COALESCE($11::jsonb, artifact_manifest_json),
         dataset_fingerprint    = COALESCE($12, dataset_fingerprint),
         terminal_code          = COALESCE($13, terminal_code),
         timeline_json          = timeline_json || $14::jsonb
       WHERE run_id = $2 AND status = $3`,
      [
        to,
        runId,
        from,
        patch.queuedAtMs ?? null,
        patch.startedAtMs ?? null,
        patch.terminalAtMs ?? null,
        patch.lastActivityMs ?? null,
        patch.runDeadlineMs ?? null,
        patch.resultSummary ? JSON.stringify(patch.resultSummary) : null,
        patch.resultHash ?? null,
        patch.artifactManifest ? JSON.stringify(patch.artifactManifest) : null,
        patch.datasetFingerprint ?? null,
        patch.terminalCode ?? null,
        JSON.stringify(entry),
      ],
    );
    return r.rowCount === 1;
  }

  async claimNextQueued(nowMs: number): Promise<JobRow | undefined> {
    const entry: RunTimelineEntry[] = [{ status: 'running', atMs: nowMs }];
    const r = await this.pool.query<JobDbRow>(
      `WITH next AS (
         SELECT run_id FROM backtest_job
         WHERE status = 'queued'
         ORDER BY COALESCE(queued_at_ms, accepted_at_ms) ASC, run_id ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE backtest_job j SET
         status = 'running',
         started_at_ms = $1::bigint,
         last_activity_ms = $1::bigint,
         run_deadline_ms = $1::bigint + j.run_timeout_ms,
         timeline_json = j.timeline_json || $2::jsonb
       FROM next WHERE j.run_id = next.run_id
       RETURNING j.*`,
      [nowMs, JSON.stringify(entry)],
    );
    return r.rows[0] ? rowToJob(r.rows[0]) : undefined;
  }

  async list(filter?: {
    status?: RunStatus;
    correlationId?: string;
    workflowId?: string;
  }): Promise<JobRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter?.status) {
      params.push(filter.status);
      where.push(`status = $${params.length}`);
    }
    if (filter?.correlationId) {
      params.push(filter.correlationId);
      where.push(`correlation_id = $${params.length}`);
    }
    if (filter?.workflowId) {
      params.push(filter.workflowId);
      where.push(`workflow_id = $${params.length}`);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const r = await this.pool.query<JobDbRow>(
      `SELECT * FROM backtest_job ${clause} ORDER BY accepted_at_ms ASC`,
      params,
    );
    return r.rows.map(rowToJob);
  }

  async appendEvent(ev: JobEventRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO backtest_job_event
         (event_uid, job_id, run_id, event_type, payload_json, delivery_state, delivery_attempts, created_at_ms)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
       ON CONFLICT (event_uid) DO NOTHING`,
      [
        ev.eventUid,
        ev.jobId,
        ev.runId,
        ev.eventType,
        JSON.stringify(ev.payload),
        ev.deliveryState ?? null,
        ev.deliveryAttempts ?? 0,
        ev.createdAtMs,
      ],
    );
  }

  async listEvents(runId: string): Promise<JobEventRow[]> {
    const r = await this.pool.query<EventDbRow>(
      'SELECT * FROM backtest_job_event WHERE run_id = $1 ORDER BY created_at_ms ASC',
      [runId],
    );
    return r.rows.map(rowToEvent);
  }

  async listDeliverable(limit: number): Promise<JobEventRow[]> {
    const r = await this.pool.query<EventDbRow>(
      `SELECT * FROM backtest_job_event
       WHERE delivery_state IN ('pending','failed')
       ORDER BY created_at_ms ASC LIMIT $1`,
      [limit],
    );
    return r.rows.map(rowToEvent);
  }

  async markDelivered(eventUid: string, ok: boolean): Promise<void> {
    await this.pool.query(
      `UPDATE backtest_job_event
       SET delivery_state = $2, delivery_attempts = delivery_attempts + 1
       WHERE event_uid = $1`,
      [eventUid, ok ? 'delivered' : 'failed'],
    );
  }

  async reapDeadlines(nowMs: number): Promise<JobRow[]> {
    const expired = await this.pool.query<JobDbRow>(
      `UPDATE backtest_job SET
         status = 'expired', terminal_at_ms = $1::bigint, terminal_code = 'queue_deadline_exceeded',
         timeline_json = timeline_json || $2::jsonb
       WHERE status = 'queued' AND queue_deadline_ms IS NOT NULL AND $1::bigint > queue_deadline_ms
       RETURNING *`,
      [nowMs, JSON.stringify([{ status: 'expired', atMs: nowMs }])],
    );
    const timedOut = await this.pool.query<JobDbRow>(
      `UPDATE backtest_job SET
         status = 'timed_out', terminal_at_ms = $1::bigint, terminal_code = 'run_deadline_exceeded',
         timeline_json = timeline_json || $2::jsonb
       WHERE status = 'running' AND run_deadline_ms IS NOT NULL AND $1::bigint > run_deadline_ms
       RETURNING *`,
      [nowMs, JSON.stringify([{ status: 'timed_out', atMs: nowMs }])],
    );
    return [...expired.rows, ...timedOut.rows].map(rowToJob);
  }
}
