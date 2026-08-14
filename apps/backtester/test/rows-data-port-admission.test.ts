// Д3 3.3в — НАСТОЯЩИЙ источник данных умеет допуск. Проверяется через живой HTTP.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ ФАЙЛ, ЕСЛИ ЕСТЬ `worker-admission*`. Те гоняют машину допуска на
// фикстурном источнике, которому `preflight` дописан тестом. Это доказывает
// поведение МАШИНЫ и ничего не говорит о том, что боевой порт вообще умеет её
// кормить: пока возможность обнаруживалась разнюхиванием (`typeof
// client.preflight === 'function'`), молчаливое «не умеет» выглядело в точности
// как «умеет и разрешил», и отличить их снаружи было нечем.
//
// Здесь всё настоящее: Fastify отвечает на `/historical/preflight`, порт создан
// обычным конструктором, клиент SDK — установленный из реестра. Проверяется не
// наличие свойства, а то, что вызов доходит до эндпойнта и возвращается
// РАЗОБРАННЫМ по контракту SDK.

import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PREFLIGHT_STATUS_BY_CODE,
  type PreflightRejectCode,
} from '@trdlabs/sdk/historical';
import { RowsDataPort } from '../src/data/rows-data-port';
import { FixtureDataPort } from '../src/data/reader';
import { AdmissionRefusedError, admitWindow } from '../src/data/availability-admission';
import { FIXTURES_DIR } from './helpers';

const DAY = 86_400_000;
const AVAILABLE_FROM = Date.parse('2026-06-01T00:00:00.000Z');
const AVAILABLE_TO = Date.parse('2026-06-11T00:00:00.000Z');

const ARCHIVE_ID = 'arch-rows-admission';
const DATASET_ID = 'ds-rows-admission';
const AVAILABILITY_ID = `sha256:${'c'.repeat(64)}`;
const AS_OF_MS = 1_780_000_000_000;

/** Сколько раз эндпойнт допуска реально позвали — «дошло по сети» против «вернулось из воздуха». */
let preflightCalls = 0;

function sendReject(reply: FastifyReply, code: PreflightRejectCode, message: string): FastifyReply {
  // Статус берётся ИЗ SDK, а не вписывается числом: классификация идёт по точной
  // тройке «статус + код + форма тела», и фикстура, разошедшаяся с таблицей,
  // проверяла бы собственную выдумку.
  return reply.status(PREFLIGHT_STATUS_BY_CODE[code]).send({
    ok: false,
    code,
    message,
    availabilityState: 'ready',
  });
}

function buildPlatform(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/historical/preflight', (req, reply) => {
    preflightCalls += 1;
    const q = req.query as { fromMs?: string; toMs?: string };
    const fromMs = Number(q.fromMs);
    const toMs = Number(q.toMs);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
      return sendReject(reply, 'WINDOW_MALFORMED', 'окно задано неверно');
    }
    const effectiveFromMs = Math.max(fromMs, AVAILABLE_FROM);
    const effectiveToMs = Math.min(toMs, AVAILABLE_TO);
    if (effectiveFromMs >= effectiveToMs) {
      return sendReject(reply, 'WINDOW_OUTSIDE_AVAILABLE', 'окно вне доступного интервала');
    }
    return reply.status(200).send({
      ok: true,
      requestedFromMs: fromMs,
      requestedToMs: toMs,
      effectiveFromMs,
      effectiveToMs,
      availableFromMs: AVAILABLE_FROM,
      availableToMs: AVAILABLE_TO,
      earliestAvailableDay: '2026-06-01',
      lastContiguousClosedDay: '2026-06-10',
      archiveId: ARCHIVE_ID,
      datasetId: DATASET_ID,
      availabilityId: AVAILABILITY_ID,
      asOfMs: AS_OF_MS,
      clamped: effectiveFromMs !== fromMs || effectiveToMs !== toMs,
    });
  });

  return app;
}

describe('RowsDataPort: допуск периода', () => {
  let server: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    server = buildPlatform();
    baseUrl = await server.listen({ host: '127.0.0.1', port: 0 });
  });

  afterAll(async () => {
    await server.close();
  });

  it('боевой порт объявляет И требование допуска, И сам допуск', () => {
    const port = new RowsDataPort({ baseUrl });
    expect(port.requiresAdmission).toBe(true);
    expect(typeof port.preflight).toBe('function');

    // РАЗДЕЛЯЮЩАЯ. Без неё «порт умеет допуск» было бы неотличимо от «свойство
    // есть у всех». У файловой фикстуры спрашивать разрешение не у кого: нет ни
    // требования, ни возможности — и воркер честно пропускает проверку, вместо
    // того чтобы отказать локальному прогону.
    const fixture = new FixtureDataPort(FIXTURES_DIR) as unknown as Record<string, unknown>;
    expect(fixture['requiresAdmission']).toBeUndefined();
    expect(fixture['preflight']).toBeUndefined();
  });

  it('успех приезжает РАЗОБРАННЫМ: effective-окно, признак обрезки, обе идентичности', async () => {
    const port = new RowsDataPort({ baseUrl });
    const before = preflightCalls;

    // Запрошено шире доступного — значит платформа обязана обрезать, а порт
    // обязан донести обрезку, а не «успешно» вернуть запрошенное.
    const res = await port.preflight(AVAILABLE_FROM - 5 * DAY, AVAILABLE_TO + 5 * DAY);

    expect(preflightCalls).toBe(before + 1);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.effectiveFromMs).toBe(AVAILABLE_FROM);
    expect(res.effectiveToMs).toBe(AVAILABLE_TO);
    expect(res.clamped).toBe(true);
    expect(res.archiveId).toBe(ARCHIVE_ID);
    expect(res.datasetId).toBe(DATASET_ID);
    expect(res.availabilityId).toBe(AVAILABILITY_ID);
    expect(res.asOfMs).toBe(AS_OF_MS);
  });

  it('отказ различим по коду И по статусу — того и другого локальная копия типов не знала', async () => {
    const port = new RowsDataPort({ baseUrl });
    const res = await port.preflight(AVAILABLE_TO + DAY, AVAILABLE_TO + 2 * DAY);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('WINDOW_OUTSIDE_AVAILABLE');
    // `status` появляется только в разборе SDK: тело ответа его не несёт.
    // Значит эта строка проверяет, что ответ прошёл через классификатор
    // контракта, а не был приведён к типу на глазок.
    expect(res.status).toBe(PREFLIGHT_STATUS_BY_CODE['WINDOW_OUTSIDE_AVAILABLE']);
    expect(res.availabilityState).toBe('ready');
  });

  it('порт подключается к машине допуска как AdmissionSource — без адаптера между ними', async () => {
    const port = new RowsDataPort({ baseUrl });

    const decision = await admitWindow(port, AVAILABLE_FROM - DAY, AVAILABLE_TO);
    expect(decision.effectiveFromMs).toBe(AVAILABLE_FROM);
    expect(decision.effectiveToMs).toBe(AVAILABLE_TO);
    expect(decision.clamped).toBe(true);
    expect(decision.availabilityId).toBe(AVAILABILITY_ID);

    // Отказ платформы доезжает кодом, а не текстом: `platformCode` — тот самый
    // замкнутый union SDK, и по нему видно, что чинить.
    await expect(admitWindow(port, AVAILABLE_TO + DAY, AVAILABLE_TO + 2 * DAY)).rejects.toMatchObject({
      code: 'preflight_rejected',
      platformCode: 'WINDOW_OUTSIDE_AVAILABLE',
    });
    await expect(admitWindow(port, AVAILABLE_TO + DAY, AVAILABLE_TO + 2 * DAY)).rejects.toBeInstanceOf(
      AdmissionRefusedError,
    );
  });
});
