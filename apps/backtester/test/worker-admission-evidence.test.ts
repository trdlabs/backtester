// Д3 (3.3в) — допуск доезжает до СОХРАНЁННОГО результата, на уровне воркера.
//
// Прямого вызова `finalizeResult` НЕДОСТАТОЧНО, и это не рассуждение: первая
// редакция передавала допуск ровно в две ветви из четырёх, прямой тест был
// зелёным, а `strategy fresh` и `momentum fresh` молча теряли evidence. Здесь
// прогон идёт через `processNextQueued`, а проверяется то, что легло в job-store,
// — то есть то, что увидит потребитель.
//
// Docker не нужен: momentum-путь, та же проводка, что у dedup-worker.test.ts.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InMemoryJobStore, type NewJob } from '../src/jobs/job-store.js';
import { processNextQueued, type WorkerDeps } from '../src/jobs/worker.js';
import { InMemoryArtifactStore } from '../src/artifacts/store.js';
import { InMemoryResultCache } from '../src/jobs/dedup/result-cache.js';
import { FixtureDataPort } from '../src/data/reader.js';
import { FIXTURES_DIR } from './helpers.js';
import { loadConfig } from '../src/config.js';

const CLOCK = 1_700_000_000_000;

/** Период ФИКСТУРЫ — то, что реально доступно. */
const AVAILABLE_FROM = Date.parse('2023-11-14T00:00:00.000Z');
const AVAILABLE_TO = Date.parse('2023-11-15T00:00:00.000Z');
/** Запрошено ШИРЕ доступного — значит допуск обязан обрезать. */
const REQUESTED_FROM = Date.parse('2023-11-01T00:00:00.000Z');
const REQUESTED_TO = Date.parse('2023-12-01T00:00:00.000Z');

const ARCHIVE_ID = 'arch-worker-evidence';
const DATASET_ID = 'ds-worker-evidence';
const AV_FIRST = `sha256:${'a'.repeat(64)}`;
/** Второй ответ несёт ДРУГОЙ дайджест: ночью закрылся новый день. Это законно и
 *  равенства не требует — но в evidence обе идентичности обязаны остаться разными. */
const AV_SECOND = `sha256:${'b'.repeat(64)}`;

const REQ = {
  mode: 'research',
  moduleRef: { id: 'smoke', version: '1.0.0' },
  datasetRef: 'smoke-btc-1m',
  symbols: ['BTCUSDT'],
  timeframe: '1m',
  period: { from: new Date(REQUESTED_FROM).toISOString(), to: new Date(REQUESTED_TO).toISOString() },
  seed: 42,
  metrics: [],
} as const;

const SHARED_FP = 'fp-admission-evidence';

function job(runId: string): NewJob {
  return {
    jobId: runId,
    runId,
    requestFingerprint: SHARED_FP,
    request: REQ as never,
    effectiveSeed: 42,
    datasetRef: 'smoke-btc-1m',
    runTimeoutMs: 3_600_000,
    acceptedAtMs: CLOCK,
  };
}

/**
 * Источник данных, объявивший себя настоящим и умеющий preflight.
 *
 * Первый вызов приходит с ЗАПРОШЕННЫМ окном и обрезает его; второй — уже с
 * effective-окном, и обязан вернуть его неизменным и необрезанным, иначе воркер
 * откажет. Так фикстура воспроизводит обе проверки, а не одну.
 */
function admittingPort(): FixtureDataPort & { calls: Array<[number, number]> } {
  const port = new FixtureDataPort(FIXTURES_DIR) as FixtureDataPort & { calls: Array<[number, number]> };
  port.calls = [];
  (port as unknown as { requiresAdmission: boolean }).requiresAdmission = true;
  (port as unknown as { preflight: unknown }).preflight = async (fromMs: number, toMs: number) => {
    port.calls.push([fromMs, toMs]);
    const first = port.calls.length === 1;
    const effectiveFromMs = Math.max(fromMs, AVAILABLE_FROM);
    const effectiveToMs = Math.min(toMs, AVAILABLE_TO);
    return {
      ok: true,
      requestedFromMs: fromMs,
      requestedToMs: toMs,
      effectiveFromMs,
      effectiveToMs,
      availableFromMs: AVAILABLE_FROM,
      availableToMs: AVAILABLE_TO,
      earliestAvailableDay: '2023-11-14',
      lastContiguousClosedDay: '2023-11-14',
      archiveId: ARCHIVE_ID,
      datasetId: DATASET_ID,
      availabilityId: first ? AV_FIRST : AV_SECOND,
      asOfMs: first ? 111 : 222,
      clamped: effectiveFromMs !== fromMs || effectiveToMs !== toMs,
    };
  };
  return port;
}

function makeCtx(opts: { dedupEnabled?: boolean } = {}) {
  const config = loadConfig();
  const store = new InMemoryJobStore();
  const cache = new InMemoryResultCache();
  const dataPort = admittingPort();
  const deps = {
    store,
    clock: () => CLOCK,
    uid: () => randomUUID(),
    postWebhook: async () => {},
    dataPort,
    artifactStore: new InMemoryArtifactStore(),
    overlaySandbox: config.overlaySandbox,
    resultCache: cache,
    ...(opts.dedupEnabled !== undefined ? { dedupEnabled: opts.dedupEnabled } : {}),
  } as unknown as WorkerDeps;
  return { store, cache, deps, dataPort };
}

async function enqueue(store: InMemoryJobStore, runId: string): Promise<void> {
  await store.insertOrGet(job(runId));
  await store.transition(runId, 'accepted', 'queued', { atMs: CLOCK, queuedAtMs: CLOCK });
}

/** То, что реально сохранено для потребителя. */
async function admissionOf(store: InMemoryJobStore, runId: string) {
  const row = await store.get(runId);
  expect(row?.status).toBe('completed');
  const summary = row?.resultSummary as { evidence?: { admission?: Record<string, unknown> } } | undefined;
  return summary?.evidence?.admission;
}

describe('worker: допуск в СОХРАНЁННОМ результате (momentum fresh)', () => {
  it('обе проверки выполнены, а evidence несёт requested/effective и ДВЕ идентичности', async () => {
    const { store, deps, dataPort } = makeCtx();
    const runId = 'run-adm-1';
    await enqueue(store, runId);
    await processNextQueued(deps);

    // Обе проверки: первая на запрошенном окне, вторая — РОВНО на выданном
    // effective. Без второй прогон считал бы на данных, право на которые могло
    // быть отозвано, пока шла загрузка.
    expect(dataPort.calls).toHaveLength(2);
    expect(dataPort.calls[0]).toEqual([REQUESTED_FROM, REQUESTED_TO]);
    expect(dataPort.calls[1]).toEqual([AVAILABLE_FROM, AVAILABLE_TO]);

    const adm = await admissionOf(store, runId);
    expect(adm).toBeDefined();

    // Запрошенное сохраняется КАК БЫЛО: тихо суженный период означал бы, что в
    // evidence записано одно, а протестировано другое.
    expect(adm?.requestedFromMs).toBe(REQUESTED_FROM);
    expect(adm?.requestedToMs).toBe(REQUESTED_TO);
    expect(adm?.effectiveFromMs).toBe(AVAILABLE_FROM);
    expect(adm?.effectiveToMs).toBe(AVAILABLE_TO);
    expect(adm?.clamped).toBe(true);

    // Идентичности РАЗНЫЕ: «на чём решили» против «чем разрешили».
    expect(adm?.availabilityId).toBe(AV_FIRST);
    expect(adm?.admittedAvailabilityId).toBe(AV_SECOND);
    expect(adm?.asOfMs).toBe(111);
    expect(adm?.admittedAsOfMs).toBe(222);
    expect(adm?.availabilityId).not.toBe(adm?.admittedAvailabilityId);

    // Подтверждены обеими проверками.
    expect(adm?.archiveId).toBe(ARCHIVE_ID);
    expect(adm?.datasetId).toBe(DATASET_ID);
  });

  it('DEDUP-HIT тоже несёт допуск: это НОВЫЙ логический прогон', async () => {
    // Попадание в кэш перештамповывает шаблон под новый runId и создаёт
    // результат нового прогона. Оставь его без допуска — и появился бы прогон,
    // о разрешении которого ничего не известно, зато выглядящий законным.
    const { store, deps } = makeCtx({ dedupEnabled: true });
    await enqueue(store, 'run-adm-miss');
    await processNextQueued(deps);
    await enqueue(store, 'run-adm-hit');
    await processNextQueued(deps);

    const miss = await admissionOf(store, 'run-adm-miss');
    const hit = await admissionOf(store, 'run-adm-hit');
    expect(miss).toBeDefined();
    expect(hit).toBeDefined();
    expect(hit?.effectiveFromMs).toBe(AVAILABLE_FROM);
    expect(hit?.clamped).toBe(true);
  });

  it('источник БЕЗ допуска — evidence его не несёт, и это наблюдаемо', async () => {
    // Разделяющая: иначе «допуск сохраняется» было бы неотличимо от «поле есть
    // всегда». У фикстуры спрашивать разрешение не у кого.
    const config = loadConfig();
    const store = new InMemoryJobStore();
    const deps = {
      store,
      clock: () => CLOCK,
      uid: () => randomUUID(),
      postWebhook: async () => {},
      dataPort: new FixtureDataPort(FIXTURES_DIR),
      artifactStore: new InMemoryArtifactStore(),
      overlaySandbox: config.overlaySandbox,
    } as unknown as WorkerDeps;

    await enqueue(store, 'run-adm-none');
    await processNextQueued(deps);

    const row = await store.get('run-adm-none');
    expect(row?.status).toBe('completed');
    const summary = row?.resultSummary as { evidence?: Record<string, unknown> } | undefined;
    expect(summary?.evidence).toBeDefined();
    expect('admission' in (summary!.evidence!)).toBe(false);
  });
});
