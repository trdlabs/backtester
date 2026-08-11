// ГЕЙТ ПРОД-ПРОВОДКИ: флаг раскатки event-driven доезжает до прогона ОБЕИМИ дорогами.
//
// Почему отдельно от двух соседних наборов. `actor-admission-fail-closed` доказывает РЕШЕНИЕ (при
// каком наборе условий допуск отказывает); `actor-admission-prod-path` — что решение исполняется
// раннером и с какой причиной. Ни один из них не знает про конфиг, воркера, очередь и поток.
//
// Здесь проверяется единственное, что оставалось непроверенным: ДОЕЗЖАЕТ ли флаг. Он объявлен
// production-возможностью, значит доставка обязана быть доказана, а не выведена из того, что код
// компилируется. Репозиторий уже платил за такой вывод: `contextFreeze` считался в конфиге,
// `StrategyRunDeps` его не принимал, развёртывание просило снять заморозку — и она молча оставалась
// (см. `context-freeze-prod-path.test.ts`). Там расходилась СТОИМОСТЬ при верных числах; здесь
// разошлось бы то, ЧТО исполнялось.
//
// ── ЧЕГО ЭТОТ НАБОР НЕ МОЖЕТ, и это свойство системы, а не теста ────────────────────────────────
//
// Различить ПРИЧИНУ отказа на уровне очереди нечем. Строка задания несёт только
// `terminalCode: 'validation_error'`; поля с сообщением у неё нет, в `timeline` причины тоже нет, а
// подробность (включая код `unsupported_lifecycle` и текст) живёт лишь в брошенном `RunnerError` и
// до хранилища не доезжает. Оператор, глядя на отклонённый прогон, видит «validation_error» и
// ничего больше — это отдельная находка, а не особенность этого теста.
//
// Поэтому различение причин доказывается СЛОЕМ НИЖЕ — в `actor-admission-prod-path.test.ts`, где
// `RunOutcome.validation.issues` доступен целиком, — а здесь доказывается доставка флага: прямыми
// утверждениями о `WorkerDeps` и поведением обеих дорог очереди.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { BacktestRunRequest, ModuleBundle } from '@trading/research-contracts';

import { AUTH, buildTestApp, testConfig } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { __resetTapeCachesForTest } from '../src/data/tape-cache.js';
import { strategyRunFlags } from '../src/jobs/worker.js';

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

/** Прогнать бандл через очередь и вернуть терминальное состояние строки. */
async function runThroughQueue(
  runId: string,
  bundleFile: string,
  opts: { readonly eventDrivenEnabled: boolean; readonly barLoopThread: boolean },
): Promise<{ status: string; terminalCode: string | null }> {
  __resetTapeCachesForTest();
  const bundle = loadBundle(bundleFile);
  const app = await buildTestApp({
    enableOverlayEngine: true,
    workerConcurrency: 1,
    eventDrivenEnabled: opts.eventDrivenEnabled,
    barLoopThread: opts.barLoopThread,
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
        // `moduleRef` ОБЯЗАН совпадать с манифестом бандла. Первая редакция брала его из
        // `baseline.json` — то есть просила legacy-модуль, приложив event-driven бандл. Воркер
        // отвергал такой прогон guard'ом несовпадения, а тест засчитывал это как отказ ДОПУСКА:
        // зелено по неверной причине, и перестало бы работать ровно тогда, когда допуск начнёт
        // пропускать.
        moduleRef: { id: bundle.manifest.id, version: bundle.manifest.version },
        metrics: ['pnl', 'win_rate'],
      },
    });
    expect(res.statusCode).toBe(202);
    expect(await app.drain()).toBe(1);

    const row = await app.store.get(runId);
    expect(row, `строка ${runId} не найдена`).toBeDefined();
    return { status: row!.status, terminalCode: row!.terminalCode ?? null };
  } finally {
    await app.dispose();
  }
}

describe('AppConfig → WorkerDeps: привязка ИСПОЛНЯЕТСЯ тестом, а не выводится из компиляции', () => {
  it('значение из конфига доезжает до WorkerDeps', async () => {
    // То самое звено, которое typecheck пропускает: поле объявлено везде, а строки
    // `eventDrivenEnabled: config.eventDrivenEnabled` в `buildApp` могло не быть — и всё бы
    // собралось. Ровно так жил `contextFreeze`.
    const on = await buildTestApp({ eventDrivenEnabled: true });
    try {
      expect(on.workerDeps.eventDrivenEnabled).toBe(true);
    } finally {
      await on.dispose();
    }

    const off = await buildTestApp({ eventDrivenEnabled: false });
    try {
      expect(off.workerDeps.eventDrivenEnabled).toBe(false);
    } finally {
      await off.dispose();
    }
  }, 60_000);

  it('дефолт конфига — выключено (dark launch)', () => {
    expect(testConfig().eventDrivenEnabled).toBe(false);
  });

  it('WorkerDeps → флаги прогона: значение доходит и туда', async () => {
    const app = await buildTestApp({ eventDrivenEnabled: true });
    try {
      expect(strategyRunFlags(app.workerDeps).eventDrivenEnabled).toBe(true);
    } finally {
      await app.dispose();
    }
  }, 60_000);

  it('ОДНА функция флагов на обе дороги — очередь и walk-forward', () => {
    // Раньше их было два списка, собранных руками, и они разошлись: `eventDrivenEnabled` был в
    // очереди и отсутствовал в walk-forward. Прогон по фолдам молча отверг бы event-driven
    // стратегию при включённой раскатке, а обычный прогон той же стратегии — допустил. Здесь
    // сравнивается ПОЛНЫЙ набор: забытое поле обвалит это сравнение, а не только своё.
    const deps = {
      eventDrivenEnabled: true,
      contextFreeze: false,
      barMajor: true,
      barMajorBatch: true,
      barBatching: true,
      batchBars: 16,
      universe: { enabled: true, maxN: 4, memBaseMb: 128, memPerSymbolMb: 8 },
    } as never;
    expect(strategyRunFlags(deps)).toEqual({
      barBatching: { maxBars: 16 },
      barMajor: true,
      barMajorBatch: true,
      universe: { enabled: true, maxN: 4, memBaseMb: 128, memPerSymbolMb: 8 },
      contextFreeze: false,
      eventDrivenEnabled: true,
    });
  });

  it('отсутствие остаётся отсутствием, а не превращается в false', () => {
    // `RunDeps` трактует отсутствие как «раскатка не выдана». Подстановка значения здесь сделала бы
    // поле неотличимым от «вызывающий ничего не просил».
    expect('eventDrivenEnabled' in strategyRunFlags({} as never)).toBe(false);
  });
});

describe('очередь: event-driven бандл не исполняется ни на одной дороге', () => {
  it(
    'прямая дорога: отвергается при ВЫКЛЮЧЕННОМ и при ВКЛЮЧЁННОМ флаге',
    async () => {
      // Оба значения, потому что срез fail-closed целиком: включённая раскатка сегодня не даёт
      // успешного прогона (нет проекции), но и не должна проваливать его в legacy.
      const off = await runThroughQueue('ed-off-direct', EVENT_DRIVEN, {
        eventDrivenEnabled: false,
        barLoopThread: false,
      });
      const on = await runThroughQueue('ed-on-direct', EVENT_DRIVEN, {
        eventDrivenEnabled: true,
        barLoopThread: false,
      });
      expect(off.status).not.toBe('completed');
      expect(on.status).not.toBe('completed');
      // Причину строка не несёт (см. шапку) — здесь проверяется исход, а не текст.
      expect(off.terminalCode).toBe('validation_error');
      expect(on.terminalCode).toBe('validation_error');
    },
    240_000,
  );

  it.skipIf(!THREAD_SEAM_LOADS)(
    'ПОТОКОВАЯ дорога ведёт себя так же',
    async () => {
      // Отдельная дорога и отдельный транспорт флага (structured clone через `ThreadRunFlags`).
      const off = await runThroughQueue('ed-off-thread', EVENT_DRIVEN, {
        eventDrivenEnabled: false,
        barLoopThread: true,
      });
      const on = await runThroughQueue('ed-on-thread', EVENT_DRIVEN, {
        eventDrivenEnabled: true,
        barLoopThread: true,
      });
      expect(off.status).not.toBe('completed');
      expect(on.status).not.toBe('completed');
    },
    300_000,
  );

  it(
    'LEGACY бандл при ВКЛЮЧЁННОМ флаге завершается как прежде',
    async () => {
      // Проверка проверки: без неё всё выше зеленело бы и на допуске, отвергающем что угодно, и на
      // сломанной очереди. Флаг обязан быть ИНЕРТЕН для `single_position` — это и есть разведение
      // осей: семантику выбирает манифест, флаг лишь разрешает раскатку.
      const t = await runThroughQueue('ed-legacy-on', LEGACY, {
        eventDrivenEnabled: true,
        barLoopThread: false,
      });
      expect(t.status).toBe('completed');
    },
    240_000,
  );
});
