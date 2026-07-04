import { describe, expect, it } from 'vitest';
import { BacktesterClient } from '../src/client/client';
import type { ContentHash } from '../src/contracts/index';

/** Builds a fetchImpl compatible with BacktesterClientOptions.fetchImpl (FetchLike). */
function mockFetch(handlers: Record<string, (init: RequestInit) => Response>) {
  return async (url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${new URL(url).pathname}`;
    const h = handlers[key];
    if (!h) return new Response('not found', { status: 404 });
    return h(init);
  };
}

describe('SDK bundle-ref', () => {
  it('putBundle POSTs and returns the hash', async () => {
    const fetchImpl = mockFetch({
      'POST /v1/bundles': () =>
        new Response(JSON.stringify({ hash: 'sha256:' + 'a'.repeat(64) }), { status: 200 }),
    });
    const c = new BacktesterClient({ baseUrl: 'http://x', token: 't', fetchImpl: fetchImpl as never });
    expect(await c.putBundle({} as never)).toBe('sha256:' + 'a'.repeat(64));
  });

  it('hasBundle returns true on 200', async () => {
    const H = ('sha256:' + 'd'.repeat(64)) as ContentHash;
    const fetchImpl = mockFetch({
      [`HEAD /v1/bundles/${H}`]: () => new Response(null, { status: 200 }),
    });
    const c = new BacktesterClient({ baseUrl: 'http://x', token: 't', fetchImpl: fetchImpl as never });
    expect(await c.hasBundle(H)).toBe(true);
  });

  it('hasBundle returns false on 404', async () => {
    const H = ('sha256:' + 'e'.repeat(64)) as ContentHash;
    const fetchImpl = mockFetch({
      [`HEAD /v1/bundles/${H}`]: () =>
        new Response(JSON.stringify({ code: 'not_found', message: 'x' }), { status: 404 }),
    });
    const c = new BacktesterClient({ baseUrl: 'http://x', token: 't', fetchImpl: fetchImpl as never });
    expect(await c.hasBundle(H)).toBe(false);
  });

  it('hasBundle rethrows on other errors (e.g. 500)', async () => {
    const H = ('sha256:' + 'f'.repeat(64)) as ContentHash;
    const fetchImpl = mockFetch({
      [`HEAD /v1/bundles/${H}`]: () =>
        new Response(JSON.stringify({ code: 'error', message: 'boom' }), { status: 500 }),
    });
    const c = new BacktesterClient({ baseUrl: 'http://x', token: 't', fetchImpl: fetchImpl as never });
    await expect(c.hasBundle(H)).rejects.toBeTruthy();
  });

  it('submitRun with moduleBundle self-heals ONE 409 unknown_bundle via re-PUT + retry with the same resumeToken', async () => {
    let submitCalls = 0;
    let putCalls = 0;
    const tokens: unknown[] = [];
    const H = 'sha256:' + 'b'.repeat(64);
    const fetchImpl = mockFetch({
      'POST /v1/bundles': () => {
        putCalls++;
        return new Response(JSON.stringify({ hash: H }), { status: 200 });
      },
      'POST /v1/runs': (init) => {
        submitCalls++;
        tokens.push(JSON.parse(String(init.body)).resumeToken);
        return submitCalls === 1
          ? new Response(
              JSON.stringify({ category: 'validation_error', code: 'unknown_bundle', message: 'x' }),
              { status: 409 },
            )
          : new Response(JSON.stringify({ runId: 'r', status: 'accepted' }), { status: 202 });
      },
    });
    const c = new BacktesterClient({ baseUrl: 'http://x', token: 't', fetchImpl: fetchImpl as never });
    await c.submitRun({ resumeToken: 'tok', bundleRef: H, moduleBundle: {} as never } as never);
    expect(putCalls).toBe(1);
    expect(submitCalls).toBe(2);
    expect(tokens).toEqual(['tok', 'tok']); // same resumeToken on retry
  });

  it('submitRun with ONLY bundleRef surfaces 409 (no bytes to re-PUT)', async () => {
    const fetchImpl = mockFetch({
      'POST /v1/runs': () =>
        new Response(JSON.stringify({ code: 'unknown_bundle', message: 'x' }), { status: 409 }),
    });
    const c = new BacktesterClient({ baseUrl: 'http://x', token: 't', fetchImpl: fetchImpl as never });
    await expect(
      c.submitRun({ resumeToken: 'tok', bundleRef: 'sha256:' + 'c'.repeat(64) } as never),
    ).rejects.toBeTruthy();
  });
});
