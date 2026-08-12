// Д3 3.3в — допуск в воркере: три исхода, и все три различимы снаружи.
//
// Проверяется не модуль допуска (он покрыт отдельно), а ПРОВОДКА: какой
// терминальный код получает задание, создаётся ли результат, и вызываются ли
// загрузка с вычислением.

import { describe, expect, it, vi } from 'vitest';
import { materializeFor, RunnerError } from '../src/jobs/worker';
import { RealDataUnavailableError } from '../src/data/rows-data-port';
import type { BacktesterDataPort } from '../src/data/reader';

const FROM = '2026-06-10T00:00:00.000Z';
const TO = '2026-06-12T23:59:59.999Z';

const claimed = {
  runId: 'run-1',
  attempts: 0,
  datasetRef: 'BTCUSDT:1m',
  requestFingerprint: 'fp',
  request: {
    engine: 'momentum',
    mode: 'research',
    moduleRef: 'mod',
    symbols: ['BTCUSDT'],
    timeframe: '1m',
    period: { from: FROM, to: TO },
    metrics: [],
  },
  effectiveSeed: 1,
} as never;

/** Порт, объявивший себя настоящим, но без preflight — несовместимый SDK. */
const portWithoutPreflight = {
  requiresAdmission: true,
  listDatasets: async () => [],
  openDataset: vi.fn(async () => undefined),
} as unknown as BacktesterDataPort;

const depsWith = (dataPort: BacktesterDataPort) => ({ dataPort } as never);

describe('допуск в воркере', () => {
  it('источник без preflight — терминальная ошибка конфигурации, а не пропуск', async () => {
    // Отсутствие capability означает «решение не вынесено», а не «разрешено».
    let err: unknown;
    await materializeFor(depsWith(portWithoutPreflight), claimed).catch((e) => { err = e; });

    expect(err).toBeInstanceOf(RunnerError);
    expect((err as RunnerError).code).toBe('admission_unavailable');
    // Код ОТЛИЧАЕТСЯ от отказа допуска: там решение есть и оно отрицательное.
    expect((err as RunnerError).code).not.toBe('rejected_admission');
    // И до данных дело не дошло вовсе.
    expect((portWithoutPreflight as unknown as { openDataset: ReturnType<typeof vi.fn> }).openDataset)
      .not.toHaveBeenCalled();
  });

  it('распознанный отказ платформы — rejected_admission, загрузки нет', async () => {
    const openDataset = vi.fn(async () => undefined);
    const port = {
      requiresAdmission: true,
      listDatasets: async () => [],
      openDataset,
      preflight: async () => ({
        ok: false,
        code: 'AVAILABILITY_NOT_INITIALIZED',
        message: 'индекс не опубликован',
        availabilityState: 'not_initialized',
      }),
    } as unknown as BacktesterDataPort;

    let err: unknown;
    await materializeFor(depsWith(port), claimed).catch((e) => { err = e; });

    expect((err as Error).name).toBe('AdmissionRefusedError');
    expect(openDataset).not.toHaveBeenCalled();
  });

  it('сбой транспорта остаётся прежним путём, а не превращается в отказ допуска', async () => {
    // Разделяющая проверка: иначе «не ретраим отказ допуска» незаметно
    // превратилось бы в «не ретраим ничего», и настоящий сбой сети стал бы
    // терминальным вместо повторяемого.
    const port = {
      requiresAdmission: true,
      listDatasets: async () => [],
      openDataset: vi.fn(async () => undefined),
      preflight: async () => { throw new RealDataUnavailableError('timeout', 'BTCUSDT:1m'); },
    } as unknown as BacktesterDataPort;

    let err: unknown;
    await materializeFor(depsWith(port), claimed).catch((e) => { err = e; });

    expect(err).toBeInstanceOf(RealDataUnavailableError);
    expect((err as RealDataUnavailableError).reason).toBe('timeout');
    // Не AdmissionRefusedError и не RunnerError — путь не подменён.
    expect((err as Error).name).not.toBe('AdmissionRefusedError');
  });

  it('порт БЕЗ requiresAdmission (мок, фикстура) допуск не проходит и не падает', async () => {
    // Фикстуре не у кого спрашивать разрешение. Различие наблюдаемо: у такого
    // прогона в evidence нет блока admission — а не «допуск прошёл, просто пустой».
    const openDataset = vi.fn(async () => undefined);
    const port = { listDatasets: async () => [], openDataset } as unknown as BacktesterDataPort;

    // Дойдёт до openDataset и упадёт уже на отсутствии датасета — то есть допуск
    // пропущен, а дальше обычный путь.
    let err: unknown;
    await materializeFor(depsWith(port), claimed).catch((e) => { err = e; });
    expect(openDataset).toHaveBeenCalled();
    expect((err as Error).name).not.toBe('AdmissionRefusedError');
  });
});
