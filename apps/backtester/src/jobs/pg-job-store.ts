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
import { canTransition, type InternalJobStatus } from './lifecycle';
import { QUEUE_NOTIFY_CHANNEL } from './queue-notify-channel.js';
import type {
  JobEventRow,
  JobRow,
  JobRowPatch,
  JobStore,
  NewJob,
} from './job-store';
import type { ComputeWakeReason } from './coalesce/compute-lock.js';

interface JobDbRow {
  run_id: string;
  job_id: string;
  resume_token: string | null;
  request_fingerprint: string;
  correlation_id: string | null;
  workflow_id: string | null;
  status: InternalJobStatus;
  request_json: RunSubmitRequest;
  effective_seed: string;
  dataset_ref: string;
  dataset_fingerprint: string | null;
  bundle_hash: string | null;
  callback_url: string | null;
  queue_deadline_ms: string | null;
  run_timeout_ms: string;
  run_deadline_ms: string | null;
  leased_by: string | null;
  lease_expires_at: string | null;
  attempts: string | number;
  accepted_at_ms: string;
  queued_at_ms: string | null;
  started_at_ms: string | null;
  terminal_at_ms: string | null;
  last_activity_ms: string | null;
  result_summary_json: RunResultSummary | null;
  result_hash: string | null;
  artifact_manifest_json: ArtifactManifest | null;
  terminal_code: string | null;
  deduped_from: string | null;
  compute_wait_attempts: string | number;
  compute_identity: string | null;
  wait_deadline_ms: string | null;
  compute_wake_reason: string | null;
  engine_attempt_charged: boolean;
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
    leasedBy: str(r.leased_by),
    leaseExpiresAt: num(r.lease_expires_at),
    attempts: Number(r.attempts ?? 0),
    acceptedAtMs: Number(r.accepted_at_ms),
    queuedAtMs: num(r.queued_at_ms),
    startedAtMs: num(r.started_at_ms),
    terminalAtMs: num(r.terminal_at_ms),
    lastActivityMs: num(r.last_activity_ms),
    resultSummary: r.result_summary_json ?? undefined,
    resultHash: (r.result_hash as ContentHash | null) ?? undefined,
    artifactManifest: r.artifact_manifest_json ?? undefined,
    terminalCode: str(r.terminal_code),
    dedupedFrom: str(r.deduped_from),
    computeWaitAttempts: Number(r.compute_wait_attempts ?? 0),
    computeIdentity: str(r.compute_identity),
    waitDeadlineMs: num(r.wait_deadline_ms),
    computeWakeReason: (r.compute_wake_reason as ComputeWakeReason | null) ?? undefined,
    engineAttemptCharged: r.engine_attempt_charged ?? undefined,
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

  /** Wake listening workers: a job just became claimable. Best-effort — a lost NOTIFY only costs poll latency. */
  private async notifyQueued(): Promise<void> {
    await this.pool.query(`SELECT pg_notify($1, '')`, [QUEUE_NOTIFY_CHANNEL]);
  }

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

  async findByResumeToken(resumeToken: string): Promise<JobRow | undefined> {
    const r = await this.pool.query<JobDbRow>('SELECT * FROM backtest_job WHERE resume_token = $1', [
      resumeToken,
    ]);
    return r.rows[0] ? rowToJob(r.rows[0]) : undefined;
  }

  async countQueueStats(nowMs: number): Promise<{ depth: number; oldestQueuedAgeMs: number | null }> {
    const r = await this.pool.query<{ depth: string; oldest: string | null }>(
      "SELECT count(*)::text AS depth, min(COALESCE(queued_at_ms, accepted_at_ms))::text AS oldest FROM backtest_job WHERE status = 'queued'",
    );
    const row = r.rows[0];
    const depth = row ? Number.parseInt(row.depth, 10) : 0;
    const oldest = row?.oldest == null ? null : Number.parseInt(row.oldest, 10);
    return { depth, oldestQueuedAgeMs: oldest === null ? null : nowMs - oldest };
  }

  async transition(
    runId: string,
    from: InternalJobStatus,
    to: InternalJobStatus,
    patch: JobRowPatch,
    expectLeasedBy?: string,
  ): Promise<boolean> {
    if (!canTransition(from, to)) return false;
    // RunTimelineEntry.status is public-contract-shaped (feeds toStatusView's timeline verbatim) —
    // never record the internal 'waiting_for_compute' status there (INV-7). Suppress the entry entirely
    // on a same-status self-transition (e.g. the engine-commit attempts charge does running→running) —
    // only append when the status actually changed, to avoid a duplicate public timeline entry. An
    // empty array makes `timeline_json || $14::jsonb` a no-op concatenation.
    const entry: RunTimelineEntry[] =
      from === to ? [] : [{ status: to === 'waiting_for_compute' ? 'running' : to, atMs: patch.atMs }];
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
         deduped_from           = COALESCE($16, deduped_from),
         compute_wait_attempts  = COALESCE($17, compute_wait_attempts),
         compute_identity       = COALESCE($18, compute_identity),
         wait_deadline_ms       = COALESCE($19, wait_deadline_ms),
         compute_wake_reason    = COALESCE($20, compute_wake_reason),
         engine_attempt_charged = COALESCE($21, engine_attempt_charged),
         attempts               = COALESCE($22, attempts),
         timeline_json          = timeline_json || $14::jsonb
       WHERE run_id = $2 AND status = $3
         AND ($15::text IS NULL OR leased_by = $15)`,
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
        expectLeasedBy ?? null,
        patch.dedupedFrom ?? null,
        patch.computeWaitAttempts ?? null,
        patch.computeIdentity ?? null,
        patch.waitDeadlineMs ?? null,
        patch.computeWakeReason ?? null,
        patch.engineAttemptCharged ?? null,
        patch.attempts ?? null,
      ],
    );
    if (to === 'queued' && r.rowCount === 1) await this.notifyQueued();
    return r.rowCount === 1;
  }

  async claimNextQueued(
    nowMs: number,
    lease?: { workerId: string; ttlMs: number },
    opts?: { coalesceEnabled?: boolean },
  ): Promise<JobRow | undefined> {
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
         leased_by = $3,
         lease_expires_at = CASE WHEN $3::text IS NULL THEN NULL ELSE $1::bigint + $4::bigint END,
         attempts = CASE WHEN $3::text IS NULL OR $5::boolean THEN j.attempts ELSE j.attempts + 1 END,
         timeline_json = j.timeline_json || $2::jsonb
       FROM next WHERE j.run_id = next.run_id
       RETURNING j.*`,
      [nowMs, JSON.stringify(entry), lease?.workerId ?? null, lease?.ttlMs ?? 0, opts?.coalesceEnabled ?? false],
    );
    return r.rows[0] ? rowToJob(r.rows[0]) : undefined;
  }

  async renewLease(workerId: string, untilMs: number): Promise<void> {
    await this.pool.query(
      `UPDATE backtest_job SET lease_expires_at = $2::bigint
       WHERE status = 'running' AND leased_by = $1`,
      [workerId, untilMs],
    );
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

  async reapDeadlines(
    nowMs: number,
    opts?: { leaseMaxAttempts?: number; coalesceEnabled?: boolean; computeWaitMaxAttempts?: number },
  ): Promise<JobRow[]> {
    const maxAttempts = opts?.leaseMaxAttempts ?? 3;
    const coalesceEnabled = opts?.coalesceEnabled ?? false;
    const waitCap = opts?.computeWaitMaxAttempts ?? 3;
    const expired = await this.pool.query<JobDbRow>(
      `UPDATE backtest_job SET
         status = 'expired', terminal_at_ms = $1::bigint, terminal_code = 'queue_deadline_exceeded',
         timeline_json = timeline_json || $2::jsonb
       WHERE status IN ('queued', 'accepted') AND queue_deadline_ms IS NOT NULL AND $1::bigint > queue_deadline_ms
       RETURNING *`,
      [nowMs, JSON.stringify([{ status: 'expired', atMs: nowMs }])],
    );

    let requeued = 0;
    let coalescePoisoned: { rows: JobDbRow[] } = { rows: [] };
    if (coalesceEnabled) {
      // Coalescing crash-attribution (INV-6: gated on coalesceEnabled — the plain attempts-based
      // path below is unchanged, and its WHERE clauses explicitly exclude engine_attempt_charged =
      // false rows once coalescing is on, so a job never double-attributes across both paths).
      // Crash BEFORE the engine charged its attempt: re-arm compute_wait_attempts instead of
      // consuming the engine `attempts` budget; poison only once THAT counter is exhausted.
      coalescePoisoned = await this.pool.query<JobDbRow>(
        `UPDATE backtest_job SET
           status = 'failed', terminal_at_ms = $1::bigint, terminal_code = 'compute_wait_exhausted',
           timeline_json = timeline_json || $2::jsonb
         WHERE status = 'running' AND lease_expires_at IS NOT NULL
           AND $1::bigint > lease_expires_at AND engine_attempt_charged = false
           AND compute_wait_attempts >= $3
         RETURNING *`,
        [nowMs, JSON.stringify([{ status: 'failed', atMs: nowMs }]), waitCap],
      );
      const coalesceRequeue = await this.pool.query(
        `UPDATE backtest_job SET
           status = 'queued', queued_at_ms = $1::bigint, leased_by = NULL, lease_expires_at = NULL,
           compute_wait_attempts = compute_wait_attempts + 1,
           timeline_json = timeline_json || $2::jsonb
         WHERE status = 'running' AND lease_expires_at IS NOT NULL
           AND $1::bigint > lease_expires_at AND engine_attempt_charged = false
           AND compute_wait_attempts < $3`,
        [nowMs, JSON.stringify([{ status: 'queued', atMs: nowMs }]), waitCap],
      );
      requeued += coalesceRequeue.rowCount ?? 0;
    }
    // Crash DURING/AFTER the engine (or coalescing disabled): existing attempts-based path. When
    // coalesceEnabled, the engine_attempt_charged = false rows have already been handled above, so
    // this clause is scoped to engine_attempt_charged IS DISTINCT FROM false (true or NULL) to avoid
    // double-handling; when coalesceEnabled is false that extra clause is always-true and this SQL is
    // byte-identical to the pre-Task-7 query (INV-6).
    const engineChargedFilter = coalesceEnabled ? 'AND engine_attempt_charged IS DISTINCT FROM false' : '';
    // P2-3: under coalescing, a requeue resets the engine-commit charge (else a crash-before-charge loop
    // never advances `attempts`). Gated on coalesceEnabled so the non-coalescing path stays byte-identical.
    const chargedReset = coalesceEnabled ? 'engine_attempt_charged = false,' : '';
    // Poison: expired-lease running jobs at/over the attempts cap → terminal failure.
    const poisoned = await this.pool.query<JobDbRow>(
      `UPDATE backtest_job SET
         status = 'failed', terminal_at_ms = $1::bigint, terminal_code = 'lease_expired',
         timeline_json = timeline_json || $2::jsonb
       WHERE status = 'running' AND lease_expires_at IS NOT NULL
         AND $1::bigint > lease_expires_at AND attempts >= $3
         ${engineChargedFilter}
       RETURNING *`,
      [nowMs, JSON.stringify([{ status: 'failed', atMs: nowMs }]), maxAttempts],
    );
    // Requeue: expired-lease running jobs under the cap → back to 'queued', lease cleared (non-terminal).
    const attemptsRequeue = await this.pool.query(
      `UPDATE backtest_job SET
         status = 'queued', queued_at_ms = $1::bigint, leased_by = NULL, lease_expires_at = NULL,
         ${chargedReset}
         timeline_json = timeline_json || $2::jsonb
       WHERE status = 'running' AND lease_expires_at IS NOT NULL
         AND $1::bigint > lease_expires_at AND attempts < $3
         ${engineChargedFilter}`,
      [nowMs, JSON.stringify([{ status: 'queued', atMs: nowMs }]), maxAttempts],
    );
    requeued += attemptsRequeue.rowCount ?? 0;
    // P1-3: also time out a parked coalescing follower ('waiting_for_compute') past its run deadline.
    // It is woken only by wakeComputeWaiters (flag-gated); the run-deadline reaper is its ONLY backstop
    // when coalescing is rolled back. UNCONDITIONAL (not gated on coalesceEnabled). run_deadline_ms was
    // set at claim time and survives the running->waiting_for_compute transition.
    const timedOut = await this.pool.query<JobDbRow>(
      `UPDATE backtest_job SET
         status = 'timed_out', terminal_at_ms = $1::bigint, terminal_code = 'run_deadline_exceeded',
         timeline_json = timeline_json || $2::jsonb
       WHERE status IN ('running', 'waiting_for_compute')
         AND run_deadline_ms IS NOT NULL AND $1::bigint > run_deadline_ms
       RETURNING *`,
      [nowMs, JSON.stringify([{ status: 'timed_out', atMs: nowMs }])],
    );
    if (requeued > 0) await this.notifyQueued();
    return [...expired.rows, ...coalescePoisoned.rows, ...poisoned.rows, ...timedOut.rows].map(rowToJob);
  }

  async listComputeWaiters(): Promise<JobRow[]> {
    const r = await this.pool.query<JobDbRow>(
      `SELECT * FROM backtest_job WHERE status = 'waiting_for_compute'`,
    );
    return r.rows.map(rowToJob);
  }

  async releaseAllComputeWaiters(
    computeIdentity: string,
    reason: ComputeWakeReason,
    nowMs: number,
  ): Promise<number> {
    // Does NOT touch queued_at_ms — preserves FIFO position (INV: releaseAll/electOne must not
    // overwrite queued_at_ms).
    const r = await this.pool.query(
      `UPDATE backtest_job SET
         status = 'queued', compute_wake_reason = $2, engine_attempt_charged = false,
         timeline_json = timeline_json || $3::jsonb
       WHERE status = 'waiting_for_compute' AND compute_identity = $1`,
      [computeIdentity, reason, JSON.stringify([{ status: 'queued', atMs: nowMs }])],
    );
    return r.rowCount ?? 0;
  }

  async electOneComputeWaiter(
    computeIdentity: string,
    reason: ComputeWakeReason,
    nowMs: number,
  ): Promise<JobRow | undefined> {
    const r = await this.pool.query<JobDbRow>(
      `UPDATE backtest_job SET
         status = 'queued', compute_wake_reason = $2,
         engine_attempt_charged = false,
         timeline_json = timeline_json || $3::jsonb
       WHERE run_id = (
         SELECT run_id FROM backtest_job
         WHERE status = 'waiting_for_compute' AND compute_identity = $1
         ORDER BY COALESCE(queued_at_ms, accepted_at_ms) ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING *`,
      [computeIdentity, reason, JSON.stringify([{ status: 'queued', atMs: nowMs }])],
    );
    return r.rows[0] ? rowToJob(r.rows[0]) : undefined;
  }

  async poisonComputeWaiter(runId: string, nowMs: number): Promise<JobRow | undefined> {
    // #138 §2: RETURNING * so the poison CAS and the row fetch are one atomic statement — no separate
    // get() that, if it failed, would drop the completion for an already-terminal (unrecoverable) job.
    const r = await this.pool.query<JobDbRow>(
      `UPDATE backtest_job SET
         status = 'failed', terminal_at_ms = $2::bigint, terminal_code = 'compute_wait_exhausted',
         timeline_json = timeline_json || $3::jsonb
       WHERE run_id = $1 AND status = 'waiting_for_compute'
       RETURNING *`,
      [runId, nowMs, JSON.stringify([{ status: 'failed', atMs: nowMs }])],
    );
    return r.rows[0] ? rowToJob(r.rows[0]) : undefined;
  }
}
