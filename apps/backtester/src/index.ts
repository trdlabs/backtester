// Service entrypoint: load config, wire the app, start the worker, listen.

import { buildApp } from './app';
import { loadConfig } from './config';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = buildApp(config);
  app.startWorker();

  const addr = await app.server.listen({ host: config.host, port: config.port });
  // eslint-disable-next-line no-console
  console.log(`trading-backtester listening on ${addr}`);

  const shutdown = async (): Promise<void> => {
    app.stopWorker();
    await app.server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
