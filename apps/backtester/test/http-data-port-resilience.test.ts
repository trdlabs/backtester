// P2-12 slice 1 — HttpDataPort resilience: per-request timeout, bounded retry, cursor-cycle detection,
// max pages/rows fail-closed, mapped to the RealDataUnavailableError taxonomy so the worker terminalizes
// (missing_dataset) instead of hanging. See docs/specs/P2-12-data-fetch-resilience.md.
import { describe, expect, it } from 'vitest';
import { HttpDataPort } from '../src/data/http-data-port.js';
import { RealDataUnavailableError } from '../src/data/rows-data-port.js';
import { loadConfig } from '../src/config.js';

type Fetch = typeof globalThis.fetch;

function res(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  } as unknown as Response;
}

// Routes /rows to a scripted handler; every other URL (dataset existence probe) is a bare 200.
function routed(rows: (call: number, init?: RequestInit) => Promise<Response>): Fetch {
  let n = 0;
  return (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes('/rows')) return rows(n++, init);
    return res(200, { datasets: [] });
  }) as Fetch;
}

const noSleep = async (): Promise<void> => {};
const RANGE = { tsFrom: 0, tsTo: 1_000 } as never;

function port(fetchImpl: Fetch, over: Record<string, unknown> = {}): HttpDataPort {
  return new HttpDataPort({
    baseUrl: 'http://data.test',
    fetchImpl,
    sleepImpl: noSleep,
    timeoutMs: 15,
    maxAttempts: 3,
    maxPages: 5,
    maxRows: 10,
    ...over,
  } as never);
}

async function drain(port: HttpDataPort): Promise<{ rows: number; pages: number }> {
  const reader = await port.openDataset('ds-1');
  if (!reader) throw new Error('no reader');
  let rows = 0;
  let pages = 0;
  for await (const batch of reader.queryRange(RANGE)) {
    rows += batch.length;
    pages += 1;
  }
  return { rows, pages };
}

const rowsPage = (n: number, nextCursor?: string) => ({
  rows: Array.from({ length: n }, (_, i) => ({ symbol: 'BTCUSDT', minute_ts: i })),
  ...(nextCursor ? { nextCursor } : {}),
});

describe('P2-12 HttpDataPort resilience', () => {
  it('1) turns a hanging fetch into a typed timeout instead of blocking forever', async () => {
    // Fetch never settles until its AbortSignal fires — the per-request timeout must abort it.
    const hang: Fetch = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      })) as Fetch;
    await expect(drain(port(hang))).rejects.toMatchObject({
      name: 'RealDataUnavailableError',
      reason: 'timeout',
    });
  });

  it('2) recovers after transient failures within the attempt budget', async () => {
    const p = port(
      routed(async (call) => {
        if (call === 0) return res(503, {});
        if (call === 1) throw Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });
        return res(200, rowsPage(2)); // 3rd attempt (same page) succeeds, no nextCursor
      }),
    );
    const out = await drain(p);
    expect(out.rows).toBe(2);
    expect(out.pages).toBe(1);
  });

  it('3) exhausts retries on a permanent 5xx and maps to rows_resource_unavailable', async () => {
    await expect(drain(port(routed(async () => res(500, {}))))).rejects.toMatchObject({
      name: 'RealDataUnavailableError',
      reason: 'rows_resource_unavailable',
    });
  });

  it('4) does not retry a 4xx (except 408/429) and raises immediately', async () => {
    let calls = 0;
    const p = port(
      routed(async () => {
        calls += 1;
        return res(400, { code: 'bad_request' });
      }),
    );
    await expect(drain(p)).rejects.toBeInstanceOf(RealDataUnavailableError);
    expect(calls).toBe(1); // exactly one attempt — no retry
  });

  it('5) bounds the whole operation by the operation deadline', async () => {
    // Every page succeeds and always advertises a fresh cursor — only the deadline can stop it.
    const p = port(
      routed(async (call) => res(200, rowsPage(1, `c${call + 1}`))),
      { operationDeadlineMs: 20, maxPages: 1_000_000, maxRows: 1_000_000 },
    );
    await expect(drain(p)).rejects.toMatchObject({ name: 'RealDataUnavailableError' });
  });

  it('6) detects a repeated nextCursor as a pagination cycle', async () => {
    const p = port(routed(async () => res(200, rowsPage(1, 'STUCK')))); // same cursor forever
    await expect(drain(p)).rejects.toMatchObject({
      name: 'RealDataUnavailableError',
      reason: 'pagination_cycle',
    });
  });

  it('7) fails closed when pages exceed maxPages', async () => {
    // Distinct cursors each page (no cycle) but never terminates → maxPages guard must fire.
    const p = port(routed(async (call) => res(200, rowsPage(1, `p${call + 1}`))), { maxPages: 3 });
    await expect(drain(p)).rejects.toMatchObject({
      name: 'RealDataUnavailableError',
      reason: 'pagination_overflow',
    });
  });

  it('8) fails closed when total rows exceed maxRows (before materializing)', async () => {
    const p = port(routed(async (call) => res(200, rowsPage(4, `r${call + 1}`))), { maxRows: 6, maxPages: 1_000 });
    await expect(drain(p)).rejects.toMatchObject({
      name: 'RealDataUnavailableError',
      reason: 'pagination_overflow',
    });
  });
});

describe('P2-12 config fail-fast', () => {
  it('9a) rejects a non-positive per-request timeout', () => {
    expect(() => loadConfig({ BACKTESTER_DATA_API_TIMEOUT_MS: '0' } as NodeJS.ProcessEnv)).toThrow(/DATA_API_TIMEOUT_MS/);
  });
  it('9b) rejects a NaN max-rows', () => {
    expect(() => loadConfig({ BACKTESTER_DATA_API_MAX_ROWS: 'abc' } as NodeJS.ProcessEnv)).toThrow(/DATA_API_MAX_ROWS/);
  });
  it('9c) rejects retryMax < retryBase', () => {
    expect(() =>
      loadConfig({
        BACKTESTER_DATA_API_RETRY_BASE_MS: '5000',
        BACKTESTER_DATA_API_RETRY_MAX_MS: '1000',
      } as NodeJS.ProcessEnv),
    ).toThrow(/RETRY_MAX_MS/);
  });
  it('9d) accepts valid overrides', () => {
    const c = loadConfig({ BACKTESTER_DATA_API_TIMEOUT_MS: '5000', BACKTESTER_DATA_API_MAX_ATTEMPTS: '5' } as NodeJS.ProcessEnv);
    expect(c.dataApiTimeoutMs).toBe(5000);
    expect(c.dataApiMaxAttempts).toBe(5);
  });
});
