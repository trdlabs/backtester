// Job store — status of record for the async lifecycle. Slice 1 ships the in-memory implementation;
// a Postgres `JobStore` against `backtest_job` + `backtest_job_event` slots in behind this interface
// in Slice 2 (see docs/ARCHITECTURE.md §5, §7). Interface and transitions mirror trading-platform 031.

import type {
  ArtifactManifest,
  ContentHash,
  RunJobHandle,
  RunResultSummary,
  RunStatus,
  RunStatusView,
  RunSubmitRequest,
  RunTimelineEntry,
} from '@trading/research-contracts';
import { canTransition, isTerminal, publicStatus, type InternalJobStatus } from './lifecycle';
import type { ComputeWakeReason } from './coalesce/compute-lock.js';

export interface JobRow {
  jobId: string;
  runId: string;
  resumeToken?: string;
  requestFingerprint: string;
  correlationId?: string;
  workflowId?: string;
  status: InternalJobStatus;
  request: RunSubmitRequest;
  effectiveSeed: number;
  datasetRef: string;
  datasetFingerprint?: string;
  /** Content hash of the submitted bundle (sandbox runs); absent for trusted runs. */
  bundleHash?: ContentHash;
  callbackUrl?: string;
  queueDeadlineMs?: number;
  runTimeoutMs: number;
  runDeadlineMs?: number;
  /** Worker that currently holds this job (multi-process lease); absent when unclaimed. */
  leasedBy?: string;
  /** Epoch ms after which the lease is stale and the job may be requeued. */
  leaseExpiresAt?: number;
  /** Number of times this job has been claimed (for bounded requeue / poison detection). */
  attempts: number;
  acceptedAtMs: number;
  queuedAtMs?: number;
  startedAtMs?: number;
  terminalAtMs?: number;
  lastActivityMs?: number;
  resultSummary?: RunResultSummary;
  resultHash?: ContentHash;
  artifactManifest?: ArtifactManifest;
  terminalCode?: string;
  /** Provenance: computeIdentity of the cache entry this run was served from (dedup HIT). Observability
   *  only — NEVER part of result_hash. Absent for freshly-computed runs. */
  dedupedFrom?: string;
  /** Number of times this job has re-armed its compute-lock wait (coalescing follower path). */
  computeWaitAttempts: number;
  /** Identity of the compute-coordination lock this job is following/leading (coalescing). */
  computeIdentity?: string;
  /** Epoch ms deadline for the current compute-lock wait (coalescing follower path). */
  waitDeadlineMs?: number;
  /** Reason the follower last woke from its compute-lock wait (coalescing). */
  computeWakeReason?: ComputeWakeReason;
  /** Whether this job's engine `attempts` charge has already been committed (deferred-charge claim). */
  engineAttemptCharged?: boolean;
  timeline: RunTimelineEntry[];
}

export interface NewJob {
  jobId: string;
  runId: string;
  resumeToken?: string;
  requestFingerprint: string;
  correlationId?: string;
  workflowId?: string;
  request: RunSubmitRequest;
  effectiveSeed: number;
  datasetRef: string;
  bundleHash?: ContentHash;
  callbackUrl?: string;
  queueDeadlineMs?: number;
  runTimeoutMs: number;
  acceptedAtMs: number;
}

export interface JobRowPatch {
  atMs: number;
  queuedAtMs?: number;
  startedAtMs?: number;
  terminalAtMs?: number;
  lastActivityMs?: number;
  runDeadlineMs?: number;
  resultSummary?: RunResultSummary;
  resultHash?: ContentHash;
  artifactManifest?: ArtifactManifest;
  datasetFingerprint?: string;
  terminalCode?: string;
  /** Dedup provenance (computeIdentity of the served cache entry). Observability only. */
  dedupedFrom?: string;
  computeWaitAttempts?: number;
  computeIdentity?: string;
  waitDeadlineMs?: number;
  computeWakeReason?: ComputeWakeReason;
  engineAttemptCharged?: boolean;
  attempts?: number;
}

export type JobEventType =
  | 'job_accepted'
  | 'job_queued'
  | 'job_started'
  | 'job_completed'
  | 'job_failed'
  | 'job_canceled'
  | 'job_expired'
  | 'job_timed_out';

export type DeliveryState = 'pending' | 'delivered' | 'failed';

export interface JobEventRow {
  eventUid: string;
  jobId: string;
  runId: string;
  eventType: JobEventType;
  payload: unknown;
  createdAtMs: number;
  /** Outbox: set only for terminal events on a job with a callback URL. */
  deliveryState?: DeliveryState;
  deliveryAttempts?: number;
}

export interface JobStore {
  insertOrGet(job: NewJob): Promise<{ job: JobRow; created: boolean }>;
  get(runId: string): Promise<JobRow | undefined>;
  transition(runId: string, from: InternalJobStatus, to: InternalJobStatus, patch: JobRowPatch, expectLeasedBy?: string): Promise<boolean>;
  claimNextQueued(
    nowMs: number,
    lease?: { workerId: string; ttlMs: number },
    opts?: { coalesceEnabled?: boolean },
  ): Promise<JobRow | undefined>;
  renewLease(workerId: string, untilMs: number): Promise<void>;
  list(filter?: { status?: RunStatus; correlationId?: string; workflowId?: string }): Promise<JobRow[]>;
  appendEvent(ev: JobEventRow): Promise<void>;
  listEvents(runId: string): Promise<JobEventRow[]>;
  reapDeadlines(
    nowMs: number,
    opts?: { leaseMaxAttempts?: number; coalesceEnabled?: boolean; computeWaitMaxAttempts?: number },
  ): Promise<JobRow[]>;
  /** Outbox: terminal events still pending/failed delivery, oldest first. */
  listDeliverable(limit: number): Promise<JobEventRow[]>;
  markDelivered(eventUid: string, ok: boolean): Promise<void>;
  /** Coalescing wake step (Task 7). All jobs currently in the internal waiting_for_compute status. */
  listComputeWaiters(nowMs: number): Promise<JobRow[]>;
  /** Release every waiting_for_compute job for computeIdentity → queued (cache_ready). Does NOT
   *  overwrite queued_at_ms (preserves FIFO position). Returns the number of jobs released. */
  releaseAllComputeWaiters(
    computeIdentity: string,
    reason: ComputeWakeReason,
    nowMs: number,
  ): Promise<number>;
  /** Elect exactly one waiting_for_compute job for computeIdentity → queued (new leader). Does NOT
   *  overwrite queued_at_ms. Undefined if no waiter matched (already raced away). */
  electOneComputeWaiter(
    computeIdentity: string,
    reason: ComputeWakeReason,
    nowMs: number,
  ): Promise<JobRow | undefined>;
  /** Poison an exhausted waiting_for_compute job → failed(compute_wait_exhausted). */
  poisonComputeWaiter(runId: string, nowMs: number): Promise<boolean>;
}

export class InMemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, JobRow>();
  private readonly byKey = new Map<string, string>();
  private readonly events: JobEventRow[] = [];

  async insertOrGet(job: NewJob): Promise<{ job: JobRow; created: boolean }> {
    const key = job.resumeToken ?? job.runId;
    const existingRunId = this.byKey.get(key);
    if (existingRunId) {
      const existing = this.jobs.get(existingRunId);
      if (existing) return { job: existing, created: false };
    }
    const row: JobRow = {
      ...job,
      status: 'accepted',
      attempts: 0,
      computeWaitAttempts: 0,
      timeline: [{ status: 'accepted', atMs: job.acceptedAtMs }],
    };
    this.jobs.set(row.runId, row);
    this.byKey.set(key, row.runId);
    return { job: row, created: true };
  }

  async get(runId: string): Promise<JobRow | undefined> {
    return this.jobs.get(runId);
  }

  async transition(
    runId: string,
    from: InternalJobStatus,
    to: InternalJobStatus,
    patch: JobRowPatch,
    expectLeasedBy?: string,
  ): Promise<boolean> {
    const job = this.jobs.get(runId);
    if (!job || job.status !== from || !canTransition(from, to)) return false;
    if (expectLeasedBy !== undefined && job.leasedBy !== expectLeasedBy) return false;
    job.status = to;
    if (patch.queuedAtMs !== undefined) job.queuedAtMs = patch.queuedAtMs;
    if (patch.startedAtMs !== undefined) job.startedAtMs = patch.startedAtMs;
    if (patch.terminalAtMs !== undefined) job.terminalAtMs = patch.terminalAtMs;
    if (patch.lastActivityMs !== undefined) job.lastActivityMs = patch.lastActivityMs;
    if (patch.runDeadlineMs !== undefined) job.runDeadlineMs = patch.runDeadlineMs;
    if (patch.resultSummary !== undefined) job.resultSummary = patch.resultSummary;
    if (patch.resultHash !== undefined) job.resultHash = patch.resultHash;
    if (patch.artifactManifest !== undefined) job.artifactManifest = patch.artifactManifest;
    if (patch.datasetFingerprint !== undefined) job.datasetFingerprint = patch.datasetFingerprint;
    if (patch.terminalCode !== undefined) job.terminalCode = patch.terminalCode;
    if (patch.dedupedFrom !== undefined) job.dedupedFrom = patch.dedupedFrom;
    if (patch.computeWaitAttempts !== undefined) job.computeWaitAttempts = patch.computeWaitAttempts;
    if (patch.computeIdentity !== undefined) job.computeIdentity = patch.computeIdentity;
    if (patch.waitDeadlineMs !== undefined) job.waitDeadlineMs = patch.waitDeadlineMs;
    if (patch.computeWakeReason !== undefined) job.computeWakeReason = patch.computeWakeReason;
    if (patch.engineAttemptCharged !== undefined) job.engineAttemptCharged = patch.engineAttemptCharged;
    if (patch.attempts !== undefined) job.attempts = patch.attempts;
    // RunTimelineEntry.status is public-contract-shaped (feeds toStatusView's timeline verbatim) —
    // never record the internal 'waiting_for_compute' status there (INV-7).
    job.timeline.push({ status: to === 'waiting_for_compute' ? 'running' : to, atMs: patch.atMs });
    return true;
  }

  async claimNextQueued(
    nowMs: number,
    lease?: { workerId: string; ttlMs: number },
    opts?: { coalesceEnabled?: boolean },
  ): Promise<JobRow | undefined> {
    const queued = [...this.jobs.values()]
      .filter((j) => j.status === 'queued')
      .sort((a, b) =>
        (a.queuedAtMs ?? a.acceptedAtMs) - (b.queuedAtMs ?? b.acceptedAtMs) ||
        (a.runId < b.runId ? -1 : 1),
      );
    const next = queued[0];
    if (!next) return undefined;
    const ok = await this.transition(next.runId, 'queued', 'running', {
      atMs: nowMs,
      startedAtMs: nowMs,
      lastActivityMs: nowMs,
      runDeadlineMs: nowMs + next.runTimeoutMs,
    });
    if (!ok) return undefined;
    if (lease !== undefined) {
      next.leasedBy = lease.workerId;
      next.leaseExpiresAt = nowMs + lease.ttlMs;
      if (!opts?.coalesceEnabled) {
        next.attempts += 1;
      }
    }
    return next;
  }

  async renewLease(workerId: string, untilMs: number): Promise<void> {
    for (const job of this.jobs.values()) {
      if (job.status === 'running' && job.leasedBy === workerId) job.leaseExpiresAt = untilMs;
    }
  }

  async list(filter?: {
    status?: RunStatus;
    correlationId?: string;
    workflowId?: string;
  }): Promise<JobRow[]> {
    return [...this.jobs.values()]
      .filter((j) => !filter?.status || j.status === filter.status)
      .filter((j) => !filter?.correlationId || j.correlationId === filter.correlationId)
      .filter((j) => !filter?.workflowId || j.workflowId === filter.workflowId)
      .sort((a, b) => a.acceptedAtMs - b.acceptedAtMs);
  }

  async appendEvent(ev: JobEventRow): Promise<void> {
    this.events.push(ev);
  }

  async listEvents(runId: string): Promise<JobEventRow[]> {
    return this.events.filter((e) => e.runId === runId);
  }

  async listDeliverable(limit: number): Promise<JobEventRow[]> {
    return this.events
      .filter((e) => e.deliveryState === 'pending' || e.deliveryState === 'failed')
      .sort((a, b) => a.createdAtMs - b.createdAtMs)
      .slice(0, limit);
  }

  async markDelivered(eventUid: string, ok: boolean): Promise<void> {
    const ev = this.events.find((e) => e.eventUid === eventUid);
    if (!ev) return;
    ev.deliveryState = ok ? 'delivered' : 'failed';
    ev.deliveryAttempts = (ev.deliveryAttempts ?? 0) + 1;
  }

  async reapDeadlines(
    nowMs: number,
    opts?: { leaseMaxAttempts?: number; coalesceEnabled?: boolean; computeWaitMaxAttempts?: number },
  ): Promise<JobRow[]> {
    const maxAttempts = opts?.leaseMaxAttempts ?? 3;
    const waitCap = opts?.computeWaitMaxAttempts ?? 3;
    const coalesceEnabled = opts?.coalesceEnabled ?? false;
    const reaped: JobRow[] = [];
    for (const job of this.jobs.values()) {
      if (isTerminal(job.status)) continue;
      if (
        job.status === 'queued' &&
        job.queueDeadlineMs !== undefined &&
        nowMs > job.queueDeadlineMs
      ) {
        if (await this.transition(job.runId, 'queued', 'expired', {
          atMs: nowMs, terminalAtMs: nowMs, terminalCode: 'queue_deadline_exceeded',
        })) reaped.push(job);
      } else if (job.status === 'running') {
        const leaseStale = job.leaseExpiresAt !== undefined && nowMs > job.leaseExpiresAt;
        const runStale = job.runDeadlineMs !== undefined && nowMs > job.runDeadlineMs;
        // Coalescing crash-attribution (INV-6: only when coalesceEnabled — otherwise fall through to
        // the pre-existing single attempts-based path below, byte-identical to today). A lease-expired
        // running job that crashed BEFORE the engine charged its attempt (engineAttemptCharged=false)
        // must not consume the engine `attempts` budget — it re-arms the compute-wait counter instead,
        // poisoning only once that counter (not `attempts`) is exhausted.
        if (coalesceEnabled && leaseStale && job.engineAttemptCharged === false) {
          if (job.computeWaitAttempts >= waitCap) {
            if (await this.transition(job.runId, 'running', 'failed', {
              atMs: nowMs, terminalAtMs: nowMs, terminalCode: 'compute_wait_exhausted',
            })) reaped.push(job);
          } else if (
            await this.transition(job.runId, 'running', 'queued', {
              atMs: nowMs,
              queuedAtMs: nowMs,
              computeWaitAttempts: job.computeWaitAttempts + 1,
            })
          ) {
            const requeued = this.jobs.get(job.runId);
            if (requeued !== undefined) {
              requeued.leasedBy = undefined;
              requeued.leaseExpiresAt = undefined;
            }
          }
        } else if (leaseStale && job.attempts >= maxAttempts) {
          if (await this.transition(job.runId, 'running', 'failed', {
            atMs: nowMs, terminalAtMs: nowMs, terminalCode: 'lease_expired',
          })) reaped.push(job);
        } else if (leaseStale) {
          // requeue (non-terminal): clear the lease so a fresh worker can re-claim. Re-fetch the
          // canonical row after the transition rather than mutating the iterated reference, so this
          // does not depend on transition()'s in-place-vs-replace mutation strategy.
          if (await this.transition(job.runId, 'running', 'queued', { atMs: nowMs, queuedAtMs: nowMs })) {
            const requeued = this.jobs.get(job.runId);
            if (requeued !== undefined) {
              requeued.leasedBy = undefined;
              requeued.leaseExpiresAt = undefined;
            }
          }
        } else if (runStale) {
          if (await this.transition(job.runId, 'running', 'timed_out', {
            atMs: nowMs, terminalAtMs: nowMs, terminalCode: 'run_deadline_exceeded',
          })) reaped.push(job);
        }
      }
    }
    return reaped;
  }

  async listComputeWaiters(nowMs: number): Promise<JobRow[]> {
    return [...this.jobs.values()].filter((j) => j.status === 'waiting_for_compute');
  }

  async releaseAllComputeWaiters(
    computeIdentity: string,
    reason: ComputeWakeReason,
    nowMs: number,
  ): Promise<number> {
    let released = 0;
    for (const job of [...this.jobs.values()]) {
      if (job.status !== 'waiting_for_compute' || job.computeIdentity !== computeIdentity) continue;
      // Do NOT pass queuedAtMs — transition() only overwrites fields present in the patch, so the
      // job's original FIFO queued_at_ms is preserved.
      const ok = await this.transition(job.runId, 'waiting_for_compute', 'queued', {
        atMs: nowMs,
        computeWakeReason: reason,
        engineAttemptCharged: false,
      });
      if (ok) released += 1;
    }
    return released;
  }

  async electOneComputeWaiter(
    computeIdentity: string,
    reason: ComputeWakeReason,
    nowMs: number,
  ): Promise<JobRow | undefined> {
    const candidates = [...this.jobs.values()]
      .filter((j) => j.status === 'waiting_for_compute' && j.computeIdentity === computeIdentity)
      .sort((a, b) =>
        (a.queuedAtMs ?? a.acceptedAtMs) - (b.queuedAtMs ?? b.acceptedAtMs) ||
        (a.runId < b.runId ? -1 : 1),
      );
    const next = candidates[0];
    if (!next) return undefined;
    const ok = await this.transition(next.runId, 'waiting_for_compute', 'queued', {
      atMs: nowMs,
      computeWakeReason: reason,
      engineAttemptCharged: false,
    });
    return ok ? this.jobs.get(next.runId) : undefined;
  }

  async poisonComputeWaiter(runId: string, nowMs: number): Promise<boolean> {
    return this.transition(runId, 'waiting_for_compute', 'failed', {
      atMs: nowMs,
      terminalAtMs: nowMs,
      terminalCode: 'compute_wait_exhausted',
    });
  }
}

export function toStatusView(job: JobRow): RunStatusView {
  // waiting_for_compute is internal-only (INV-7) — externally a follower is still 'running'.
  return {
    runId: job.runId,
    jobId: job.jobId,
    status: publicStatus(job.status),
    timeline: job.timeline,
    ...(job.terminalCode !== undefined ? { terminalCode: job.terminalCode } : {}),
  };
}

export function toHandle(job: JobRow, idempotentReplay: boolean): RunJobHandle {
  return {
    jobId: job.jobId,
    runId: job.runId,
    status: 'accepted',
    effectiveSeed: job.effectiveSeed,
    requestFingerprint: job.requestFingerprint,
    idempotentReplay,
    ...(job.correlationId !== undefined ? { correlationId: job.correlationId } : {}),
    ...(job.workflowId !== undefined ? { workflowId: job.workflowId } : {}),
  };
}
