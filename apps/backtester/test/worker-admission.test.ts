// Д3 3.3в — допуск в воркере: три исхода, и все три различимы снаружи.
//
// Проверяется не модуль допуска (он покрыт отдельно), а ПРОВОДКА: какой
// терминальный код получает задание, создаётся ли результат, и вызываются ли
// загрузка с вычислением.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { finalizeResult, materializeFor, RunnerError } from '../src/jobs/worker';
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

describe('допуск доезжает до РЕЗУЛЬТАТА, а не только до журнала', () => {
  // Первая редакция 3.3в вычисляла evidence, печатала его в stdout и
  // выбрасывала (`void admissionEv`). Требование «сохрани evidence» при этом
  // выглядело выполненным: строка в логе есть. Но потребитель читает результат,
  // а не stdout, — и lab физически не мог принять effective-период.
  const admission = {
    requestedFromMs: 0,
    requestedToMs: 9_999,
    effectiveFromMs: 1_000,
    effectiveToMs: 2_000,
    clamped: true,
    availabilityId: `sha256:${'a'.repeat(64)}`,
    asOfMs: 111,
    admittedAvailabilityId: `sha256:${'b'.repeat(64)}`,
    admittedAsOfMs: 222,
    archiveId: 'arch-1',
    datasetId: 'ds-1',
  };

  // Стор объявляет ровно то, что зовёт `persistRunArtifacts`. Двойник, у которого
  // метода нет, дал бы отказ теста по чужой причине — и проверка допуска не
  // выполнилась бы вовсе.
  const deps = {
    artifactStore: { write: async () => 'sha256:deadbeef' },
  } as never;

  const claimedRow = {
    runId: 'run-fin',
    effectiveSeed: 1,
    datasetRef: 'BTCUSDT:1m',
    request: { moduleRef: { id: 'm', version: '1' } },
  } as never;

  it('без допуска evidence его НЕ несёт — различие наблюдаемо', async () => {
    const payload = { metrics: { netPnlUsd: 1 }, trades: [], equityCurve: [] } as never;
    const fin = await finalizeResult(deps, 'momentum' as never, payload, claimedRow, 'fp');
    expect('admission' in fin.summary.evidence).toBe(false);
  });

  /** Исход overlay/strategy: у этих ветвей ДРУГАЯ проекция, и допуск дописывается после неё. */
  const overlayOutcome = {
    status: 'completed',
    baseline: {
      runId: 'run-fin',
      metrics: { netPnlUsd: 1 },
      trades: [],
      decisionRecords: [],
      evidence: {
        seed: 1,
        moduleVersions: [{ id: 'm', version: '1' }],
        datasetRef: 'BTCUSDT:1m',
        equityCurve: [],
      },
    },
  } as never;

  it('overlay/strategy: проекция строится из ИСХОДА, а допуск переживает её', async () => {
    // Отдельная ветвь внутри finalizeResult: `toOverlaySummary` собирает evidence
    // из outcome и про допуск не знает вовсе — он свойство ПРОГОНА, а не исхода.
    // Если дописывание после проекции однажды уедет выше по коду, оно молча
    // потеряется, и здесь это станет видно.
    const fin = await finalizeResult(
      deps, 'overlay' as never, overlayOutcome, claimedRow, 'fp', undefined, undefined, admission as never,
    );
    expect(fin.summary.evidence.admission).toEqual(admission);
    // И то, что проекция построена: допуск не подменил собой остальное evidence.
    expect(fin.summary.evidence.datasetRef).toBe('BTCUSDT:1m');
  });

  it('overlay/strategy без допуска: поля нет, а не пустой объект', async () => {
    const fin = await finalizeResult(deps, 'overlay' as never, overlayOutcome, claimedRow, 'fp');
    expect('admission' in fin.summary.evidence).toBe(false);
  });

  it('momentum: evidence прогона несёт admission', async () => {
    const payload = { metrics: { netPnlUsd: 1 }, trades: [], equityCurve: [] } as never;
    // БЕЗ условного пропуска: проверка, чьё предусловие может не наступить,
    // зелена по неверной причине. Если фикстура не доходит до результата — это
    // отказ теста, а не повод молча ничего не проверить.
    const fin = await finalizeResult(deps, 'momentum' as never, payload, claimedRow, 'fp', undefined, undefined, admission as never);
    expect(fin.summary.evidence.admission).toEqual(admission);
    // Разделяющая: запрошенное и фактическое РАЗНЫЕ, и обе идентичности тоже —
    // иначе равенство прошло бы и на схлопнутых в одно значение полях.
    expect(fin.summary.evidence.admission?.requestedFromMs)
      .not.toBe(fin.summary.evidence.admission?.effectiveFromMs);
    expect(fin.summary.evidence.admission?.availabilityId)
      .not.toBe(fin.summary.evidence.admission?.admittedAvailabilityId);
  });
});

describe('ВСЕ ЧЕТЫРЕ ветви результата передают допуск', () => {
  // ЗАЧЕМ ГЕЙТ ПО ИСХОДНИКУ, А НЕ ЕЩЁ ЧЕТЫРЕ ПРОГОНА. Две ветви из четырёх —
  // overlay и strategy — идут через песочницу на Docker: локально они не
  // исполняются вовсе, и «зелено без Docker» означало бы «не проверено».
  //
  // Так и вышло в первой редакции 3.3в: допуск передавался ровно в две ветви из
  // четырёх, прямой тест `finalizeResult` был зелёным, а `strategy fresh` и
  // `momentum fresh` теряли evidence молча. Проверять здесь надо ПРОВОДКУ, и она
  // видна в тексте вызова — в отличие от исполнения, которого локально нет.
  const SRC = readFileSync(resolve(import.meta.dirname, '../src/jobs/worker.ts'), 'utf8');

  /** Аргументы каждого ВЫЗОВА finalizeResult (объявление пропускается). */
  function finalizeCallArgs(src: string): string[] {
    const out: string[] = [];
    const re = /(?<!function\s)finalizeResult\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const start = m.index + m[0].length;
      let depth = 1;
      let i = start;
      for (; i < src.length && depth > 0; i += 1) {
        if (src[i] === '(') depth += 1;
        else if (src[i] === ')') depth -= 1;
      }
      out.push(src.slice(start, i - 1));
    }
    return out;
  }

  it('вызовов ровно четыре — пятая ветвь не появится незамеченной', () => {
    // Число зафиксировано намеренно: новая ветвь результата обязана пройти через
    // это утверждение, а не добавиться тихо и без допуска.
    expect(finalizeCallArgs(SRC)).toHaveLength(4);
  });

  it('каждый вызов передаёт evidence допуска', () => {
    const args = finalizeCallArgs(SRC);
    const without = args.filter((a) => !/\badmissionEv\b/.test(a));
    // Сообщение печатает сам вызов: «3 из 4» отправило бы читателя искать, какой
    // именно, — а гейт это уже знает.
    expect(without.join('\n---\n')).toBe('');
  });

  it('гейт не вакуумен: он ловит вызов без допуска', () => {
    // Проверка проверки. Без неё «все четыре передают» было бы зелено и на
    // регулярке, не совпадающей ни с чем.
    const broken = SRC.replace(', admissionEv)', ')');
    expect(broken).not.toBe(SRC);
    expect(finalizeCallArgs(broken).filter((a) => !/\badmissionEv\b/.test(a))).toHaveLength(1);
  });
});
