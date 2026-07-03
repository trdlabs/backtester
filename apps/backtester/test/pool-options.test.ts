import { describe, expect, it } from 'vitest';
import { createPool } from '../src/db/pool.js';
import { PG_AVAILABLE } from './store-factories.js';

const PG_URL = process.env.BACKTESTER_TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe('createPool options', () => {
  it('threads max and statement_timeout into the pool config', () => {
    const pool = createPool('postgres://u:p@localhost:5/db', undefined, { max: 7, statementTimeoutMs: 1234 });
    expect(pool.options.max).toBe(7);
    expect(pool.options.options).toContain('statement_timeout=1234');
    void pool.end();
  });

  it('combines schema search_path with statement_timeout in one options string', () => {
    const pool = createPool('postgres://u:p@localhost:5/db', 'myschema', { statementTimeoutMs: 500 });
    expect(pool.options.options).toContain('search_path=myschema');
    expect(pool.options.options).toContain('statement_timeout=500');
    void pool.end();
  });

  it('defaults preserve today: no opts → no options string beyond schema, pg default max', () => {
    const pool = createPool('postgres://u:p@localhost:5/db');
    expect(pool.options.options).toBeUndefined();
    // pg-pool's own constructor fills in `this.options.max = this.options.max || 10` unconditionally,
    // so an un-set `max` always normalizes to pg's default of 10 post-construction — not `undefined`.
    expect(pool.options.max).toBe(10);
    void pool.end();
  });

  it('clamps garbage env-derived values (pool max >= 1, timeout >= 0)', () => {
    const pool = createPool('postgres://u:p@localhost:5/db', undefined, { max: 0, statementTimeoutMs: -5 });
    expect(pool.options.max).toBe(1);            // createPool itself clamps too
    expect(pool.options.options).toBeUndefined(); // negative timeout = off
    void pool.end();
  });
});

describe.skipIf(!PG_AVAILABLE)('createPool statement_timeout (Postgres conformance)', () => {
  it('SHOW statement_timeout reflects the option on a live connection', async () => {
    const pool = createPool(PG_URL as string, undefined, { statementTimeoutMs: 4321 });
    try {
      const r = await pool.query<{ statement_timeout: string }>('SHOW statement_timeout');
      expect(r.rows[0]!.statement_timeout).toBe('4321ms');
    } finally {
      await pool.end();
    }
  });

  it('no-opts pool shows 0 (off) — the migrations-exempt path', async () => {
    const pool = createPool(PG_URL as string);
    try {
      const r = await pool.query<{ statement_timeout: string }>('SHOW statement_timeout');
      expect(r.rows[0]!.statement_timeout).toBe('0');
    } finally {
      await pool.end();
    }
  });
});
