// P2-5 review (#138 §1) — the accepted-reap widened reapDeadlines to expire `accepted`, which opened a
// submit/reaper race: submitRun ignored the accepted->queued CAS result, so if a reaper expired the job
// between insertOrGet and the transition, submit still appended job_queued after the terminal state and
// returned a stale handle. submitRun must honor the CAS. See docs/specs/P2-5-6-7-queue-reliability.md.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InMemoryJobStore } from '../src/jobs/job-store.js';
import { submitRun, type SubmitDeps } from '../src/jobs/submit.js';
import { runBody } from './helpers.js';

const CLOCK = 1_700_000_000_000;

describe('P2-5 race — a reaper expiring the accepted job mid-submit must not append job_queued', () => {
  it('honors the accepted->queued CAS: no job_queued after terminal, canonical row returned', async () => {
    const store = new InMemoryJobStore();
    const appended: string[] = [];
    const origAppend = store.appendEvent.bind(store);
    store.appendEvent = async (ev) => {
      appended.push(ev.eventType);
      // Simulate the reaper winning the race: right after job_accepted is written (before the queued
      // transition), expire the accepted job out of band — exactly what the widened reapDeadlines can do.
      if (ev.eventType === 'job_accepted') {
        await store.transition(ev.runId, 'accepted', 'expired', {
          atMs: CLOCK, terminalAtMs: CLOCK, terminalCode: 'queue_deadline_exceeded',
        });
      }
      return origAppend(ev);
    };

    const deps = {
      store, clock: () => CLOCK, uid: () => randomUUID(),
      defaultQueueTimeoutMs: 3_600_000, defaultRunTimeoutMs: 3_600_000, enableOverlayEngine: false,
    } as unknown as SubmitDeps;

    const outcome = await submitRun(deps, runBody({ runId: 'race-1' }));

    expect((await store.get('race-1'))!.status).toBe('expired'); // the reaper won ⇒ job is terminal
    expect(appended).not.toContain('job_queued'); // submit must NOT enqueue after the terminal transition
    expect(outcome.handle.runId).toBe('race-1'); // canonical row returned (no crash, no stale enqueue)
  });
});
