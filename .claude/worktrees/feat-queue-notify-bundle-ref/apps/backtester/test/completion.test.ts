import { describe, expect, it } from 'vitest';
import type { CompletionEvent } from '@trading/research-contracts';
import { AUTH, makeApp, runBody } from './helpers';
import { STORE_FACTORIES } from './store-factories';

for (const factory of STORE_FACTORIES) {
  describe.skipIf(!factory.available)(`completion webhook + outbox [${factory.name}]`, () => {
    it('POSTs a completion event to the callback on success', async () => {
      const calls: CompletionEvent[] = [];
      const postWebhook = async (_url: string, ev: CompletionEvent): Promise<void> => {
        calls.push(ev);
      };
      const { app, cleanup } = await makeApp(factory, { postWebhook });
      try {
        await app.server.inject({
          method: 'POST',
          url: '/v1/runs',
          headers: AUTH,
          payload: runBody({ runId: 'w-1', callbackUrl: 'http://hook.test/cb' }),
        });
        await app.drain();

        expect(calls.length).toBe(1);
        expect(calls[0]!.runId).toBe('w-1');
        expect(calls[0]!.eventType).toBe('job_completed');
        expect(calls[0]!.status).toBe('completed');
        expect(calls[0]!.summary.resultHash).toMatch(/^sha256:/);
      } finally {
        await cleanup();
      }
    });

    it('retries a failed webhook via the outbox', async () => {
      const calls: CompletionEvent[] = [];
      let mode: 'fail' | 'ok' = 'fail';
      const postWebhook = async (_url: string, ev: CompletionEvent): Promise<void> => {
        if (mode === 'fail') throw new Error('boom');
        calls.push(ev);
      };
      const { app, store, cleanup } = await makeApp(factory, { postWebhook });
      try {
        await app.server.inject({
          method: 'POST',
          url: '/v1/runs',
          headers: AUTH,
          payload: runBody({ runId: 'w-2', callbackUrl: 'http://hook.test/cb' }),
        });
        await app.drain(); // completes; webhook throws → event marked failed in the outbox
        expect(calls.length).toBe(0);
        expect((await store.listDeliverable(10)).length).toBe(1);

        mode = 'ok';
        await app.deliverOutbox();
        expect(calls.length).toBe(1);
        expect((await store.listDeliverable(10)).length).toBe(0);
      } finally {
        await cleanup();
      }
    });

    it('no callback url → nothing queued for delivery', async () => {
      const { app, store, cleanup } = await makeApp(factory);
      try {
        await app.server.inject({
          method: 'POST',
          url: '/v1/runs',
          headers: AUTH,
          payload: runBody({ runId: 'w-3' }),
        });
        await app.drain();
        expect((await store.listDeliverable(10)).length).toBe(0);
      } finally {
        await cleanup();
      }
    });
  });
}
