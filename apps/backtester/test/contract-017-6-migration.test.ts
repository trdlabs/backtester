// Доказательство миграции result-голденов 017.5 → 017.6 (083 S3, ступень 1 multi-symbol).
//
// Голова цепи. Утверждает ровно три вещи, и каждая проверяема:
//   1. `legacy` этого звена — committed-голден ПРЕДЫДУЩЕЙ эпохи: он равен `active` предыдущего
//      звена, и цепь замкнута явно, а не «по построению». На диске его больше нет — с момента
//      перебазировки файл содержит `active` ЭТОГО звена. Путать две величины нельзя: ровно на
//      такой путанице предыдущий дериватор сравнивал проекцию с полным payload'ом;
//   2. `active` равен свежему 017.5-прогону — и он же лежит в файле голдена;
//   3. единственное расхождение — `evidence.contractVersion`.
//
// Причина сдвига НАЗВАНА: 017.6 отличается от 017.5 ровно новой ВЕТВЬЮ привязки требования к
// инструменту (`symbolFrom: 'actor'`), которой ни один из этих сценариев не пользуется — их
// манифесты остались на фиксированной ветви. Значит в payload'е меняться нечему кроме строки
// версии, и откат ниже это доказывает, а не принимает на слово.
//
// На том же шаге приехали два минора SDK (0.20.0 — оракул result-digest, 0.21.0 — candle-origin) и
// движок 0.18.0. Оба минора живут в подпути `@trdlabs/sdk/historical`, который движок не
// импортирует; в канонический payload оттуда не попадает ничего. Откат проверяет и это.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GOLDEN_SCENARIOS,
  PRE_S3_CONTRACT_VERSION,
  S3_CONTRACT_VERSION,
  projectContractVersion,
  proveS3ContractMigration,
  readCommittedGolden,
  structuralDiffPaths,
} from './helpers/golden-scenarios.js';
import { headActive } from './helpers/migration-chain.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Общий читатель карт для производных от цепи: помощник не знает, как тест читает файлы. */
const readJson = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'));

/**
 * Значение, которое ОБЯЗАНО лежать в файле голдена, — `active` ГОЛОВЫ цепи.
 *
 * Раньше здесь стояла карта «следующего» звена, прочитанная по зашитому пути. Это верно ровно
 * пока следующий и есть голова; появление нового звена делает утверждение ложным у ВСЕХ
 * исторических пруфов разом. Теперь голова выводится из `MIGRATION_CHAIN`, и добавление звена
 * не требует правки ни одного теста.
 */
const onDiskFor = (scenarioId: string): string => headActive(REPO_ROOT, scenarioId, readJson);

interface Entry {
  readonly scenario: string;
  readonly source: string;
  readonly legacy: string;
  readonly active: string;
  readonly diffPaths: readonly string[];
}

const hashMap = JSON.parse(
  readFileSync(resolve(REPO_ROOT, 'apps/backtester/test/fixtures/017-6-migration/hash-map.json'), 'utf8'),
) as { contract: { from: string; to: string }; goldens: Record<string, Entry> };

/** Предыдущее звено цепи: Д3, бамп контракта 017.4 → 017.5. */
const prevHashMap = JSON.parse(
  readFileSync(
    resolve(REPO_ROOT, 'apps/backtester/test/fixtures/017-5-migration/hash-map.json'),
    'utf8',
  ),
) as { goldens: Record<string, Entry> };

describe('017.5 → 017.6 golden migration proof', () => {
  it('mapping fixture records the ratified version pair', () => {
    expect(hashMap.contract).toEqual({ from: PRE_S3_CONTRACT_VERSION, to: S3_CONTRACT_VERSION });
    expect(Object.keys(hashMap.goldens).sort()).toEqual(GOLDEN_SCENARIOS.map((s) => s.id).sort());
  });

  for (const scenario of GOLDEN_SCENARIOS) {
    describe(scenario.id, () => {
      it('rolling back evidence.contractVersion reproduces the 017.5 golden exactly', async () => {
        const proof = proveS3ContractMigration(await scenario.run());
        // Если это падает — вместе с версией контракта уехало что-то ещё, и перебазировка хеша
        // скрыла бы регрессию движка.
        expect(proof.legacyHash).toBe(hashMap.goldens[scenario.id].legacy);
      });

      it('differs from the 017.5 projection ONLY at evidence.contractVersion', async () => {
        const proof = proveS3ContractMigration(await scenario.run());
        expect(proof.diffPaths.length).toBeGreaterThan(0);
        for (const path of proof.diffPaths) expect(path).toMatch(/\/evidence\/contractVersion$/);
        expect([...proof.diffPaths].sort()).toEqual([...hashMap.goldens[scenario.id].diffPaths].sort());
      });

      it('the chain is unbroken: this link starts where the 017.5 link ended', () => {
        // Звено начинается ровно там, где кончилось предыдущее. Без этой сцепки карта могла бы
        // ссылаться на любое значение, и «доказательство» стало бы самоссылкой.
        expect(hashMap.goldens[scenario.id].legacy).toBe(prevHashMap.goldens[scenario.id].active);
      });

      it('the committed golden on disk IS the 017.6 hash recorded here', async () => {
        const proof = proveS3ContractMigration(await scenario.run());
        expect(proof.activeHash).toBe(hashMap.goldens[scenario.id].active);
        expect(readCommittedGolden(REPO_ROOT, scenario.goldenSource)).toBe(onDiskFor(scenario.id));
      });
    });
  }

  it('SUPPORTED_CONTRACT_VERSIONS stays append-only — membership, NOT validity of old manifests', async () => {
    const { SUPPORTED_CONTRACT_VERSIONS } = await import('@trading/research-contracts/research');
    const {
      EVENT_DRIVEN_MIN_CONTRACT_VERSION,
      LIFECYCLE_FIELD_MIN_CONTRACT_VERSION,
      SYMBOL_FROM_MIN_CONTRACT_VERSION,
    } = await import('@trdlabs/sdk/research-contract');

    // Перебазировка голденов не выбрасывает прежние версии из набора.
    expect([...SUPPORTED_CONTRACT_VERSIONS]).toEqual(
      expect.arrayContaining(['017.1', '017.2', PRE_S3_CONTRACT_VERSION, S3_CONTRACT_VERSION]),
    );

    // ПРИНАДЛЕЖНОСТЬ НАБОРУ НЕОБХОДИМА, НО НЕ ДОСТАТОЧНА, и «манифесты 017.1–017.4 остаются
    // валидными» было бы неправдой. Валидность определяет ПАРА (версия, форма):
    //
    //   форма манифеста                            | минимальная версия
    //   ───────────────────────────────────────────┼────────────────────────────────────
    //   поля `lifecycle` нет (⇒ single_position)   | любая из набора, начиная с 017.1
    //   `lifecycle` объявлен явно, любое значение  | 017.3 (LIFECYCLE_FIELD_MIN)
    //   `lifecycle: 'event_driven'`                | 017.5 (EVENT_DRIVEN_MIN)
    //   требование с `symbolFrom: 'actor'`         | 017.6 (SYMBOL_FROM_MIN)
    //
    // ТРЕТЬЯ СТРОКА — И ЭТО ВЕСЬ СМЫСЛ ЭТОГО ЗВЕНА. Порог `event_driven` НЕ ДВИГАЛСЯ: манифест,
    // объявляющий 017.5 и фиксированную привязку, валиден ровно как был. Двинулся только порог
    // НОВОЙ ветви. Если бы я поднял `EVENT_DRIVEN_MIN` заодно, каждая существующая event-driven
    // стратегия под 017.5 стала бы невалидной — и «совместимость сохранена» было бы неправдой.
    //
    // Пороги проверяются, а не пересказываются: подвинь их SDK молча — покраснеет здесь.
    expect(LIFECYCLE_FIELD_MIN_CONTRACT_VERSION).toBe('017.3');
    expect(EVENT_DRIVEN_MIN_CONTRACT_VERSION).toBe(PRE_S3_CONTRACT_VERSION);
    expect(SYMBOL_FROM_MIN_CONTRACT_VERSION).toBe(S3_CONTRACT_VERSION);
  });

  it('the projection is not vacuous: it actually rolls the version back', () => {
    // Проверка проверки. Если бы проекция ничего не меняла, все утверждения выше проходили бы ни
    // о чём — ровно тот guard, что стоит у двух соседних пруфов.
    const payload = { evidence: { contractVersion: S3_CONTRACT_VERSION, seed: 1 } };
    const rolled = projectContractVersion(payload, S3_CONTRACT_VERSION, PRE_S3_CONTRACT_VERSION);
    expect(rolled).toEqual({ evidence: { contractVersion: PRE_S3_CONTRACT_VERSION, seed: 1 } });
    expect(structuralDiffPaths(rolled, payload)).toEqual(['/evidence/contractVersion']);
  });
});
