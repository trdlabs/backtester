// Standalone reference Research Historical Data API server (dev / parity tool).
//
// The REAL trading-platform and trading-mock-platform own their own implementations of this contract;
// this runner just serves the local fixture datasets over the same wire so the HTTP platformDataClient
// can be developed and parity-tested without those services. Point the backtester at it with
// BACKTESTER_DATA_SOURCE=http BACKTESTER_DATA_API_URL=http://127.0.0.1:8081.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDataApiServer } from './data/data-api-server';
import { FixtureDataPort } from './data/reader';
import { readEnvVar } from './env';

const HERE = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const fixturesDir = readEnvVar('DATA_API_FIXTURES_DIR') ?? resolve(HERE, '../fixtures/candles');
  const host = readEnvVar('DATA_API_HOST') ?? '127.0.0.1';
  const port = Number(readEnvVar('DATA_API_PORT') ?? 8081);
  const token = readEnvVar('DATA_API_TOKEN');

  const server = createDataApiServer(
    new FixtureDataPort(fixturesDir),
    token ? { authToken: token } : {},
  );
  const addr = await server.listen({ host, port });
  // eslint-disable-next-line no-console
  console.log(`reference Research Historical Data API listening on ${addr}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
