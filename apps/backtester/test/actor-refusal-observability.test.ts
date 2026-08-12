// ГЕЙТ: причина отказа actor-пути ДОЖИВАЕТ до терминального результата через очередь.
//
// ═══ ЧТО БЫЛО СЛОМАНО ═══
//
// Через очередь отклонённый прогон нёс только `terminalCode: 'validation_error'`. Подробность
// существовала — она собиралась в сообщение бро́шенного `RunnerError` и уходила в `console.error`, —
// но к строке задания не была привязана ничем. Оператор, глядя на отклонённый прогон, видел слово,
// из которого не следует НИЧЕГО: ни того, выключена ли раскатка здесь, ни того, противоречив ли
// манифест, ни того, чья это вообще проблема — его или автора стратегии.
//
// ═══ ЧТО ПРОВЕРЯЕТСЯ ═══
//
// Не «в логах есть строка». Проверяется, что после ПОВТОРНОГО ЧТЕНИЯ ИЗ ХРАНИЛИЩА строка задания
// несёт структурированную причину: `code`, `message`, `path`. Лог этого не заменяет — он не
// привязан к прогону и переживает ротацию хуже, чем строка в базе.
//
// Обе дороги — прямая и потоковая — обязаны давать ОДИНАКОВУЮ причину. Транспорт не должен менять
// смысл отказа; разъехаться они могут независимо, и тогда одна дорога объясняла бы отказ, а вторая
// молчала.
//
// ═══ ЧЕМ ЭТО НЕ ЯВЛЯЕТСЯ ═══
//
// Это НЕ actor timeline: актор к моменту отказа ещё не создан, создавать его и нечем — отказ
// происходит до router'а, `createActor` и init. Смешивать эти два журнала нельзя: у них разные
// предметы (жизнь актора против допуска к запуску) и разные читатели.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { BacktestRunRequest, ModuleBundle, ValidationIssue } from '@trading/research-contracts';

import { AUTH, buildTestApp } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { __resetTapeCachesForTest } from '../src/data/tape-cache.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REQ = resolve(HERE, 'fixtures/overlay/requests');
const BUN = resolve(HERE, 'fixtures/overlay/bundles');

const loadRequest = (n: string): BacktestRunRequest =>
  JSON.parse(readFileSync(resolve(REQ, n), 'utf8')) as BacktestRunRequest;
const loadBundle = (n: string): ModuleBundle =>
  JSON.parse(readFileSync(resolve(BUN, n), 'utf8')) as ModuleBundle;

/** Поток грузит свой граф только под Node 24 (bt#201) — под 22 шов молча не соберётся. */
const THREAD_SEAM_LOADS = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10) >= 24;

const EVENT_DRIVEN = 'event-driven-probe.bundle.json';
const LEGACY = 'short-after-pump.bundle.json';

interface Terminal {
  readonly status: string;
  readonly terminalCode: string | null;
  readonly terminalIssues: readonly ValidationIssue[] | undefined;
}

/** Прогнать бандл через очередь и ПЕРЕЧИТАТЬ строку из хранилища. */
async function runAndReadBack(
  runId: string,
  bundleFile: string,
  opts: {
    readonly eventDrivenEnabled: boolean;
    readonly barLoopThread: boolean;
    readonly barBatching?: boolean;
  },
): Promise<Terminal> {
  __resetTapeCachesForTest();
  const bundle = loadBundle(bundleFile);
  const app = await buildTestApp({
    enableOverlayEngine: true,
    workerConcurrency: 1,
    eventDrivenEnabled: opts.eventDrivenEnabled,
    barLoopThread: opts.barLoopThread,
    ...(opts.barBatching === true ? { barBatching: true } : {}),
    overlaySandbox: { ...loadConfig().overlaySandbox, backend: 'isolate' },
  });
  try {
    const res = await app.server.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: AUTH,
      payload: {
        ...loadRequest('baseline.json'),
        runId,
        engine: 'strategy',
        moduleBundle: bundle,
        moduleRef: { id: bundle.manifest.id, version: bundle.manifest.version },
        metrics: ['pnl', 'win_rate'],
      },
    });
    expect(res.statusCode).toBe(202);
    expect(await app.drain()).toBe(1);

    // ПЕРЕЧИТЫВАЕМ, а не смотрим на то, что вернул воркер: проверяется хранилище, а не память.
    const row = await app.store.get(runId);
    expect(row, `строка ${runId} не найдена`).toBeDefined();
    return {
      status: row!.status,
      terminalCode: row!.terminalCode ?? null,
      terminalIssues: row!.terminalIssues,
    };
  } finally {
    await app.dispose();
  }
}

/** Первая причина отказа — та, ради которой всё это и заведено. */
const reasonOf = (t: Terminal): ValidationIssue => {
  expect(t.terminalIssues, 'структурированная причина не доехала до строки задания').toBeDefined();
  expect(t.terminalIssues!.length).toBeGreaterThan(0);
  return t.terminalIssues![0]!;
};

/**
 * Три разных отказа, различимые ТОЛЬКО подробностью.
 *
 * `terminalCode` у всех трёх один и тот же — `validation_error`. Именно поэтому кода мало: он не
 * различает «раскатка выключена здесь» (операторская настройка), «режимы несовместимы»
 * (конфигурация прогона) и «исполнитель не умеет lifecycle» (состояние сборки). Чинят их разные
 * люди и разными действиями.
 */
const REFUSALS = [
  {
    name: 'раскатка выключена',
    opts: { eventDrivenEnabled: false },
    expect: /раскатк|BACKTESTER_EVENT_DRIVEN_ENABLED/i,
  },
  {
    name: 'несовместимый батчинг',
    opts: { eventDrivenEnabled: true, barBatching: true },
    expect: /BAR_BATCHING/,
  },
  {
    name: 'исполнитель не умеет lifecycle актора',
    opts: { eventDrivenEnabled: true },
    expect: /lifecycle актора/,
  },
] as const;

describe('структурированная причина доживает до терминального результата', () => {
  it.each(REFUSALS)(
    'прямая дорога: $name',
    async ({ name, opts, expect: pattern }) => {
      const t = await runAndReadBack(`ref-direct-${name.replace(/\s+/g, '-')}`, EVENT_DRIVEN, {
        barLoopThread: false,
        eventDrivenEnabled: opts.eventDrivenEnabled,
        ...('barBatching' in opts ? { barBatching: opts.barBatching } : {}),
      });
      expect(t.status).not.toBe('completed');
      // Код остаётся прежним — совместимость не ломается; различает подробность.
      expect(t.terminalCode).toBe('validation_error');
      const issue = reasonOf(t);
      expect(issue.code).toBe('unsupported_lifecycle');
      expect(issue.message).toMatch(pattern);
    },
    300_000,
  );

  it.skipIf(!THREAD_SEAM_LOADS).each(REFUSALS)(
    'ПОТОКОВАЯ дорога: $name — та же причина',
    async ({ name, opts, expect: pattern }) => {
      // Транспорт не меняет смысл отказа. Разъехаться дороги могут независимо: у потоковой свой
      // перенос флагов через structured clone.
      const t = await runAndReadBack(`ref-thread-${name.replace(/\s+/g, '-')}`, EVENT_DRIVEN, {
        barLoopThread: true,
        eventDrivenEnabled: opts.eventDrivenEnabled,
        ...('barBatching' in opts ? { barBatching: opts.barBatching } : {}),
      });
      expect(t.terminalCode).toBe('validation_error');
      const issue = reasonOf(t);
      expect(issue.code).toBe('unsupported_lifecycle');
      expect(issue.message).toMatch(pattern);
    },
    300_000,
  );
});

describe('пустой JSON Pointer доживает КЛЮЧОМ, а не исчезает', () => {
  it('path присутствует и равен пустой строке после чтения из хранилища', async () => {
    // `path: ''` нормативен для причины без нарушающего узла (RFC 6901 §5, закреплено в sdk 0.15.0).
    // Пустая строка — любимая жертва проверок вида `if (issue.path)`: ключ пропадает, и причина
    // становится «где-то в документе» вместо «документ целиком».
    const t = await runAndReadBack('ref-path-empty', EVENT_DRIVEN, {
      eventDrivenEnabled: false,
      barLoopThread: false,
    });
    const issue = reasonOf(t);
    expect('path' in issue).toBe(true);
    expect(issue.path).toBe('');
  }, 300_000);

  it('и переживает сериализацию, а не только жизнь в памяти', async () => {
    // Хранилище в этом наборе — in-memory, поэтому сериализацию проверяем явно: в Postgres причина
    // ложится в `jsonb`, и потеря пустой строки была бы видна только там.
    const t = await runAndReadBack('ref-path-serialized', EVENT_DRIVEN, {
      eventDrivenEnabled: false,
      barLoopThread: false,
    });
    const roundTripped = JSON.parse(JSON.stringify(t.terminalIssues)) as ValidationIssue[];
    expect('path' in roundTripped[0]!).toBe(true);
    expect(roundTripped[0]!.path).toBe('');
    expect(roundTripped[0]!.code).toBe('unsupported_lifecycle');
  }, 300_000);
});

describe('ПРОВЕРКА ПРОВЕРКИ: legacy-прогон не изменился', () => {
  it.each([
    ['прямая', false],
    ['потоковая', true],
  ] as const)('%s дорога: legacy завершается и причин не несёт', async (_name, thread) => {
    // Без этого всё выше зеленело бы и на пути, отвергающем что угодно. Заодно проверяется, что
    // новое поле не появляется у успешного прогона: причина у завершившегося прогона означала бы,
    // что мы пишем её всегда и она ничего не различает.
    if (thread && !THREAD_SEAM_LOADS) return;
    const t = await runAndReadBack(`ref-legacy-${thread ? 'thread' : 'direct'}`, LEGACY, {
      eventDrivenEnabled: true,
      barLoopThread: thread,
    });
    expect(t.status).toBe('completed');
    expect(t.terminalIssues).toBeUndefined();
  }, 300_000);
});
