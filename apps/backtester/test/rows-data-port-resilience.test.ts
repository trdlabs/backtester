import { describe, expect, it } from 'vitest';
import { RowsDataPort } from '../src/data/rows-data-port.js';

type Fetch = typeof globalThis.fetch;

const DATASET_REF = 'BTCUSDT:1m';
const RANGE = { tsFrom: 0, tsTo: 1_000, symbols: ['BTCUSDT'] };

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  } as unknown as Response;
}

function discovery(): Response {
  return response(200, {
    historicalContractVersion: 'historical.2',
    resources: [{ name: 'rows', availability: 'available' }],
    symbols: ['BTCUSDT'],
    timeframes: ['1m'],
  });
}

function row(ts: number) {
  return { schema_version: 2, symbol: 'BTCUSDT', minute_ts: ts };
}

function rowsFetch(handler: (call: number, init?: RequestInit) => Promise<Response>): Fetch {
  let call = 0;
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    if (path.includes('/historical/discover')) return discovery();
    if (path.includes('/historical/rows')) return handler(call++, init);
    return response(200, { entries: [], availability: 'available' });
  }) as Fetch;
}

async function collect(port: RowsDataPort) {
  const reader = await port.openDataset(DATASET_REF);
  if (!reader) throw new Error('expected reader');
  const rows = [];
  for await (const page of reader.queryRange(RANGE)) rows.push(...page);
  return rows;
}

describe('RowsDataPort HistoricalClient resilience forwarding', () => {
  it('retries a transient rows response within maxAttempts', async () => {
    let rowsCalls = 0;
    const port = new RowsDataPort({
      baseUrl: 'http://historical.test',
      fetchImpl: rowsFetch(async (call) => {
        rowsCalls += 1;
        return call === 0
          ? response(503, {})
          : response(200, { items: [row(1)], nextCursor: null });
      }),
      maxAttempts: 2,
      retryBaseMs: 1,
      retryMaxMs: 1,
    });

    await expect(collect(port)).resolves.toHaveLength(1);
    expect(rowsCalls).toBe(2);
  });

  it('aborts a hanging rows request at timeoutMs', async () => {
    const port = new RowsDataPort({
      baseUrl: 'http://historical.test',
      fetchImpl: rowsFetch(
        async (_call, init) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
              { once: true },
            );
          }),
      ),
      timeoutMs: 15,
      maxAttempts: 1,
    });

    await expect(collect(port)).rejects.toThrow(/timeout after 15ms/);
  });

  it('does not let a paginated operation outlive operationDeadlineMs', async () => {
    const port = new RowsDataPort({
      baseUrl: 'http://historical.test',
      fetchImpl: rowsFetch(
        async (call) =>
          await new Promise<Response>((resolve) => {
            setTimeout(() => resolve(response(200, { items: [row(call)], nextCursor: `c${call}` })), 10);
          }),
      ),
      timeoutMs: 100,
      maxAttempts: 1,
      maxPages: 100,
      operationDeadlineMs: 15,
    });

    await expect(collect(port)).rejects.toThrow(/operation deadline exceeded/);
  });

  it('fails closed after maxPages', async () => {
    const port = new RowsDataPort({
      baseUrl: 'http://historical.test',
      fetchImpl: rowsFetch(async (call) => response(200, { items: [row(call)], nextCursor: `p${call}` })),
      maxPages: 2,
      maxRows: 100,
    });

    await expect(collect(port)).rejects.toThrow(/exceeded maxPages 2/);
  });

  it('fails closed after maxRows', async () => {
    const port = new RowsDataPort({
      baseUrl: 'http://historical.test',
      fetchImpl: rowsFetch(async (call) => response(200, { items: [row(call * 2), row(call * 2 + 1)], nextCursor: `r${call}` })),
      maxPages: 100,
      maxRows: 3,
    });

    await expect(collect(port)).rejects.toThrow(/exceeded maxRows 3/);
  });
});
