import { Pool, type PoolConfig } from 'pg';

/**
 * Create a pg Pool. When `schema` is given, every connection starts with that search_path (via the
 * libpq `options` startup param) — used by tests to isolate each run in a throwaway schema.
 */
export function createPool(connectionString: string, schema?: string): Pool {
  const config: PoolConfig = { connectionString };
  if (schema) config.options = `-c search_path=${schema}`;
  return new Pool(config);
}
