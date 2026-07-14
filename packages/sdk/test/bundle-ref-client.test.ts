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

  it('submitRun with bundleRef-only self-heals ONE 409 unknown_bundle from the putBundle cache (re-PUT + retry, same resumeToken)', async () => {
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
    // Populate the cache the same way the real bundle-by-ref flow does: putBundle first.
    const hash = await c.putBundle({} as never);
    expect(hash).toBe(H);
    // Real by-ref submit carries ONLY bundleRef — the server 400s if moduleBundle is also present.
    await c.submitRun({ resumeToken: 'tok', bundleRef: H } as never);
    expect(putCalls).toBe(2); // 1 cache-populating put + 1 self-heal re-PUT
    expect(submitCalls).toBe(2);
    expect(tokens).toEqual(['tok', 'tok']); // same resumeToken on retry
  });

  it('submitRun with a bundleRef that was never putBundle-d (not cached) surfaces the 409 (no bytes to re-PUT)', async () => {
    let putCalls = 0;
    const fetchImpl = mockFetch({
      'POST /v1/bundles': () => {
        putCalls++;
        return new Response(JSON.stringify({ hash: 'sha256:' + 'z'.repeat(64) }), { status: 200 });
      },
      'POST /v1/runs': () =>
        new Response(JSON.stringify({ code: 'unknown_bundle', message: 'x' }), { status: 409 }),
    });
    const c = new BacktesterClient({ baseUrl: 'http://x', token: 't', fetchImpl: fetchImpl as never });
    const H2 = ('sha256:' + 'c'.repeat(64)) as ContentHash; // never putBundle'd — not in cache
    await expect(c.submitRun({ resumeToken: 'tok', bundleRef: H2 } as never)).rejects.toBeTruthy();
    expect(putCalls).toBe(0); // no cache hit ⇒ no re-PUT attempted
  });

  it('bundle cache is a bounded LRU — an evicted bundle surfaces the 409, a recently-put one still self-heals', async () => {
    // Distinct server hash per bundle (derived from the posted body's `id`); run 409s on the FIRST
    // attempt per ref then 202, so the client only succeeds when it still has the bytes cached.
    const hashOf = (id: string): string => 'sha256:' + id.repeat(64).slice(0, 64);
    let putCalls = 0;
    const runAttempts = new Map<string, number>();
    const fetchImpl = mockFetch({
      'POST /v1/bundles': (init) => {
        putCalls++;
        const id = String(JSON.parse(String(init.body)).id);
        return new Response(JSON.stringify({ hash: hashOf(id) }), { status: 200 });
      },
      'POST /v1/runs': (init) => {
        const ref = String(JSON.parse(String(init.body)).bundleRef);
        const n = (runAttempts.get(ref) ?? 0) + 1;
        runAttempts.set(ref, n);
        return n === 1
          ? new Response(JSON.stringify({ code: 'unknown_bundle', message: 'x' }), { status: 409 })
          : new Response(JSON.stringify({ runId: 'r', status: 'accepted' }), { status: 202 });
      },
    });
    // capacity 1 → putting B evicts A.
    const c = new BacktesterClient({ baseUrl: 'http://x', token: 't', fetchImpl: fetchImpl as never, bundleCacheCapacity: 1 });
    const hA = await c.putBundle({ id: 'a' } as never); // cached
    const hB = await c.putBundle({ id: 'b' } as never); // evicts A; B is now the only cached bundle
    expect(putCalls).toBe(2);

    // B is still cached → its 409 self-heals (re-PUT + retry).
    await c.submitRun({ resumeToken: 't1', bundleRef: hB } as never);
    expect(putCalls).toBe(3); // one self-heal re-PUT for B

    // A was evicted → no bytes to re-PUT → the 409 surfaces, and NO extra put happens.
    await expect(c.submitRun({ resumeToken: 't2', bundleRef: hA } as never)).rejects.toBeTruthy();
    expect(putCalls).toBe(3); // unchanged — A was not re-PUT
  });
});
