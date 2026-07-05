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
  return new Pool(config);
}
