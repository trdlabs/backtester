// Service entrypoint: load config, wire the app, start the worker, listen.

import { buildApp } from './app';
import { loadConfig } from './config';
import { loadEnv } from './env';

async function main(): Promise<void> {
  // Fail-fast (env-schema.1): валидирует env и печатает ВСЕ нарушения разом; accept-set идентичен
  // loadConfig (пины в test/env-schema.test.ts), поэтому поведение старта не меняется.
  loadEnv();
  const config = loadConfig();
  const app = await buildApp(config);
  if (config.autoWorker) app.startWorker();

  const addr = await app.server.listen({ host: config.host, port: config.port });
  // eslint-disable-next-line no-console
  console.log(`trading-backtester listening on ${addr}`);

  const shutdown = async (): Promise<void> => {
    await app.dispose();
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
