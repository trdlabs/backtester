import { Pool, type PoolConfig } from 'pg';

/**
 * Create a pg Pool. When `schema` is given, every connection starts with that search_path (via the
 * libpq `options` startup param) — used by tests to isolate each run in a throwaway schema.
 * opts.max caps pool connections (pg default 10); opts.statementTimeoutMs sets a per-connection
 * statement_timeout (0/omitted = off). Migration call sites intentionally pass NO opts — DDL must
 * never inherit the app-path timeout.
 */
export function createPool(
  connectionString: string,
  schema?: string,
  opts?: { max?: number; statementTimeoutMs?: number },
): Pool {
  const config: PoolConfig = { connectionString };
  const startup: string[] = [];
  if (schema) startup.push(`-c search_path=${schema}`);
  if (opts?.statementTimeoutMs && opts.statementTimeoutMs > 0) {
    startup.push(`-c statement_timeout=${opts.statementTimeoutMs}`);
  }
  if (startup.length > 0) config.options = startup.join(' ');
  if (opts?.max !== undefined) config.max = Math.max(1, opts.max);
  const pool = new Pool(config);
  // P1-1: node-pg emits 'error' on idle clients (Pg restart / network reset / failover). An unhandled
  // 'error' on the pool EventEmitter is an uncaught exception that crashes the whole worker/API process
  // on any transient blip. Swallow-and-log so pg's own reconnect + the job leases recover instead.
  pool.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error(`[pool] idle client error: ${err instanceof Error ? err.message : String(err)}`);
  });
  return pool;
}
