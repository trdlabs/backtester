// P2-5 — a job crashed mid-submit (insertOrGet(accepted) committed, transition→queued not yet) is left
// stuck in `accepted`. The reaper only expired `queued`, so the job never terminalized and a resumeToken
// replay re-attached to the corpse. reapDeadlines must now expire `accepted` past its queue deadline too.
// See CODE-REVIEW-2026-07-12.md P2-5 and docs/specs/P2-5-6-7-queue-reliability.md.
import { describe, expect, it } from 'vitest';
import { InMemoryJobStore, type NewJob } from '../src/jobs/job-store.js';
import { reapAndPublish } from '../src/jobs/completion.js';

const CLOCK = 1_700_000_000_000;

function acceptedJob(
  runId: string,
  opts?: { resumeToken?: string; queueDeadlineMs?: number; callbackUrl?: string },
): NewJob {
  return {
    jobId: runId,
    runId,
    requestFingerprint: `fp-${runId}`,
    request: {} as never,
    effectiveSeed: 1,
    datasetRef: 'ds',
    queueDeadlineMs: opts?.queueDeadlineMs ?? CLOCK + 30_000,
    runTimeoutMs: 3_600_000,
    acceptedAtMs: CLOCK,
    ...(opts?.resumeToken ? { resumeToken: opts.resumeToken } : {}),
    ...(opts?.callbackUrl ? { callbackUrl: opts.callbackUrl } : {}),
  };
}

// reapAndPublish only needs store/clock/uid/postWebhook off the deps bag.
function completionDeps(store: InMemoryJobStore, nowMs: number, posted: Array<{ url: string; event: unknown }>) {
  return {
    store,
    clock: () => nowMs,
    uid: () => 'evt',
    postWebhook: async (url: string, event: unknown) => {
      posted.push({ url, event });
    },
  } as never;
}

describe('P2-5 — reap recovers a job stuck in accepted past its queue deadline', () => {
  it('expires an accepted job whose queue deadline has passed and publishes completion', async () => {
    const store = new InMemoryJobStore();
    // insertOrGet lands the job in `accepted`; the crash happened before the transition to `queued`.
    await store.insertOrGet(acceptedJob('stuck', { queueDeadlineMs: CLOCK, callbackUrl: 'https://cb.example/hook' }));
    expect((await store.get('stuck'))!.status).toBe('accepted');

    const posted: Array<{ url: string; event: unknown }> = [];
    const reaped = await reapAndPublish(completionDeps(store, CLOCK + 60_000, posted));

    const job = (await store.get('stuck'))!;
    expect(job.status).toBe('expired');
    expect(job.terminalCode).toBe('queue_deadline_exceeded');
    expect(reaped.map((j) => j.runId)).toContain('stuck');
    expect(posted).toHaveLength(1); // owner learns via the published completion, not by polling
  });

  it('does not reap an accepted job before its queue deadline (no over-reap)', async () => {
    const store = new InMemoryJobStore();
    await store.insertOrGet(acceptedJob('fresh', { queueDeadlineMs: CLOCK + 30_000 }));

    const posted: Array<{ url: string; event: unknown }> = [];
    await reapAndPublish(completionDeps(store, CLOCK + 1_000, posted));

    expect((await store.get('fresh'))!.status).toBe('accepted');
    expect(posted).toHaveLength(0);
  });

  it('resumeToken replay after reap returns the terminal handle, not a stuck non-terminal corpse', async () => {
    const store = new InMemoryJobStore();
    await store.insertOrGet(acceptedJob('corpse', { resumeToken: 'tok-1', queueDeadlineMs: CLOCK }));

    const posted: Array<{ url: string; event: unknown }> = [];
    await reapAndPublish(completionDeps(store, CLOCK + 60_000, posted));

    const found = await store.findByResumeToken('tok-1');
    expect(found?.status).toBe('expired'); // terminal — replay no longer sticks to a non-terminal accepted
  });
});
