// @trading-backtester/sdk BacktesterClient — additive per-request timeout + caller abort. Not a P2-12
// target (this is the lab-facing SDK), but the same timeout/cancellation hygiene. Closes review #140 §2
// (timeout must span the body read) and §4 (backoff / polling sleep must be abort-interruptible).
import { describe, expect, it } from 'vitest';
import { BacktesterClient } from '../../../packages/sdk/src/client/index';
import { BacktesterConflictError } from '../../../packages/sdk/src/client/errors';
import type { FetchLike, FetchLikeResponse } from '../../../packages/sdk/src/client/client';

const jsonRes = (status: number, body: unknown = {}): FetchLikeResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => '',
});

function client(fetchImpl: FetchLike, over: Record<string, unknown> = {}): BacktesterClient {
  return new BacktesterClient({
    baseUrl: 'http://bt.test',
    token: 't',
    fetchImpl,
    timeoutMs: 0,
    retry: { maxAttempts: 3, sleepImpl: async () => {} },
    ...over,
  } as never);
}

describe('BacktesterClient timeout/abort', () => {
  it('times out a hung request and drives retries instead of hanging', async () => {
    let calls = 0;
    const hang: FetchLike = (_url, init) => {
      calls += 1;
      return new Promise<FetchLikeResponse>((_resolve, reject) => {
        (init as { signal?: AbortSignal } | undefined)?.signal?.addEventListener(
          'abort',
          () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          { once: true },
        );
      });
    };
    const c = client(hang, { timeoutMs: 10 });
    await expect(c.discoverRegistry()).rejects.toThrow();
    expect(calls).toBe(3);
  }, 3_000);

  it('§2: times out a hung response BODY (not just headers)', async () => {
    let calls = 0;
    const bodyHang: FetchLike = (_url, init) => {
      calls += 1;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_resolve, reject) => {
            (init as { signal?: AbortSignal } | undefined)?.signal?.addEventListener(
              'abort',
              () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
              { once: true },
            );
          }),
        text: async () => '',
      } as FetchLikeResponse);
    };
    const c = client(bodyHang, { timeoutMs: 10 });
    await expect(c.discoverRegistry()).rejects.toThrow(); // hung body must time out, not hang
    expect(calls).toBe(3); // per-request timeout covered the body → each attempt aborted
  }, 3_000);

  it('§4: a caller abort interrupts the retry backoff (no long wait)', async () => {
    const ac = new AbortController();
    const always503: FetchLike = async () => jsonRes(503); // retryable → backoff between attempts
    // Real backoff (no sleepImpl), long base — only the caller abort should cut it short.
    const c = client(always503, { timeoutMs: 0, retry: { maxAttempts: 5, baseDelayMs: 10_000, maxDelayMs: 10_000 } });
    const p = c.getRunStatus('r1', { signal: ac.signal } as never);
    const t0 = Date.now();
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - t0).toBeLessThan(1_000); // aborted mid-backoff, not after a 10s sleep
  }, 3_000);

  it('aborts awaitCompletion on the caller signal, without further polling', async () => {
    const ac = new AbortController();
    let polls = 0;
    const running: FetchLike = async () => {
      polls += 1;
      return { ok: true, status: 200, json: async () => ({ status: 'running' }), text: async () => '' };
    };
    const c = client(running);
    const p = c.awaitCompletion('r1', { intervalMs: 5, timeoutMs: 10_000, sleep: async () => {}, signal: ac.signal } as never);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    const settled = polls;
    await new Promise((r) => setTimeout(r, 20));
    expect(polls).toBe(settled);
  }, 3_000);

  it('retries 408 and any 5xx for idempotent GETs, but never a non-408/429 4xx', async () => {
    let n408 = 0;
    await client((async () => (++n408 === 1 ? jsonRes(408) : jsonRes(200))) as FetchLike).discoverRegistry();
    expect(n408).toBe(2);

    let n500 = 0;
    await client((async () => (++n500 < 2 ? jsonRes(500) : jsonRes(200))) as FetchLike).discoverRegistry();
    expect(n500).toBe(2);

    let n409 = 0;
    await expect(
      client((async () => (n409++, jsonRes(409, { code: 'conflict' }))) as FetchLike).discoverRegistry(),
    ).rejects.toBeInstanceOf(BacktesterConflictError);
    expect(n409).toBe(1);
  }, 3_000);
});
