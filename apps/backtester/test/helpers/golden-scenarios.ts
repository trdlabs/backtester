// Единый реестр committed result-голденов и доказательство их миграции 017.2 → 017.3.
//
// Почему реестр существует. Голдены раньше назывались «platform-derived» и ссылались на
// `scripts/derive_slice6a_goldens.mjs` в trading-platform. Этого скрипта там больше нет: 041 удалил
// из платформы research/backtest-движок (`src/research`, `runBacktest`), так что вывести их оттуда
// нельзя ни сейчас, ни впредь. Владелец execution/result-голденов — backtester; после Ф2
// инициативы `shared-execution-engine` он перейдёт к `@trdlabs/engine`. Платформа владеет только
// contract acceptance gates (`verify_083_e1_contract_anchor`, `verify_017_taxonomy`).
//
// Почему голдены сдвинулись. `runner.ts` кладёт `CONTRACT_VERSION` в `RunEvidence`, а evidence
// входит в canonical payload прогона — значит бамп `017.2 → 017.3` меняет content-hash КАЖДОГО
// прогона. Исключать `contractVersion` из хеша нельзя: identity прогона обязана включать версию
// контракта, по которому он исполнен. Поэтому голдены перебазируются, но не «потому что так
// вышло», а под доказательство: `proveContractVersionMigration` показывает, что старый хеш
// восстанавливается из нового ровно откатом одного поля, и различие — ТОЛЬКО в нём.

import { readFileSync } from 'node:fs';
import { contentRef } from '../../src/determinism/hash.js';

import { runBacktest } from '../../src/engine/runner.js';
import { makeMultiSymbolDeps, makeRequest } from './bar-major-fixture.js';
import { loadOverlayRequest, overlayGoldenDeps, runOverlayGolden } from './overlay-golden-fixture.js';

/** Версия, на которой голдены были заморожены до 083 E1. */
export const LEGACY_CONTRACT_VERSION = '017.2';
/** Версия, ратифицированная платформой (`verify_083_e1_contract_anchor`). */
export const ACTIVE_CONTRACT_VERSION = '017.3';

/**
 * Версия, под которой голдены лежали на диске до 083 S1, — то есть голова цепи до этой миграции.
 * Численно равна `ACTIVE_CONTRACT_VERSION`, но это РАЗНЫЕ утверждения, и сливать их в одну
 * константу нельзя: та обозначает «куда пришло звено 017.2 → 017.3», эта — «откуда уходит звено
 * 017.3 → 017.4». Следующая миграция сдвинет вторую и не тронет первую.
 */
export const PRE_S1_CONTRACT_VERSION = '017.3';
/** Версия, введённая 083 S1 вместе с актор-контрактом. Её эмитит свежий прогон. */
export const S1_CONTRACT_VERSION = '017.4';
/** Голова цепи после Д3: контракт с preflight. Звено `017.4 → 017.5`. */
export const PRE_D3_CONTRACT_VERSION = '017.4';
export const D3_CONTRACT_VERSION = '017.5';
/**
 * Голова цепи после 083 S3 ступени 1: привязка требования к инструменту стала размеченным
 * объединением. Звено `017.5 → 017.6`.
 *
 * `PRE_S3_CONTRACT_VERSION` численно равна `D3_CONTRACT_VERSION`, и это опять РАЗНЫЕ утверждения:
 * та говорит «куда пришло звено 017.4 → 017.5», эта — «откуда уходит звено 017.5 → 017.6».
 */
export const PRE_S3_CONTRACT_VERSION = '017.5';
export const S3_CONTRACT_VERSION = '017.6';

/** Один воспроизводимый сценарий, чей canonical payload заморожен как golden. */
export interface GoldenScenario {
  /** Стабильный ключ в mapping-фикстуре. */
  readonly id: string;
  /** Где лежит активный (017.3) хеш — для сообщений и для `--write`. */
  readonly goldenSource: string;
  /** Прогнать сценарий и вернуть РОВНО тот payload, который хешируется. */
  run(): Promise<unknown>;
}

/**
 * Реестр. Только in-process сценарии: голден — это ЗНАЧЕНИЕ хеша, и оно не зависит от того, через
 * какой исполнитель прогон прошёл. Docker-твины (trusted ≡ sandbox) сверяют два свежих прогона
 * между собой, а не с committed-значением, поэтому переезда не требуют — и остаются независимой
 * проверкой того, что перебазировка не спрятала расхождение исполнителей.
 */
export const GOLDEN_SCENARIOS: readonly GoldenScenario[] = [
  {
    id: 'overlay-baseline',
    goldenSource: 'apps/backtester/test/fixtures/overlay/goldens/baseline.hash',
    run: async () => {
      const req = loadOverlayRequest('baseline.json');
      return runOverlayGolden(req, await overlayGoldenDeps(req));
    },
  },
  {
    id: 'overlay-variant',
    goldenSource: 'apps/backtester/test/fixtures/overlay/goldens/variant.hash',
    run: async () => {
      const req = loadOverlayRequest('variant.json');
      return runOverlayGolden(req, await overlayGoldenDeps(req));
    },
  },
  {
    id: 'bar-major',
    goldenSource: 'apps/backtester/test/helpers/bar-major-golden-hash.ts',
    run: async () => {
      const out = await runBacktest(
        makeRequest(['BTCUSDT', 'ETHUSDT']),
        makeMultiSymbolDeps({ barMajor: true }),
      );
      if (out.status !== 'completed') {
        throw new Error(`bar-major scenario did not complete: ${JSON.stringify(out)}`);
      }
      return out.baseline;
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Миграционное доказательство.
// ─────────────────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Поля идентичности прогона, которые Ф3 добавила в `RunEvidence` (решение владельца (A)). */
export const F3_EVIDENCE_IDENTITY_FIELDS = ['evidenceFormatVersion', 'engineVersion'] as const;

/**
 * Ключи, которые Ф3 добавила к ФОРМЕ выхода, — вместе с КОНТЕЙНЕРОМ, в котором они разрешены.
 * Сегодня запись одна: `synthetic` внутри элемента массива `trades`.
 *
 * Ядро помечает принудительное end-of-data закрытие (SSOT решение 5) явным маркером
 * `synthetic: 'end_of_data'`, вместо того чтобы заставлять потребителя выводить синтетичность из
 * `closeReason`. Донор такого ключа не писал. Это расхождение ФОРМЫ, а не поведения: ни одно
 * число — цена, размер, комиссия, realizedPnl, equity — не сдвинулось (проверено структурным diff'ом
 * до-Ф3 и после-Ф3 payload'ов: 13 расходящихся путей, все три вида добавленных ключей и ничего
 * больше). Именно такие изменения и обязана версионировать `evidenceFormatVersion`.
 *
 * Почему привязка к контейнеру, а не просто имя ключа: снятие `synthetic` ВЕЗДЕ означало бы, что
 * доказательство молча проглотит появление такого же ключа в любом другом месте payload'а — то
 * есть перестанет ловить ровно тот дрейф, ради которого существует. Allowlist обязан быть узким.
 */
export const F3_ARTIFACT_SHAPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  trades: ['synthetic'],
};

/**
 * Клон payload'а БЕЗ полей идентичности, добавленных Ф3 — то есть ровно та форма evidence, которая
 * была до переезда на `@trdlabs/engine`. Это база обоих доказательств:
 *
 *  • Ф3-пруф требует, чтобы хеш этой проекции совпал с ДО-Ф3 голденом. Совпал — значит переезд
 *    исполнительного ядра не сдвинул ни одного байта payload'а, кроме двух новых полей: это и есть
 *    extraction-equivalence, доказанная, а не заявленная.
 *  • 017-пруф (`proveContractVersionMigration`) продолжает работать на этой же проекции, поэтому
 *    его историческое утверждение «откат одного поля восстанавливает 017.2» остаётся проверяемым
 *    и после Ф3, а не тихо протухает.
 */
export function projectToPreF3Shape(payload: unknown): unknown {
  if (Array.isArray(payload)) return payload.map((item) => projectToPreF3Shape(item));
  if (!isRecord(payload)) return payload;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (k === 'evidence' && isRecord(v)) {
      const evidence: Record<string, unknown> = { ...v };
      for (const field of F3_EVIDENCE_IDENTITY_FIELDS) delete evidence[field];
      out[k] = projectToPreF3Shape(evidence);
      continue;
    }
    const shapeFields = F3_ARTIFACT_SHAPE_FIELDS[k];
    if (shapeFields !== undefined && Array.isArray(v)) {
      // Снимаем добавленные Ф3 ключи ТОЛЬКО у элементов объявленного контейнера. Одноимённый ключ
      // где-либо ещё остаётся в проекции и, если появится, честно провалит доказательство.
      out[k] = v.map((item) => {
        const projected = projectToPreF3Shape(item);
        if (!isRecord(projected)) return projected;
        const stripped: Record<string, unknown> = { ...projected };
        for (const field of shapeFields) delete stripped[field];
        return stripped;
      });
      continue;
    }
    out[k] = projectToPreF3Shape(v);
  }
  return out;
}

/**
 * Клон payload'а, в котором `evidence.contractVersion === from` заменён на `to`. Обход рекурсивный:
 * у overlay-прогона evidence лежит и в `baseline`, и в `variant`, и оба обязаны пройти — иначе
 * доказательство было бы частичным.
 *
 * Параметрическая, а не зашитая на одну пару: цепь миграций растёт (017.2 → 017.3 → Ф3 → 017.4),
 * и каждому звену нужна та же операция для своей пары, а историческим пруфам — нормализация входа
 * к своей эпохе, иначе их якоря уезжают вместе с версией и перестают что-либо утверждать.
 *
 * Сопоставление по `from`, а не безусловная запись: узел, стоящий на другой версии, — это не то,
 * что мигрируют, а сигнал, что payload собран из разных источников. Молча выровнять его значило бы
 * стереть ровно тот сигнал, ради которого доказательство существует.
 */
export function projectContractVersion(payload: unknown, from: string, to: string): unknown {
  if (Array.isArray(payload)) return payload.map((item) => projectContractVersion(item, from, to));
  if (!isRecord(payload)) return payload;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (k === 'evidence' && isRecord(v) && v.contractVersion === from) {
      out[k] = { ...v, contractVersion: to };
      continue;
    }
    out[k] = projectContractVersion(v, from, to);
  }
  return out;
}

/**
 * Историческое звено 017.2 → 017.3. Сохранено обёрткой, чтобы смысл существующих вызовов и их
 * читаемость не поменялись от того, что операция стала параметрической.
 */
export function projectToLegacyContractVersion(payload: unknown): unknown {
  return projectContractVersion(payload, ACTIVE_CONTRACT_VERSION, LEGACY_CONTRACT_VERSION);
}

/**
 * Нормализация свежего прогона к эпохе 017.3 — общий вход обоих ИСТОРИЧЕСКИХ доказательств.
 *
 * Их якоря заморожены тогда, когда в evidence стояла 017.3. Свежий прогон эмитит 017.4, и без
 * нормализации каждый такой якорь уезжал бы вместе с версией при каждом следующем бампе — то есть
 * звенья цепи протухали бы молча, продолжая «проходить». Идемпотентна: payload, уже стоящий на
 * 017.3, не меняется (сопоставление идёт по `from`).
 */
export function atPreS1Contract(payload: unknown): unknown {
  return projectContractVersion(payload, S1_CONTRACT_VERSION, PRE_S1_CONTRACT_VERSION);
}

/**
 * Нормализация свежего прогона к эпохе 017.4 — общий вход ОБОИХ исторических звеньев.
 *
 * Та же причина, по которой существует `atPreS1Contract`, только на одно звено позже. Якоря
 * звеньев 017.2→017.3 и 017.3→017.4 заморожены в эпохах, где в evidence стояли 017.3 и 017.4;
 * свежий прогон эмитит 017.5, и без этой нормализации оба якоря уехали бы вместе с версией, а
 * звенья продолжали бы «проходить», ничего не утверждая.
 *
 * Стоит ЗДЕСЬ, а не у вызывающих: так её нельзя забыть ни в тесте, ни в дериваторе. Снятие
 * нормализации обязано КРАСНИТЬ старые звенья — это проверяется отдельно.
 */
export function atPreD3Contract(payload: unknown): unknown {
  return projectContractVersion(payload, D3_CONTRACT_VERSION, PRE_D3_CONTRACT_VERSION);
}

/**
 * Нормализация свежего прогона к эпохе 017.5 — общий вход ВСЕХ трёх исторических звеньев.
 *
 * Та же причина, что у двух соседей выше, ещё на одно звено позже: якоря звеньев 017.2→017.3,
 * 017.3→017.4 и 017.4→017.5 заморожены в своих эпохах, а свежий прогон эмитит 017.6. Без этого
 * шага уехали бы ВСЕ якоря разом, и три звена продолжали бы «проходить», ничего не утверждая.
 *
 * Композиция нормализаций читается справа налево: самая новая применяется первой. Каждое новое
 * звено дописывает ровно один шаг в начало цепочки у каждого исторического пруфа.
 */
export function atPreS3Contract(payload: unknown): unknown {
  return projectContractVersion(payload, S3_CONTRACT_VERSION, PRE_S3_CONTRACT_VERSION);
}

/** Все JSON-pointer пути, по которым два canonical payload'а различаются. */
export function structuralDiffPaths(a: unknown, b: unknown, base = ''): readonly string[] {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return [base || '/'];
    return a.flatMap((x, i) => structuralDiffPaths(x, b[i], `${base}/${i}`));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    return keys.flatMap((k) => structuralDiffPaths(a[k], b[k], `${base}/${k}`));
  }
  return Object.is(a, b) ? [] : [base || '/'];
}

/** Исход доказательства для одного сценария. */
export interface MigrationProof {
  readonly id: string;
  /** Хеш свежего прогона под ратифицированной версией. */
  readonly activeHash: string;
  /** Хеш того же прогона с откаченным `evidence.contractVersion`. */
  readonly legacyHash: string;
  /** Пути, по которым active и legacy расходятся. */
  readonly diffPaths: readonly string[];
}

/**
 * Доказать, что расхождение голдена вызвано РОВНО бампом версии контракта, а не дрейфом движка.
 *
 * Откатываем в свежем результате одно поле и требуем, чтобы хеш совпал с замороженным на 017.2.
 * Совпал — значит всё остальное в payload'е байт-в-байт прежнее, и перебазировка безопасна.
 * Не совпал — значит вместе с версией уехало что-то ещё, и перебазировка спрятала бы регрессию.
 */
export function proveContractVersionMigration(payload: unknown): MigrationProof & { id: string } {
  // Ф3: доказательство ведётся на ДО-Ф3 проекции evidence. Иначе бамп идентичности прогона
  // (решение (A)) утащил бы за собой исторический 017-пруф, и тот перестал бы что-либо утверждать.
  //
  // 083 S1: и на нормализованной к 017.3 версии — по той же причине. Оба якоря этого звена
  // (`legacy` = 017.2, `active` = 017.3) заморожены в эпохе, где в evidence стояла 017.3; свежий
  // прогон эмитит 017.4, и без нормализации оба хеша уехали бы вместе с версией, а звено молча
  // перестало бы что-либо доказывать. Нормализация стоит ЗДЕСЬ, а не у вызывающих: так её нельзя
  // забыть ни в тесте, ни в дериваторе.
  // 083 S3: и к 017.5 — тот же довод ещё на одно звено позже.
  const activePayload = projectToPreF3Shape(
    atPreS1Contract(atPreD3Contract(atPreS3Contract(payload))),
  );
  const legacyPayload = projectToLegacyContractVersion(activePayload);
  return {
    id: '',
    activeHash: contentRef(activePayload),
    legacyHash: contentRef(legacyPayload),
    diffPaths: structuralDiffPaths(legacyPayload, activePayload),
  };
}

/**
 * Доказать, что сдвиг committed-голдена вызван РОВНО бампом 017.3 → 017.4 (083 S1), а не дрейфом
 * движка. Голова цепи миграций.
 *
 * Отличие от двух звеньев выше принципиальное: те ведутся на ПРОЕКЦИЯХ (017-пруф — на до-Ф3 форме,
 * Ф3-пруф — на ней же), потому что их якоря заморожены в тех эпохах. Это звено ведётся на ПОЛНОМ
 * payload'е без проекций: на диске лежит хеш полного payload'а, и сравнивать надо величину той же
 * природы. Сверять проекцию с файлом голдена нельзя — ровно эту ошибку уже ловили в
 * `derive_goldens.mjs` (см. «ПОПРАВКА ПОСЛЕ Ф3» в его шапке): такая проверка не могла пройти ни
 * при каких значениях.
 *
 * `legacyHash` обязан совпасть с тем, что лежит на диске СЕЙЧАС, то есть с `active` Ф3-карты.
 * Совпал — значит весь payload, кроме одной строки версии, байт-в-байт прежний.
 */
export function proveS1ContractMigration(payload: unknown): MigrationProof {
  // Нормализация к 017.4 — по той же причине, что и в звене выше: якоря этого
  // звена заморожены в эпохе 017.4, а свежий прогон эмитит 017.5.
  const atS1 = atPreD3Contract(atPreS3Contract(payload));
  const legacyPayload = projectContractVersion(atS1, S1_CONTRACT_VERSION, PRE_S1_CONTRACT_VERSION);
  return {
    id: '',
    activeHash: contentRef(atS1),
    legacyHash: contentRef(legacyPayload),
    diffPaths: structuralDiffPaths(legacyPayload, atS1),
  };
}

/**
 * Звено Д3: `017.4 → 017.5`. Свежий payload И ЕСТЬ active — нормализовать его здесь нечем и
 * незачем, эта версия и есть голова цепи.
 */
export function proveD3ContractMigration(payload: unknown): MigrationProof {
  // 083 S3: это звено БОЛЬШЕ НЕ ГОЛОВА. Прежде свежий payload и был его `active` — теперь свежий
  // прогон эмитит 017.6, и `active` этого звена получается нормализацией к 017.5. Пропустить её
  // значило бы утверждать, что якорь эпохи 017.5 равен хешу payload'а другой эпохи.
  const atD3 = atPreS3Contract(payload);
  const legacyPayload = atPreD3Contract(atD3);
  return {
    id: '',
    activeHash: contentRef(atD3),
    legacyHash: contentRef(legacyPayload),
    diffPaths: structuralDiffPaths(legacyPayload, atD3),
  };
}

/**
 * Звено 083 S3 ступени 1: `017.5 → 017.6`. НОВАЯ ГОЛОВА цепи.
 *
 * Свежий payload И ЕСТЬ `active` — нормализовать его здесь нечем и незачем, эта версия и есть
 * голова. Ровно так же выглядело звено Д3, пока головой было оно.
 */
export function proveS3ContractMigration(payload: unknown): MigrationProof {
  const legacyPayload = atPreS3Contract(payload);
  return {
    id: '',
    activeHash: contentRef(payload),
    legacyHash: contentRef(legacyPayload),
    diffPaths: structuralDiffPaths(legacyPayload, payload),
  };
}

/** Исход Ф3-доказательства для одного сценария. */
export interface ExtractionProof {
  /** Хеш свежего прогона на `@trdlabs/engine` — это и есть новый committed golden. */
  readonly activeHash: string;
  /** Хеш того же прогона с откаченной идентичностью Ф3 — обязан совпасть с ДО-Ф3 голденом. */
  readonly preF3Hash: string;
  /** Пути, по которым active и pre-Ф3 расходятся. */
  readonly diffPaths: readonly string[];
}

/**
 * Доказать, что перебазировка голдена вызвана РОВНО материализацией run identity (A), а не дрейфом
 * исполнительного ядра при переезде на `@trdlabs/engine`.
 *
 * Убираем из свежего результата два новых поля evidence и требуем, чтобы хеш совпал с замороженным
 * до Ф3. Совпал — значит весь остальной payload (ордера, филлы, risk-решения, сделки, equity)
 * байт-в-байт прежний: извлечённое ядро эквивалентно донорскому на этих фикстурах.
 */
export function proveEngineExtraction(payload: unknown): ExtractionProof {
  // 083 S1: оба якоря Ф3-звена (`legacy` = до-Ф3, `active` = после-Ф3) заморожены в эпохе 017.3.
  // Свежий прогон эмитит 017.4, поэтому вход нормализуется — иначе сдвинулись бы ОБА, включая
  // `legacy`, то есть исторический якорь донорского значения, и доказательство эквивалентности
  // извлечения превратилось бы в самоссылку. Нормализация внутри функции по той же причине, что
  // и у соседа: вызывающий не должен иметь возможности её пропустить.
  // Д3: и к 017.4 — по той же причине на одно звено позже. Свежий прогон эмитит 017.5, и без
  // этого шага уехали бы ОБА якоря Ф3-звена, включая исторический `legacy`. Исторические хеши
  // Ф3 при этом НЕ меняются — меняется только то, к какой эпохе приводится свежий payload.
  // 083 S3: ещё один шаг по той же причине — свежий прогон эмитит 017.6.
  const at0173 = atPreS1Contract(atPreD3Contract(atPreS3Contract(payload)));
  const preF3Payload = projectToPreF3Shape(at0173);
  return {
    activeHash: contentRef(at0173),
    preF3Hash: contentRef(preF3Payload),
    diffPaths: structuralDiffPaths(preF3Payload, at0173),
  };
}

/** Прочитать committed-хеш по пути `goldenSource` (файл `.hash` либо TS-константа). */
export function readCommittedGolden(repoRoot: string, goldenSource: string): string {
  const raw = readFileSync(`${repoRoot}/${goldenSource}`, 'utf8');
  if (goldenSource.endsWith('.hash')) return raw.trim();
  const m = /sha256:[0-9a-f]{64}/.exec(raw);
  if (m === null) throw new Error(`no sha256 constant found in ${goldenSource}`);
  return m[0];
}
