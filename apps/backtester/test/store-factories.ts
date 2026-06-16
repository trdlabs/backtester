// Parametrize the behavioral suite over store implementations. Postgres is probed once; when no DB is
// reachable (no BACKTESTER_TEST_DATABASE_URL / DATABASE_URL, or connection refused) the pg variant is
// reported unavailable and its describe blocks skip — they do not fail.

import { Pool } from 'pg';
import { createPool } from '../src/db/pool';
import { DEFAULT_MIGRATIONS_DIR, migrate } from '../src/db/migrate';
import { InMemoryJobStore, type JobStore } from '../src/jobs/job-store';
import { PgJobStore } from '../src/jobs/pg-job-store';

const PG_URL = process.env.BACKTESTER_TEST_DATABASE_URL ?? process.env.DATABASE_URL;

async function probePg(): Promise<boolean> {
  if (!PG_URL) return false;
  const pool = new Pool({ connectionString: PG_URL, connectionTimeoutMillis: 2000 });
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
}

export const PG_AVAILABLE = await probePg();

export interface StoreHandle {
  store: JobStore;
  teardown: () => Promise<void>;
}

export interface StoreFactory {
  name: string;
  available: boolean;
  create: () => Promise<StoreHandle>;
}

let schemaSeq = 0;
function newSchema(): string {
  return `bt_test_${process.pid}_${Date.now().toString(36)}_${schemaSeq++}`;
}

async function createSchema(): Promise<string> {
  const schema = newSchema();
  const admin = new Pool({ connectionString: PG_URL });
  await admin.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await admin.end();
  return schema;
}

async function dropSchema(schema: string): Promise<void> {
  const admin = new Pool({ connectionString: PG_URL });
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
}

/** A schema with N independently-pooled stores over the SAME data — for restart/durability tests. */
export async function createPgSchema(): Promise<{
  makeStore: () => JobStore;
  teardown: () => Promise<void>;
}> {
  const schema = await createSchema();
  const pools: Pool[] = [];
  const migPool = createPool(PG_URL as string, schema);
  pools.push(migPool);
  await migrate(migPool, DEFAULT_MIGRATIONS_DIR);
  return {
    makeStore: () => {
      const pool = createPool(PG_URL as string, schema);
      pools.push(pool);
      return new PgJobStore(pool);
    },
    teardown: async () => {
      for (const p of pools) await p.end().catch(() => {});
      await dropSchema(schema);
    },
  };
}

export const STORE_FACTORIES: StoreFactory[] = [
  {
    name: 'in-memory',
    available: true,
    create: async () => ({ store: new InMemoryJobStore(), teardown: async () => {} }),
  },
  {
    name: 'postgres',
    available: PG_AVAILABLE,
    create: async () => {
      const schema = await createSchema();
      const pool = createPool(PG_URL as string, schema);
      await migrate(pool, DEFAULT_MIGRATIONS_DIR);
      return {
        store: new PgJobStore(pool),
        teardown: async () => {
          await pool.end().catch(() => {});
          await dropSchema(schema);
        },
      };
    },
  },
];
