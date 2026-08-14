// Доказательство миграции result-голденов 017.4 → 017.5 (083 S3) — голова цепи.
//
// Полная цепь на сегодня:
//   017.2 --[017-migration]--> 017.3 --[f3-engine-migration]--> Ф3 --[017-4-migration]--> 017.4
//        --[ЭТА КАРТА]--> 017.5
//
// Перебазировать замороженный хеш легко и потому опасно: «прогнал, вставил новое значение» прячет
// любую регрессию, случившуюся в том же коммите. Здесь перебазировка обязана себя доказать.
//
// Для каждого голдена: берём СВЕЖИЙ прогон под 017.5, откатываем в нём ровно
// `evidence.contractVersion` — и требуем, чтобы хеш совпал с тем, что лежал на диске ДО этой
// миграции. Совпал — значит весь остальной payload байт-в-байт прежний, движок не сдвинулся.
// Плюс structural diff обязан состоять ТОЛЬКО из путей `…/evidence/contractVersion`: без этого
// хеш мог бы сойтись случайно, а diff это покажет.
//
// В отличие от трёх звеньев выше это ведётся на ПОЛНОМ payload'е, без проекций: на диске лежит
// хеш полного payload'а, и сравнивать надо величину той же природы. Голова — единственное звено,
// которому нормализация входа не нужна: свежий прогон уже эмитит её версию.

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

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface Entry {
  readonly scenario: string;
  readonly source: string;
  readonly legacy: string;
  readonly active: string;
  readonly diffPaths: readonly string[];
}

const hashMap = JSON.parse(
  readFileSync(resolve(REPO_ROOT, 'apps/backtester/test/fixtures/017-5-migration/hash-map.json'), 'utf8'),
) as {
  contract: { from: string; to: string };
  migration: { epic: string; slice: string; cause: string };
  goldens: Record<string, Entry>;
};

/** Предыдущее звено цепи: 083 S1, бамп контракта 017.3 → 017.4. */
const priorHashMap = JSON.parse(
  readFileSync(
    resolve(REPO_ROOT, 'apps/backtester/test/fixtures/017-4-migration/hash-map.json'),
    'utf8',
  ),
) as { goldens: Record<string, Entry> };

describe('017.4 → 017.5 golden migration proof', () => {
  it('mapping fixture records the ratified version pair', () => {
    expect(hashMap.contract).toEqual({ from: PRE_S3_CONTRACT_VERSION, to: S3_CONTRACT_VERSION });
    expect(Object.keys(hashMap.goldens).sort()).toEqual(GOLDEN_SCENARIOS.map((s) => s.id).sort());
  });

  it('the fixture names ITS OWN slice, not the one it was copied from', () => {
    // Звено заводилось копией предыдущего, и метаданные приехали вместе с формой: карта 017.4 →
    // 017.5 объявляла себя срезом S1. Хеши от этого не портятся — портится ПРОВЕНАНС: запись
    // «почему голдены сдвинулись» указывала на чужую причину, и читатель, пришедший через год,
    // получил бы уверенный неверный ответ. Гейт стоит здесь потому, что копирование следующего
    // звена — самый вероятный способ завести это поле снова.
    expect(hashMap.migration.epic).toBe('083');
    expect(hashMap.migration.slice).toBe('S3');
    expect(hashMap.migration.cause).toMatch(/083 S3/);
  });

  for (const scenario of GOLDEN_SCENARIOS) {
    describe(scenario.id, () => {
      it('rolling back evidence.contractVersion reproduces the 017.4 golden exactly', async () => {
        const proof = proveS3ContractMigration(await scenario.run());
        // Если это падает — вместе с версией контракта уехало что-то ещё, и перебазировка хеша
        // скрыла бы регрессию движка.
        expect(proof.legacyHash).toBe(hashMap.goldens[scenario.id].legacy);
      });

      it('differs from the 017.4 projection ONLY at evidence.contractVersion', async () => {
        const proof = proveS3ContractMigration(await scenario.run());
        expect(proof.diffPaths.length).toBeGreaterThan(0);
        for (const path of proof.diffPaths) expect(path).toMatch(/\/evidence\/contractVersion$/);
        expect([...proof.diffPaths].sort()).toEqual([...hashMap.goldens[scenario.id].diffPaths].sort());
      });

      it('the chain is unbroken: this link starts where 017.4 ended', () => {
        // Звено начинается ровно там, где кончилось предыдущее. Без этой сцепки карта могла бы
        // ссылаться на любое значение, и «доказательство» стало бы самоссылкой.
        expect(hashMap.goldens[scenario.id].legacy).toBe(priorHashMap.goldens[scenario.id].active);
      });

      it('the committed golden on disk IS the 017.5 hash recorded here', async () => {
        const proof = proveS3ContractMigration(await scenario.run());
        expect(proof.activeHash).toBe(hashMap.goldens[scenario.id].active);
        expect(readCommittedGolden(REPO_ROOT, scenario.goldenSource)).toBe(
          hashMap.goldens[scenario.id].active,
        );
      });
    });
  }

  it('017.1–017.4 compatibility is preserved: append-only, prior manifests still valid', async () => {
    const { SUPPORTED_CONTRACT_VERSIONS } = await import('@trading/research-contracts/research');
    // Перебазировка голденов НЕ означает отказ от прежних версий: манифесты 017.1–017.4 обязаны
    // остаться валидными. 017.3 перечислен ЯВНО: список копировался от звена к звену, и в этой
    // копии он выпал — версия между «первыми двумя» и `PRE_S3` не покрывалась ничем, хотя
    // append-only обязан держать её наравне с остальными.
    expect([...SUPPORTED_CONTRACT_VERSIONS]).toEqual(
      expect.arrayContaining([
        '017.1',
        '017.2',
        '017.3',
        PRE_S3_CONTRACT_VERSION,
        S3_CONTRACT_VERSION,
      ]),
    );
  });

  it('the projection is not vacuous: it actually rolls the version back', () => {
    // Проверка проверки. Если бы проекция ничего не меняла, все утверждения выше проходили бы ни
    // о чём — ровно тот guard, что стоит у трёх соседних пруфов.
    const payload = { evidence: { contractVersion: S3_CONTRACT_VERSION, seed: 1 } };
    const rolled = projectContractVersion(payload, S3_CONTRACT_VERSION, PRE_S3_CONTRACT_VERSION);
    expect(rolled).toEqual({ evidence: { contractVersion: PRE_S3_CONTRACT_VERSION, seed: 1 } });
    expect(structuralDiffPaths(rolled, payload)).toEqual(['/evidence/contractVersion']);
  });
});
