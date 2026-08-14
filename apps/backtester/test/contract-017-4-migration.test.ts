// Доказательство миграции result-голденов 017.3 → 017.4 (083 S1) — ИСТОРИЧЕСКОЕ звено.
//
// Полная цепь на сегодня:
//   017.2 --[017-migration]--> 017.3 --[f3-engine-migration]--> Ф3 --[ЭТА КАРТА]--> 017.4
//        --[017-5-migration]--> 017.5
//
// ЗВЕНО ПЕРЕСТАЛО БЫТЬ ГОЛОВОЙ (083 S3), и это меняет два его утверждения, а не одно:
//
//   • про ДИСК — файл голдена держит `active` головы, а не этого звена. Прежняя редакция сверяла
//     диск со своим `active`; утверждение было истинным ровно пока звено было последним;
//   • про ВХОД — свежий прогон эмитит головную версию, поэтому доказательство нормализует его к
//     СВОЕЙ эпохе (внутри `proveS1ContractMigration`). Без этого откат `017.4 → 017.3` не совпал
//     бы ни с одним узлом, и звено молча перестало бы утверждать что-либо: `legacy` сравнялся бы
//     с `active`, а diff опустел.
//
// Само доказательство при этом остаётся ЖИВЫМ, а не сводится к сверке карт: сценарии по-прежнему
// прогоняются, и равенство «откат одного поля возвращает 017.3-якорь» проверяется на свежих
// числах. Историческое звено — это про право записи и про эпоху входа, а не про отказ от проверки.
//
// Перебазировать замороженный хеш легко и потому опасно: «прогнал, вставил новое значение» прячет
// любую регрессию, случившуюся в том же коммите. Здесь перебазировка обязана себя доказать.
//
// Для каждого голдена: берём СВЕЖИЙ прогон под 017.4, откатываем в нём ровно
// `evidence.contractVersion` — и требуем, чтобы хеш совпал с тем, что лежал на диске ДО этой
// миграции. Совпал — значит весь остальной payload байт-в-байт прежний, движок не сдвинулся.
// Плюс structural diff обязан состоять ТОЛЬКО из путей `…/evidence/contractVersion`: без этого
// хеш мог бы сойтись случайно, а diff это покажет.
//
// В отличие от двух звеньев выше это ведётся на ПОЛНОМ payload'е, без проекций: на диске лежит
// хеш полного payload'а, и сравнивать надо величину той же природы.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GOLDEN_SCENARIOS,
  PRE_S1_CONTRACT_VERSION,
  S1_CONTRACT_VERSION,
  projectContractVersion,
  proveS1ContractMigration,
  readCommittedGolden,
  structuralDiffPaths,
} from './helpers/golden-scenarios.js';
import { assertOwnsGoldenFiles, chainAnchors } from './helpers/migration-chain.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface Entry {
  readonly scenario: string;
  readonly source: string;
  readonly legacy: string;
  readonly active: string;
  readonly diffPaths: readonly string[];
}

const hashMap = JSON.parse(
  readFileSync(resolve(REPO_ROOT, 'apps/backtester/test/fixtures/017-4-migration/hash-map.json'), 'utf8'),
) as { contract: { from: string; to: string }; goldens: Record<string, Entry> };

/** Чтение карты звена. Передаётся в `chainAnchors`, чтобы у помощника не было доступа к диску. */
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

describe('017.3 → 017.4 golden migration proof', () => {
  it('mapping fixture records the ratified version pair', () => {
    expect(hashMap.contract).toEqual({ from: PRE_S1_CONTRACT_VERSION, to: S1_CONTRACT_VERSION });
    expect(Object.keys(hashMap.goldens).sort()).toEqual(GOLDEN_SCENARIOS.map((s) => s.id).sort());
  });

  for (const scenario of GOLDEN_SCENARIOS) {
    describe(scenario.id, () => {
      it('rolling back evidence.contractVersion reproduces the 017.3 golden exactly', async () => {
        const proof = proveS1ContractMigration(await scenario.run());
        // Если это падает — вместе с версией контракта уехало что-то ещё, и перебазировка хеша
        // скрыла бы регрессию движка.
        expect(proof.legacyHash).toBe(hashMap.goldens[scenario.id].legacy);
      });

      it('differs from the 017.3 projection ONLY at evidence.contractVersion', async () => {
        const proof = proveS1ContractMigration(await scenario.run());
        expect(proof.diffPaths.length).toBeGreaterThan(0);
        for (const path of proof.diffPaths) expect(path).toMatch(/\/evidence\/contractVersion$/);
        expect([...proof.diffPaths].sort()).toEqual([...hashMap.goldens[scenario.id].diffPaths].sort());
      });

      it('the chain is unbroken: this link starts where Ф3 ended', () => {
        // Звено начинается ровно там, где кончилось предыдущее. Без этой сцепки карта могла бы
        // ссылаться на любое значение, и «доказательство» стало бы самоссылкой.
        const anchors = chainAnchors(REPO_ROOT, scenario.id, readJson);
        const mine = anchors.findIndex((a) => a.id === '017-4-migration');
        expect(hashMap.goldens[scenario.id].legacy).toBe(anchors[mine - 1]!.active);
      });

      it('the 017.4 hash recorded here is where the NEXT link starts — the disk moved on', async () => {
        const proof = proveS1ContractMigration(await scenario.run());
        expect(proof.activeHash).toBe(hashMap.goldens[scenario.id].active);

        // ЭТО ЗВЕНО БОЛЬШЕ НЕ ГОЛОВА. 083 S3 перебазировал committed-голдены под 017.5, и файл на
        // диске равен `active` НОВОЙ головы, а не 017.4-хешу. Прежняя редакция сверяла диск со
        // своим `active` — утверждение, истинное ровно пока звено было последним, и ставшее
        // неправдой при полностью целой цепи.
        //
        // Историческое звено удерживает две вещи: свой `active` есть `legacy` следующего звена, а
        // на диске лежит `active` головы. Обе берутся из объявленной цепи.
        const anchors = chainAnchors(REPO_ROOT, scenario.id, readJson);
        const mine = anchors.findIndex((a) => a.id === '017-4-migration');
        expect(hashMap.goldens[scenario.id].active).toBe(anchors[mine + 1]!.legacy);
        expect(readCommittedGolden(REPO_ROOT, scenario.goldenSource)).toBe(
          anchors[anchors.length - 1]!.active,
        );
      });

      it('this link no longer owns the golden files: writing from here is refused', () => {
        // Право записи выводится из объявленной цепи, а не помнится автором дериватора. Гейт
        // проверяется ЗДЕСЬ, потому что дериватор запускают руками и редко: отказ, который никто
        // не исполняет, ничем не отличается от отсутствующего.
        expect(() => assertOwnsGoldenFiles('017-4-migration')).toThrow(/больше не голова цепи/);
      });
    });
  }

  it('017.1–017.3 compatibility is preserved: append-only, prior manifests still valid', async () => {
    const { SUPPORTED_CONTRACT_VERSIONS } = await import('@trading/research-contracts/research');
    // Перебазировка голденов НЕ означает отказ от прежних версий: манифесты 017.1/017.2/017.3
    // обязаны остаться валидными.
    expect([...SUPPORTED_CONTRACT_VERSIONS]).toEqual(
      expect.arrayContaining(['017.1', '017.2', PRE_S1_CONTRACT_VERSION, S1_CONTRACT_VERSION]),
    );
  });

  it('the projection is not vacuous: it actually rolls the version back', () => {
    // Проверка проверки. Если бы проекция ничего не меняла, все утверждения выше проходили бы ни
    // о чём — ровно тот guard, что стоит у двух соседних пруфов.
    const payload = { evidence: { contractVersion: S1_CONTRACT_VERSION, seed: 1 } };
    const rolled = projectContractVersion(payload, S1_CONTRACT_VERSION, PRE_S1_CONTRACT_VERSION);
    expect(rolled).toEqual({ evidence: { contractVersion: PRE_S1_CONTRACT_VERSION, seed: 1 } });
    expect(structuralDiffPaths(rolled, payload)).toEqual(['/evidence/contractVersion']);
  });
});
