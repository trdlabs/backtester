/**
 * Verifies the behaviour of GET /result and GET /artifacts for every non-completed terminal
 * state: expired (queue_deadline_exceeded), timed_out (run_deadline_exceeded), failed
 * (missing_dataset), and canceled.  Also covers the 409 "run not complete" response for a
 * job that is still queued (not yet a terminal state).
 *
 * This closes the "non-completed terminal runs" and "artifact access verification"
 * items from Feature 5 in the roadmap.
 */
import { describe, expect, it } from 'vitest';
import { AUTH, makeApp, runBody } from './helpers';
import { STORE_FACTORIES } from './store-factories';

/** Fixed millisecond timestamp matching the `testDeps` clock in helpers.ts. */
const NOW = 1_700_000_000_000;

for (const factory of STORE_FACTORIES) {
  describe.skipIf(!factory.available)(
    `terminal run result/artifacts [${factory.name}]`,
    () => {
      // -----------------------------------------------------------------------
      // GET /result — expired (queue_deadline_exceeded)
      // -----------------------------------------------------------------------
      it('GET /result returns 409 with terminalCode for expired run', async () => {
        const { app, cleanup } = await makeApp(factory);
        try {
          await app.server.inject({
            method: 'POST',
            url: '/v1/runs',
            headers: AUTH,
            payload: runBody({ runId: 'exp-r', queueTimeoutMs: -1_000 }),
          });
          await app.reap();

          const res = await app.server.inject({ url: '/v1/runs/exp-r/result', headers: AUTH });
          expect(res.statusCode).toBe(409);
          const body = res.json<{ status: string; terminalCode: string; message: string }>();
          expect(body.status).toBe('expired');
          expect(body.terminalCode).toBe('queue_deadline_exceeded');
          expect(body.message).toBe('run produced no result summary');
        } finally {
          await cleanup();
        }
      });

      // -----------------------------------------------------------------------
      // GET /artifacts — expired run has no manifest yet → 404 manifest_not_found
      // -----------------------------------------------------------------------
      it('GET /artifacts returns 404 for expired run (no artifact manifest)', async () => {
        const { app, cleanup } = await makeApp(factory);
        try {
          await app.server.inject({
            method: 'POST',
            url: '/v1/runs',
            headers: AUTH,
            payload: runBody({ runId: 'exp-a', queueTimeoutMs: -1_000 }),
          });
          await app.reap();

          const res = await app.server.inject({ url: '/v1/runs/exp-a/artifacts', headers: AUTH });
          expect(res.statusCode).toBe(404);
          expect(res.json<{ code: string }>().code).toBe('manifest_not_found');
        } finally {
          await cleanup();
        }
      });

      // -----------------------------------------------------------------------
      // GET /result — timed_out (run_deadline_exceeded)
      // -----------------------------------------------------------------------
      it('GET /result returns 409 with terminalCode for timed_out run', async () => {
        const { app, store, cleanup } = await makeApp(factory);
        try {
          await app.server.inject({
            method: 'POST',
            url: '/v1/runs',
            headers: AUTH,
            payload: runBody({ runId: 'to-r', runTimeoutMs: -1_000 }),
          });
          // Transition queued → running; runDeadlineMs = NOW - 1000 (already past)
          await store.claimNextQueued(NOW);
          await app.reap();

          const res = await app.server.inject({ url: '/v1/runs/to-r/result', headers: AUTH });
          expect(res.statusCode).toBe(409);
          const body = res.json<{ status: string; terminalCode: string; message: string }>();
          expect(body.status).toBe('timed_out');
          expect(body.terminalCode).toBe('run_deadline_exceeded');
          expect(body.message).toBe('run produced no result summary');
        } finally {
          await cleanup();
        }
      });

      // -----------------------------------------------------------------------
      // GET /result — failed (missing_dataset)
      // -----------------------------------------------------------------------
      it('GET /result returns 409 with terminalCode for failed run (missing_dataset)', async () => {
        const { app, cleanup } = await makeApp(factory);
        try {
          await app.server.inject({
            method: 'POST',
            url: '/v1/runs',
            headers: AUTH,
            payload: runBody({ runId: 'fail-r', datasetRef: '__no_such_dataset__' }),
          });
          await app.drain();

          const res = await app.server.inject({ url: '/v1/runs/fail-r/result', headers: AUTH });
          expect(res.statusCode).toBe(409);
          const body = res.json<{ status: string; terminalCode: string; message: string }>();
          expect(body.status).toBe('failed');
          expect(body.terminalCode).toBe('missing_dataset');
          expect(body.message).toBe('run produced no result summary');
        } finally {
          await cleanup();
        }
      });

      // -----------------------------------------------------------------------
      // GET /result — canceled
      // -----------------------------------------------------------------------
      it('GET /result returns 409 with terminalCode for canceled run', async () => {
        const { app, cleanup } = await makeApp(factory);
        try {
          await app.server.inject({
            method: 'POST',
            url: '/v1/runs',
            headers: AUTH,
            payload: runBody({ runId: 'can-r' }),
          });
          await app.server.inject({
            method: 'POST',
            url: '/v1/runs/can-r/cancel',
            headers: AUTH,
          });

          const res = await app.server.inject({ url: '/v1/runs/can-r/result', headers: AUTH });
          expect(res.statusCode).toBe(409);
          const body = res.json<{ status: string; terminalCode: string; message: string }>();
          expect(body.status).toBe('canceled');
          expect(body.terminalCode).toBe('canceled');
          expect(body.message).toBe('run produced no result summary');
        } finally {
          await cleanup();
        }
      });

      // -----------------------------------------------------------------------
      // GET /result — still queued (not yet a terminal state)
      // -----------------------------------------------------------------------
      it('GET /result returns 409 "run not complete" for a still-queued run', async () => {
        const { app, cleanup } = await makeApp(factory);
        try {
          await app.server.inject({
            method: 'POST',
            url: '/v1/runs',
            headers: AUTH,
            payload: runBody({ runId: 'pend-r' }),
          });
          // Do NOT drain — job stays in queued state

          const res = await app.server.inject({ url: '/v1/runs/pend-r/result', headers: AUTH });
          expect(res.statusCode).toBe(409);
          const body = res.json<{ status: string; message: string }>();
          expect(body.status).toBe('queued');
          expect(body.message).toBe('run not complete');
          expect((body as Record<string, unknown>).terminalCode).toBeUndefined();
        } finally {
          await cleanup();
        }
      });

      // -----------------------------------------------------------------------
      // GET /result — waiting_for_compute (internal-only) must project to 'running' (INV-7)
      // -----------------------------------------------------------------------
      it('GET /result projects internal waiting_for_compute status to running (INV-7)', async () => {
        const { app, store, cleanup } = await makeApp(factory);
        try {
          await app.server.inject({
            method: 'POST',
            url: '/v1/runs',
            headers: AUTH,
            payload: runBody({ runId: 'wfc-r' }),
          });
          await store.claimNextQueued(NOW);
          const ok = await store.transition('wfc-r', 'running', 'waiting_for_compute', { atMs: NOW });
          expect(ok).toBe(true);

          const res = await app.server.inject({ url: '/v1/runs/wfc-r/result', headers: AUTH });
          expect(res.statusCode).toBe(409);
          const body = res.json<{ status: string; message: string }>();
          // Must NOT leak the internal 'waiting_for_compute' status onto the public HTTP body.
          expect(body.status).toBe('running');
          expect(body.message).toBe('run not complete');
        } finally {
          await cleanup();
        }
      });

      // -----------------------------------------------------------------------
      // GET /result — unknown run → 404
      // -----------------------------------------------------------------------
      it('GET /result returns 404 for unknown run', async () => {
        const { app, cleanup } = await makeApp(factory);
        try {
          const res = await app.server.inject({ url: '/v1/runs/no-such-run/result', headers: AUTH });
          expect(res.statusCode).toBe(404);
          expect(res.json<{ code: string }>().code).toBe('run_not_found');
        } finally {
          await cleanup();
        }
      });
    },
  );
}
