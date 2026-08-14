// 083 S3 — THREAD E2E: actor-прогон ПРОД-ДОРОГОЙ. Срез вскрыл блокер, и файл фиксирует ЕГО.
//
// ═══ ЧТО СОБИРАЛИСЬ ДОКАЗАТЬ ═══
//
// Паритет прод-дороги с direct: тот же терминальный исход, те же артефакты, тот же timeline hash.
// Дорога здесь настоящая — HTTP `POST /v1/runs` → очередь → воркер → sandbox-исполнитель → строка
// в хранилище, — и между ней и `runBacktest` лежит всё, что можно потерять молча: конфиг →
// `WorkerDeps` → `StrategyRunDeps` → `RunDeps`, сериализация запроса, выбор исполнителя, поток со
// своим графом модулей.
//
// ═══ ЧТО ВЫЯСНИЛОСЬ ВМЕСТО ЭТОГО ═══
//
// ПРОД-ДОРОГА ЗАКРЫТА СПОСОБНОСТЬЮ ИСПОЛНИТЕЛЯ, А НЕ РИСКОМ. Так было не всегда: до риск-среза
// путь упирался в профиль — `DEFAULT_RISK` объявлял лимиты, которых actor-путь не соблюдал, и
// допуск отказывал fail-closed. Теперь профиль ИСПОЛНЯЕТСЯ (`risk.ts`), гейт совместимости его
// пропускает, и единственное, что закрывает эту дорогу, — выбранный для прогона исполнитель, не
// умеющий lifecycle актора.
//
// ПЕРВАЯ РЕДАКЦИЯ ЭТОГО ФАЙЛА УТВЕРЖДАЛА ШИРЕ И ПОТОМУ НЕТОЧНО: «все пять профилей». Пять — это
// список ЭКСПОРТОВ `profiles.ts`; четыре из них (`DCA_RISK`, `TIGHT_ADD_RISK`, `LONG_ONLY_RISK`,
// `TIGHT_STOP_RISK`) в реестр не входят и через прод-дорогу недостижимы вовсе. Гейт при этом
// проходил — каждое отдельное утверждение было истинным, ложной была картина, которую они рисуют
// вместе. Инвентарь обязан читаться из того же источника, из которого прогон берёт профиль.
//
// ═══ ДОЛГ, КОТОРЫЙ ЭТОТ ФАЙЛ КОГДА-ТО НАЗВАЛ, ЗАКРЫТ ═══
//
// `actor-e2e-direct` был зелен на профиле `NO_LIMITS`, сконструированном самим тестом и в реестре
// отсутствующем, — то есть доказывал семантику на конфигурации, недостижимой в проде. Риск-срез
// перевёл его на настоящий `default_risk@1.0.0`, и «сквозной прогон проходит» теперь читается
// ровно так, как есть.
//
// Файл по-прежнему не обходит оставшийся блокер подставным исполнителем: подставить его значило бы
// доказать паритет двух дорог на состоянии, в которое прод попасть не может.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { BacktestRunRequest, ModuleBundle } from '@trading/research-contracts';

import { AUTH, buildTestApp, testDeps } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { InMemoryArtifactStore } from '../src/artifacts/store.js';
import { __resetTapeCachesForTest } from '../src/data/tape-cache.js';
import { unsupportedRiskRules } from '../src/engine/actor/production.js';
import { DCA_RISK } from '../src/engine/profiles.js';
import { TRUSTED_REGISTRY_DEFINITION } from '../src/engine/registry-definition.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REQ = resolve(HERE, 'fixtures/overlay/requests');
const BUN = resolve(HERE, 'fixtures/overlay/bundles');

const loadRequest = (n: string): BacktestRunRequest =>
  JSON.parse(readFileSync(resolve(REQ, n), 'utf8')) as BacktestRunRequest;
const loadBundle = (n: string): ModuleBundle =>
  JSON.parse(readFileSync(resolve(BUN, n), 'utf8')) as ModuleBundle;

/** Поток грузит свой граф только под Node 24 (bt#201) — под 22 шов молча не соберётся. */
const THREAD_SEAM_LOADS = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10) >= 24;

/** Фикстура с ОБЪЯВЛЕННЫМ происхождением свечей — единственная, на которой допуск не закрывает путь. */
const DATASET = 'actor-thread-1m';
const FROM = '2023-11-14T22:13:00.000Z';
const TO = '2023-11-14T22:33:00.000Z';

/**
 * ПОЛНОЕ ожидаемое сообщение отказа, дословно.
 *
 * Целиком, а не фрагментом: обрезанное сообщение проходит `toMatch` и скрывает как потерю второй
 * половины («Деградация в onBarClose НЕ применяется»), так и подмену причины, начинающейся так же.
 */
const EXPECTED_REFUSAL =
  'исполнитель, выбранный для event_driven_probe@1.0.0, не умеет lifecycle актора ' +
  '(create → execute → dispose). Деградация в onBarClose НЕ применяется: это другая семантика.';

async function runThroughQueue(
  runId: string,
  opts: { readonly barLoopThread: boolean },
): Promise<{
  status: string;
  terminalCode: string | null;
  /** ЦЕЛИКОМ, а не выборка. См. комментарий у возврата. */
  terminalIssues: readonly unknown[];
}> {
  __resetTapeCachesForTest();
  const bundle = loadBundle('event-driven-probe.bundle.json');
  const app = await buildTestApp(
    {
      enableOverlayEngine: true,
      workerConcurrency: 1,
      eventDrivenEnabled: true,
      barLoopThread: opts.barLoopThread,
      overlaySandbox: { ...loadConfig().overlaySandbox, backend: 'isolate' },
    },
    testDeps({ artifactStore: new InMemoryArtifactStore() }),
  );
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
        datasetRef: DATASET,
        symbols: ['BTCUSDT'],
        timeframe: '1m',
        period: { from: FROM, to: TO },
        metrics: ['pnl'],
      },
    });
    expect(res.statusCode).toBe(202);
    expect(await app.drain()).toBe(1);
    const row = await app.store.get(runId);
    expect(row, `строка ${runId} не найдена`).toBeDefined();
    // `terminalCode` — ГРУБАЯ величина: `validation_error` склеивает несовместимые причины отказа.
    // Строить на нём утверждение о том, ЧТО именно закрыло путь, нельзя — ровно эту ошибку и
    // допустила первая редакция файла. Различает причины только `terminalIssues`.
    //
    // ВОЗВРАЩАЕТСЯ ЦЕЛИКОМ, И ЭТО ВТОРАЯ ПОПРАВКА ТОГО ЖЕ КЛАССА. Промежуточная редакция сокращала
    // issues до `issueCodes` + `firstMessage` — то есть снова проверяла выборочно, уже после того,
    // как выборочность была названа дефектом. Мимо такой проверки проходят: потерянный `path: ''`
    // (нормативная ссылка на запрос целиком), изменённая `severity`, обрезанное сообщение, лишний
    // второй issue и любое различие direct/thread за пределами первого сообщения.
    return {
      status: row!.status,
      terminalCode: row!.terminalCode ?? null,
      terminalIssues: (row!.terminalIssues ?? []) as readonly unknown[],
    };
  } finally {
    await app.dispose();
  }
}

describe('БЛОКЕР: риск-контур закрывает actor-путь для ВСЕХ зарегистрированных профилей', () => {
  // ЧИТАЕТСЯ КАНОНИЧЕСКИЙ РЕЕСТР, А НЕ СПИСОК ЭКСПОРТОВ. Первая редакция перечисляла пять
  // профилей из `profiles.ts` — и утверждала не то, что нужно: зарегистрирован ТОЛЬКО
  // `DEFAULT_RISK`, остальные четыре экспортируются, но членами `TRUSTED_REGISTRY_DEFINITION` не
  // являются и через прод-дорогу недостижимы вовсе. Гейт при этом проходил: утверждение было
  // истинным про каждый профиль по отдельности и ложным про то, что оно якобы описывает состояние
  // прода. Здесь источник один — тот же, из которого прогон берёт профиль по `riskProfileRef`.

  it('СОСТАВ реестра зафиксирован: добавление профиля обязано быть замечено', () => {
    // Без этого утверждения проверка ниже молча ослабла бы при добавлении профиля без лимитов:
    // «ни один не проходит» осталось бы истинным ровно до того момента, когда появится проходящий,
    // и никто бы не заметил, что список вырос.
    expect(TRUSTED_REGISTRY_DEFINITION.riskProfiles.map((p) => `${p.id}@${p.version}`)).toEqual([
      'default_risk@1.0.0',
    ]);
  });

  it('КАЖДЫЙ зарегистрированный профиль исполним actor-путём', () => {
    // Утверждение развёрнуто на 180°, и это и есть содержание риск-среза. Прежде здесь стояло «не
    // проходит ни один» — верное описание системы БЕЗ риск-контура.
    //
    // Проверяется весь реестр, а не `DEFAULT_RISK` поимённо: профиль, добавленный завтра с
    // правилом, которого actor-путь не исполняет, обязан покрасить именно эту строку — до того,
    // как прогон под ним посчитается свободнее, чем разрешено.
    const unsupported = TRUSTED_REGISTRY_DEFINITION.riskProfiles
      .map((p) => ({ ref: `${p.id}@${p.version}`, rules: unsupportedRiskRules(p as never) }))
      .filter((r) => r.rules.length > 0);
    expect(unsupported).toEqual([]);
  });

  it('ПРОВЕРКА ПРОВЕРКИ: неисполнимый профиль был бы отвергнут — гейт не пропускает всё подряд', () => {
    // Иначе утверждение выше зеленело бы и у функции, возвращающей пустой список всегда, то есть
    // доказывало бы «actor-путь принимает любой профиль» — другой и куда более опасный факт.
    expect(unsupportedRiskRules(DCA_RISK as never)).toEqual(['dcaLimits', 'scaleInLimits']);
  });
});

// РИСК-БЛОКЕР ЗДЕСЬ НЕ ДОКАЗЫВАЕТСЯ, и это осознанно.
//
// Прод-дорога до него не доходит: путь закрывается раньше, на способности исполнителя (см. набор
// ниже). Доказать его можно только через actor-capable исполнителя — но такое доказательство
// утверждало бы «DEFAULT_RISK отвергает actor-прогон», то есть ровно то состояние, которое
// СЛЕДУЮЩИЙ подсрез S3 (actor-семантика DEFAULT_RISK: clamp/reject/riskDecisions) отменяет по
// построению. Проба прожила бы один срез и была бы удалена вместе с ним.
//
// Поэтому доказательство переносится в risk-срез, где оно становится ПОЗИТИВНЫМ: не «отвергает»,
// а «клампит, отклоняет и записывает riskDecisions». Там же `actor-e2e-direct` обязан переехать с
// самодельного NO_LIMITS на настоящий DEFAULT_RISK — сейчас он зелен на конфигурации, в которую
// прод попасть не может.

describe.runIf(THREAD_SEAM_LOADS)('прод-дорога: обе транспортные ветки дают ОДИН исход', () => {
  // Паритет по терминальному исходу проверяется на том состоянии, в котором система находится
  // СЕЙЧАС. Он содержателен и в таком виде: транспорт не вправе менять исход, и если поток начнёт
  // отвечать иначе, чем прямая ветка, это будет видно здесь — независимо от того, отказ это или
  // завершение.
  it('поток и прямая ветка отвергают прогон одинаково — вплоть до полной причины', async () => {
    // ПОСЛЕДОВАТЕЛЬНО, а не `Promise.all`. Первая редакция запускала оба приложения параллельно, и
    // это дало недетерминизм: один прогон возвращал ПУСТОЙ `terminalIssues` при непустом у
    // второго. Два `buildTestApp` в одном процессе делят кэш ленты (`__resetTapeCachesForTest`
    // сбрасывает его глобально) и временные каталоги — то есть параллельный запуск проверял бы не
    // паритет транспортов, а живучесть тестовой обвязки. Заметить это позволило только точное
    // сравнение полных причин: на сокращённой выборке расхождение выглядело бы так же, как
    // совпадение.
    const thread = await runThroughQueue('thr-parity-thread', { barLoopThread: true });
    const direct = await runThroughQueue('thr-parity-direct', { barLoopThread: false });
    // Сравниваются ПОЛНЫЕ причины, а не их коды: транспорт не вправе изменить ни severity, ни
    // path, ни текст, ни ЧИСЛО issues. Расхождение за пределами первого сообщения — это ровно то,
    // что выборочная проверка пропускала бы.
    expect(thread.terminalIssues).toEqual(direct.terminalIssues);
    expect(thread).toEqual(direct);
  });

  it('причина совпадает с ожидаемой ЦЕЛИКОМ — severity, code, message, path', async () => {
    // ЭТА ПРОБА ЗАМЕНЯЕТ ВАКУУМНУЮ. Прежняя редакция утверждала `terminalCode: 'validation_error'`
    // и называла это «исход, предписанный риск-блокером». Утверждение проходило и не значило
    // ничего: `validation_error` склеивает несовместимые причины, а риск-контур до проверки даже
    // не доходит — путь закрывается РАНЬШЕ, на способности исполнителя.
    //
    // Сравнение ТОЧНОЕ и по всему массиву. Отдельная проверка «а не риск ли это» после него не
    // нужна: полная ожидаемая причина исключает любую подмену по построению — чужая причина не
    // совпадёт ни сообщением, ни кодом. `path: ''` при этом не деталь форматирования, а
    // нормативная ссылка на запрос целиком (RFC 6901 §5): нарушающего узла у этого отказа нет,
    // запрос корректен, не совпадает окружение.
    const thread = await runThroughQueue('thr-blocked', { barLoopThread: true });
    expect(thread.terminalIssues).toEqual([
      { severity: 'error', code: 'unsupported_lifecycle', message: EXPECTED_REFUSAL, path: '' },
    ]);
  });
});
