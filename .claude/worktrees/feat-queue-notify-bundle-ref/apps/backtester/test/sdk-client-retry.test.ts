// SDK retry policy: 429 always retried (numeric Retry-After honored); network errors retried only
// for GET or POST-with-resumeToken; other 4xx never retried. Mirrors sdk-client-registry.test.ts's
// FetchLike fake.
import { describe, expect, it } from 'vitest';
import { BacktesterClient } from '../../../packages/sdk/src/client/index';
import { BacktesterRateLimitError, BacktesterValidationError } from '../../../packages/sdk/src/client/errors';
import type { FetchLike, FetchLikeResponse } from '../../../packages/sdk/src/client/client';

const ok = (body: unknown): FetchLikeResponse =>
  ({ ok: true, status: 200, json: async () => body, text: async () => '' });
const err429 = (retryAfter?: string): FetchLikeResponse => ({
  ok: false,
  status: 429,
  json: async () => ({ category: 'rate_limit', code: 'queue_full', message: 'full' }),
  text: async () => '',
  headers: { get: (n: string) => (n.toLowerCase() === 'retry-after' ? retryAfter ?? null : null) },
});

function clientWith(responses: Array<FetchLikeResponse | Error>, sleeps: number[]): BacktesterClient {
  const fetchImpl: FetchLike = async () => {
    const next = responses.shift()!;
    if (next instanceof Error) throw next;
    return next;
  };
  return new BacktesterClient({
    baseUrl: 'http://bt.test',
    token: 't',
    fetchImpl,
    retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50, sleepImpl: async (ms) => { sleeps.push(ms); } },
  });
}

describe('SDK retry policy', () => {
  it('retries 429 and honors numeric Retry-After seconds', async () => {
    const sleeps: number[] = [];
    const client = clientWith([err429('2'), ok({ runId: 'r', jobId: 'r' })], sleeps);
    const handle = await client.submitRun({ resumeToken: undefined } as never); // any body: 429 is always safe
    expect((handle as { runId: string }).runId).toBe('r');
    expect(sleeps).toEqual([2000]); // numeric seconds → ms; NOT backoff
  });

  it('falls back to backoff when Retry-After is an HTTP-date (numeric-only anchor)', async () => {
    const sleeps: number[] = [];
    const client = clientWith([err429('Wed, 21 Oct 2026 07:28:00 GMT'), ok({ runId: 'r' })], sleeps);
    await client.submitRun({} as never);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(0);
    expect(sleeps[0]).toBeLessThanOrEqual(50); // capped by maxDelayMs
  });

  it('clamps an oversized numeric Retry-After to the 60s ceiling', async () => {
    const sleeps: number[] = [];
    const client = clientWith([err429('120'), ok({ runId: 'r' })], sleeps);
    await client.submitRun({} as never);
    expect(sleeps).toEqual([60_000]); // 120s advertised → clamped, not honored verbatim
  });

  it('exposes retryAfterS on the exhausted BacktesterRateLimitError', async () => {
    const sleeps: number[] = [];
    const client = clientWith([err429('5'), err429('5'), err429('7')], sleeps);
    await expect(client.submitRun({} as never)).rejects.toMatchObject({ retryAfterS: 7 });
  });

  it('exhausts maxAttempts on persistent 429 and throws BacktesterRateLimitError', async () => {
    const sleeps: number[] = [];
    const client = clientWith([err429(), err429(), err429()], sleeps);
    await expect(client.submitRun({} as never)).rejects.toBeInstanceOf(BacktesterRateLimitError);
    expect(sleeps).toHaveLength(2); // 3 attempts = 2 waits
  });

  it('retries GET on network error', async () => {
    const sleeps: number[] = [];
    const client = clientWith([new Error('ECONNRESET'), ok({ contractVersion: 'x' })], sleeps);
    await expect(client.getCapabilities()).resolves.toBeTruthy();
  });

  it('retries GET on 503 (idempotent 5xx branch) but not POST without resumeToken', async () => {
    const err503: FetchLikeResponse = {
      ok: false, status: 503, json: async () => ({ code: 'unavailable', message: 'down' }), text: async () => '',
    };
    const sleepsGet: number[] = [];
    const getClient = clientWith([{ ...err503 }, ok({ contractVersion: 'x' })], sleepsGet);
    await expect(getClient.getCapabilities()).resolves.toBeTruthy();
    expect(sleepsGet).toHaveLength(1);

    const sleepsPost: number[] = [];
    const postClient = clientWith([{ ...err503 }, ok({ runId: 'r' })], sleepsPost);
    await expect(postClient.submitRun({} as never)).rejects.toMatchObject({ status: 503 });
    expect(sleepsPost).toHaveLength(0);
  });

  it('does NOT retry POST network error without resumeToken (fails fast)', async () => {
    const sleeps: number[] = [];
    const client = clientWith([new Error('ECONNRESET'), ok({ runId: 'r' })], sleeps);
    await expect(client.submitRun({} as never)).rejects.toThrow('ECONNRESET');
    expect(sleeps).toHaveLength(0);
  });

  it('retries POST network error WITH resumeToken (idempotent replay)', async () => {
    const sleeps: number[] = [];
    const client = clientWith([new Error('ECONNRESET'), ok({ runId: 'r' })], sleeps);
    await expect(client.submitRun({ resumeToken: 'tok' } as never)).resolves.toBeTruthy();
    expect(sleeps).toHaveLength(1);
  });

  it('never retries other 4xx', async () => {
    const sleeps: number[] = [];
    const bad: FetchLikeResponse = { ok: false, status: 400, json: async () => ({ code: 'validation_error', message: 'no' }), text: async () => '' };
    const client = clientWith([bad, ok({})], sleeps);
    await expect(client.submitRun({ resumeToken: 'tok' } as never)).rejects.toBeInstanceOf(BacktesterValidationError);
    expect(sleeps).toHaveLength(0);
  });

  it('maxAttempts: 1 disables retries', async () => {
    const sleeps: number[] = [];
    const fetchImpl: FetchLike = async () => err429('1');
    const client = new BacktesterClient({ baseUrl: 'http://x', token: 't', fetchImpl, retry: { maxAttempts: 1, sleepImpl: async (ms) => { sleeps.push(ms); } } });
    await expect(client.getCapabilities()).rejects.toBeInstanceOf(BacktesterRateLimitError);
    expect(sleeps).toHaveLength(0);
  });
});
