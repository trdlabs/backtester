// POSTGRES-ГЕЙТНЫЙ round-trip структурированной причины отказа.
//
// ЗАЧЕМ ОТДЕЛЬНО ОТ IN-MEMORY НАБОРА. Тот держит объект по ссылке: причина «доезжает» до строки, не
// проходя ни сериализации, ни колонки, ни обратного разбора. Потеря пустого JSON Pointer (`path: ''`)
// в памяти НЕВИДИМА по построению — она случилась бы ровно на границе с базой.
//
// Здесь гоняется настоящая цепочка: миграция → `transition` с `terminalIssues` → чтение НОВЫМ
// экземпляром `PgJobStore`. Новым намеренно: экземпляр, только что писавший, мог бы вернуть своё
// же значение из чего угодно, а вопрос стоит про КОЛОНКУ.
//
// Набор пропускается (не падает) там, где базы нет; на CI Postgres-полоса живая, и именно она эту
// ветку и проверяет.

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ValidationIssue } from '@trading/research-contracts/research';

import { createPool } from '../src/db/pool';
import { DEFAULT_MIGRATIONS_DIR, migrate } from '../src/db/migrate';
import { PG_AVAILABLE } from './store-factories';
import { PgJobStore } from '../src/jobs/pg-job-store';
import type { NewJob } from '../src/jobs/job-store.js';

/** Причина ровно той формы, что рождает допуск actor-пути, включая пустой Pointer. */
const ISSUES: readonly ValidationIssue[] = [
  {
    severity: 'error',
    code: 'unsupported_lifecycle',
    message: 'раскатка event-driven выключена на этом хосте',
    path: '',
  },
];

function job(runId: string): NewJob {
  return {
    jobId: runId,
    runId,
    requestFingerprint: `fp-${runId}`,
    request: {} as never,
    effectiveSeed: 1,
    datasetRef: 'ds',
    runTimeoutMs: 60_000,
    acceptedAtMs: 0,
  };
}

describe.skipIf(!PG_AVAILABLE)('terminalIssues переживают Postgres (round-trip через колонку)', () => {
  const PG_URL = (process.env.BACKTESTER_TEST_DATABASE_URL ?? process.env.DATABASE_URL) as string;
  const schema = `bt_test_ti_${process.pid}_${Date.now().toString(36)}`;
  let adminPool: Pool;
  let pool: ReturnType<typeof createPool>;
  let writer: PgJobStore;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: PG_URL });
    await adminPool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    pool = createPool(PG_URL, schema);
    await migrate(pool, DEFAULT_MIGRATIONS_DIR);
    writer = new PgJobStore(pool);
  });

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  });

  /** Довести задание до `running` — из него и происходит терминальный переход воркера. */
  async function toRunning(runId: string): Promise<void> {
    await writer.insertOrGet(job(runId));
    expect(await writer.transition(runId, 'accepted', 'queued', { atMs: 1 })).toBe(true);
    expect(await writer.transition(runId, 'queued', 'running', { atMs: 2 })).toBe(true);
  }

  it('причина доезжает до колонки и читается НОВЫМ экземпляром store', async () => {
    await toRunning('pg-ti-failed');
    expect(
      await writer.transition('pg-ti-failed', 'running', 'failed', {
        atMs: 3,
        terminalAtMs: 3,
        terminalCode: 'validation_error',
        terminalIssues: ISSUES,
      }),
    ).toBe(true);

    // Новый экземпляр: спрашиваем базу, а не память писавшего.
    const reader = new PgJobStore(pool);
    const row = await reader.get('pg-ti-failed');
    expect(row?.terminalCode).toBe('validation_error');
    expect(row?.terminalIssues).toEqual(ISSUES);
  });

  it('пустой JSON Pointer остаётся КЛЮЧОМ, а не исчезает в jsonb', async () => {
    // Главное утверждение набора. `path: ''` нормативен для причины без нарушающего узла; пустая
    // строка — любимая жертва и проверок `if (issue.path)`, и склейки в текст.
    const reader = new PgJobStore(pool);
    const issue = (await reader.get('pg-ti-failed'))!.terminalIssues![0]!;
    expect('path' in issue).toBe(true);
    expect(issue.path).toBe('');
  });

  it('у прогона без причины колонка остаётся пустой, а не заводит пустой массив', async () => {
    // Проверка проверки: `undefined` и `[]` — разные утверждения («причин нет» против «отказ без
    // подробностей»), и склеивать их в одно значение нельзя.
    await toRunning('pg-ti-none');
    expect(
      await writer.transition('pg-ti-none', 'running', 'completed', { atMs: 3, terminalAtMs: 3 }),
    ).toBe(true);
    const reader = new PgJobStore(pool);
    expect((await reader.get('pg-ti-none'))?.terminalIssues).toBeUndefined();
  });

  it('повторный переход БЕЗ причины не стирает уже записанную', async () => {
    // `COALESCE` в UPDATE означает «не трогать колонку, если в патче ничего нет». Без этого любой
    // последующий патч (например, продление активности) обнулял бы причину молча.
    const reader = new PgJobStore(pool);
    const before = (await reader.get('pg-ti-failed'))!.terminalIssues;
    await writer.transition('pg-ti-failed', 'failed', 'failed', { atMs: 4 }).catch(() => undefined);
    expect((await reader.get('pg-ti-failed'))?.terminalIssues).toEqual(before);
  });
});
