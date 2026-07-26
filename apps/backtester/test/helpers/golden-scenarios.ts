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
 * Ключи артефактов, которые Ф3 добавила к ФОРМЕ выхода. Сегодня один: `Trade.synthetic`.
 *
 * Ядро помечает принудительное end-of-data закрытие (SSOT решение 5) явным маркером
 * `synthetic: 'end_of_data'`, вместо того чтобы заставлять потребителя выводить синтетичность из
 * `closeReason`. Донор такого ключа не писал. Это расхождение ФОРМЫ, а не поведения: ни одно
 * число — цена, размер, комиссия, realizedPnl, equity — не сдвинулось (проверено структурным diff'ом
 * до-Ф3 и после-Ф3 payload'ов: 13 расходящихся путей, все три вида добавленных ключей и ничего
 * больше). Именно такие изменения и обязана версионировать `evidenceFormatVersion`.
 */
export const F3_ARTIFACT_SHAPE_FIELDS = ['synthetic'] as const;

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
  if (Array.isArray(payload)) return payload.map(projectToPreF3Shape);
  if (!isRecord(payload)) return payload;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (k === 'evidence' && isRecord(v)) {
      const evidence: Record<string, unknown> = { ...v };
      for (const field of F3_EVIDENCE_IDENTITY_FIELDS) delete evidence[field];
      out[k] = projectToPreF3Shape(evidence);
      continue;
    }
    if ((F3_ARTIFACT_SHAPE_FIELDS as readonly string[]).includes(k)) continue;
    out[k] = projectToPreF3Shape(v);
  }
  return out;
}

/**
 * Клон payload'а с откатом ТОЛЬКО `evidence.contractVersion` к legacy-значению. Обход рекурсивный:
 * у overlay-прогона evidence лежит и в `baseline`, и в `variant`, и оба обязаны откатиться —
 * иначе доказательство было бы частичным.
 */
export function projectToLegacyContractVersion(payload: unknown): unknown {
  if (Array.isArray(payload)) return payload.map(projectToLegacyContractVersion);
  if (!isRecord(payload)) return payload;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (k === 'evidence' && isRecord(v) && v.contractVersion === ACTIVE_CONTRACT_VERSION) {
      out[k] = { ...v, contractVersion: LEGACY_CONTRACT_VERSION };
      continue;
    }
    out[k] = projectToLegacyContractVersion(v);
  }
  return out;
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
  const activePayload = projectToPreF3Shape(payload);
  const legacyPayload = projectToLegacyContractVersion(activePayload);
  return {
    id: '',
    activeHash: contentRef(activePayload),
    legacyHash: contentRef(legacyPayload),
    diffPaths: structuralDiffPaths(legacyPayload, activePayload),
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
  const preF3Payload = projectToPreF3Shape(payload);
  return {
    activeHash: contentRef(payload),
    preF3Hash: contentRef(preF3Payload),
    diffPaths: structuralDiffPaths(preF3Payload, payload),
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
