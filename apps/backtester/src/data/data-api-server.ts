// Reference implementation of the networked Research Historical Data API (Slice 4).
//
// This is the wire contract that the REAL trading-platform and trading-mock-platform implement (mock
// serving sanitized recorded datasets). It is provided here as a reference/dev server so the HTTP
// `platformDataClient` can be exercised end-to-end and parity-tested; it is NOT the backtester's own
// surface. It wraps any BacktesterDataPort (e.g. the fixture reader or a parquet-backed reader) and
// streams rows by range/symbol with cursor paging — neither side holds a whole dataset in memory.

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { HistoricalRowsPage, ReaderRow } from '@trading/research-contracts';
import type { BacktesterDataPort } from './reader';
import { bearerTokenMatches } from '../api/bearer-auth.js';

export interface DataApiServerOptions {
  /** Optional bearer token for the data API itself (NOT exchange credentials). */
  readonly authToken?: string;
  /** Hard cap on rows per page regardless of the client's `limit`. */
  readonly maxPageLimit?: number;
}

function parseSymbols(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const list = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  return list.length > 0 ? list : undefined;
}

export function createDataApiServer(
  dataPort: BacktesterDataPort,
  options: DataApiServerOptions = {},
): FastifyInstance {
  const app = Fastify({ logger: false });
  const maxPageLimit = options.maxPageLimit ?? 10_000;

  if (options.authToken) {
    const authToken = options.authToken; // narrow once; the closure below captures it as `string`
    app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
      if (!req.url.startsWith('/data/')) return;
      if (!bearerTokenMatches(req.headers.authorization, authToken)) {
        return reply.code(401).send({ code: 'unauthorized', message: 'missing or invalid bearer token' });
      }
    });
  }

  app.get('/data/v1/datasets', async () => ({ datasets: await dataPort.listDatasets() }));

  app.get('/data/v1/datasets/:datasetRef', async (req, reply) => {
    const { datasetRef } = req.params as { datasetRef: string };
    const found = (await dataPort.listDatasets()).find((d) => d.datasetRef === datasetRef);
    if (!found) return reply.code(404).send({ code: 'dataset_not_found', message: datasetRef });
    return found;
  });

  app.get('/data/v1/rows', async (req, reply): Promise<HistoricalRowsPage | FastifyReply> => {
    const q = req.query as Record<string, string | undefined>;
    if (!q.datasetRef) {
      return reply.code(400).send({ code: 'bad_request', message: 'datasetRef is required' });
    }
    const reader = await dataPort.openDataset(q.datasetRef);
    if (!reader) return reply.code(404).send({ code: 'dataset_not_found', message: q.datasetRef });

    const tsFrom = Number(q.tsFrom ?? 0);
    const tsTo = Number(q.tsTo ?? Number.MAX_SAFE_INTEGER);
    const symbols = parseSymbols(q.symbols);
    const offset = Math.max(0, Number(q.cursor ?? 0) || 0);
    const limit = Math.min(maxPageLimit, Math.max(1, Number(q.limit ?? 1000) || 1000));

    // Offset cursor over the underlying stream — correct and stable for the reference impl; a real
    // platform implements an efficient position cursor straight off its storage.
    const rows: ReaderRow[] = [];
    let idx = 0;
    let hasMore = false;
    for await (const batch of reader.queryRange({ tsFrom, tsTo, ...(symbols ? { symbols } : {}) })) {
      for (const row of batch) {
        if (idx >= offset + limit) {
          hasMore = true;
          break;
        }
        if (idx >= offset) rows.push(row);
        idx += 1;
      }
      if (hasMore) break;
    }

    return { rows, ...(hasMore ? { nextCursor: String(offset + limit) } : {}) };
  });

  return app;
}
