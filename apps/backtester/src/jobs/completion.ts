// Completion / notification — 3 layers (031): (1) durable outbox event (source of truth),
// (2) best-effort webhook POST to the run's callback URL, (3) polling fallback (status/result reads).
// `deliverOutbox` redelivers pending/failed terminal events.

import type {
  CompletionEvent,
  CompletionEventType,
  RunResultSummary,
  TerminalRunStatus,
} from '@trading-backtester/sdk/contracts';
import { API_CONTRACT_VERSION } from '@trading-backtester/sdk/contracts';
import { isTerminal } from './lifecycle';
import type { JobRow, JobStore } from './job-store';

export type WebhookPoster = (url: string, event: CompletionEvent) => Promise<void>;

export interface CompletionDeps {
  store: JobStore;
  clock: () => number;
  uid: () => string;
  postWebhook: WebhookPoster;
}

const STATUS_TO_EVENT: Record<TerminalRunStatus, CompletionEventType> = {
  completed: 'job_completed',
  failed: 'job_failed',
  canceled: 'job_canceled',
  expired: 'job_expired',
  timed_out: 'job_timed_out',
};

/** Default webhook poster: POST JSON with a hard timeout. Throws on non-2xx (→ outbox retry). */
export function defaultWebhookPoster(timeoutMs = 10_000): WebhookPoster {
  return async (url, event) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`webhook responded ${res.status}`);
    } finally {
      clearTimeout(timer);
    }
  };
}

function synthesizeSummary(job: JobRow): RunResultSummary {
  // Only invoked from the isTerminal(job.status)-guarded publishCompletion path (see below):
  // 'waiting_for_compute' is non-terminal, so job.status is a real terminal RunStatus here (INV-7).
  return {
    runId: job.runId,
    status: job.status as TerminalRunStatus,
    metrics: {},
    artifactRefs: [],
    evidence: {
      seed: job.effectiveSeed,
      contractVersion: API_CONTRACT_VERSION,
      moduleVersions: [job.request.moduleRef],
      datasetRef: job.datasetRef,
      ...(job.datasetFingerprint !== undefined ? { datasetFingerprint: job.datasetFingerprint } : {}),
    },
  };
}

async function deliver(
  deps: CompletionDeps,
  eventUid: string,
  url: string,
  event: CompletionEvent,
): Promise<void> {
  try {
    await deps.postWebhook(url, event);
    await deps.store.markDelivered(eventUid, true);
  } catch {
    await deps.store.markDelivered(eventUid, false);
  }
}

/** Append the terminal outbox event and attempt webhook delivery (no-op for non-terminal jobs). */
export async function publishCompletion(deps: CompletionDeps, job: JobRow): Promise<void> {
  if (!isTerminal(job.status)) return;
  const status = job.status as TerminalRunStatus;
  const emittedAtMs = deps.clock();
  const event: CompletionEvent = {
    eventType: STATUS_TO_EVENT[status],
    jobId: job.jobId,
    runId: job.runId,
    status,
    ...(job.correlationId !== undefined ? { correlationId: job.correlationId } : {}),
    ...(job.workflowId !== undefined ? { workflowId: job.workflowId } : {}),
    summary: job.resultSummary ?? synthesizeSummary(job),
    emittedAtMs,
  };
  const eventUid = deps.uid();
  await deps.store.appendEvent({
    eventUid,
    jobId: job.jobId,
    runId: job.runId,
    eventType: event.eventType,
    payload: event,
    createdAtMs: emittedAtMs,
    deliveryState: job.callbackUrl ? 'pending' : undefined,
    deliveryAttempts: 0,
  });
  if (job.callbackUrl) await deliver(deps, eventUid, job.callbackUrl, event);
}

/** Reap queue/run deadline misses and publish their completion events. Returns the reaped rows. */
export async function reapAndPublish(
  deps: CompletionDeps,
  opts?: { leaseMaxAttempts?: number },
): Promise<JobRow[]> {
  const reaped = await deps.store.reapDeadlines(deps.clock(), opts);
  for (const job of reaped) await publishCompletion(deps, job);
  return reaped;
}

/** Retry pending/failed terminal deliveries. Returns the number of delivery attempts made. */
export async function deliverOutbox(deps: CompletionDeps, limit = 50): Promise<number> {
  const pending = await deps.store.listDeliverable(limit);
  let attempts = 0;
  for (const ev of pending) {
    const job = await deps.store.get(ev.runId);
    if (!job?.callbackUrl) {
      await deps.store.markDelivered(ev.eventUid, true); // nothing to deliver to; clear it
      continue;
    }
    await deliver(deps, ev.eventUid, job.callbackUrl, ev.payload as CompletionEvent);
    attempts += 1;
  }
  return attempts;
}
