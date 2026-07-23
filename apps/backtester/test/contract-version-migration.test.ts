// Доказательство миграции result-голденов 017.2 → 017.3 (083 E1).
//
// Перебазировать замороженный хеш легко и потому опасно: «прогнал, вставил новое значение» прячет
// любую регрессию, которая случилась в том же коммите. Здесь перебазировка обязана себя доказать.
//
// Для каждого голдена: берём СВЕЖИЙ результат под ратифицированной версией, откатываем в нём ровно
// `evidence.contractVersion` — и требуем, чтобы хеш совпал с тем, что был заморожен на 017.2.
// Совпал — значит весь остальной payload байт-в-байт прежний, движок не сдвинулся. Плюс structural
// diff обязан состоять ТОЛЬКО из путей `…/evidence/contractVersion`: если разошлось что-то ещё,
// хеш мог бы сойтись случайно, а diff это покажет.
//
// `hash-map.json` хранит пару (legacy → active) и наблюдённые diff-пути как коммитнутый артефакт
// миграции: по нему видно, откуда взялось каждое новое значение, без раскопок в истории git.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACTIVE_CONTRACT_VERSION,
  GOLDEN_SCENARIOS,
  LEGACY_CONTRACT_VERSION,
  proveContractVersionMigration,
  readCommittedGolden,
  structuralDiffPaths,
} from './helpers/golden-scenarios.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface HashMapEntry {
  readonly scenario: string;
  readonly source: string;
  readonly legacy: string;
  readonly active: string;
  readonly diffPaths: readonly string[];
}

const hashMap = JSON.parse(
  readFileSync(resolve(REPO_ROOT, 'apps/backtester/test/fixtures/017-migration/hash-map.json'), 'utf8'),
) as { contract: { from: string; to: string }; goldens: Record<string, HashMapEntry> };

describe('017.2 → 017.3 golden migration proof', () => {
  it('mapping fixture records the ratified version pair', () => {
    expect(hashMap.contract).toEqual({ from: LEGACY_CONTRACT_VERSION, to: ACTIVE_CONTRACT_VERSION });
    expect(Object.keys(hashMap.goldens).sort()).toEqual(GOLDEN_SCENARIOS.map((s) => s.id).sort());
  });

  for (const scenario of GOLDEN_SCENARIOS) {
    describe(scenario.id, () => {
      it('rolling back evidence.contractVersion reproduces the 017.2 golden exactly', async () => {
        const proof = proveContractVersionMigration(await scenario.run());
        const recorded = hashMap.goldens[scenario.id];
        // Если это падает — вместе с версией контракта уехало что-то ещё, и перебазировка
        // хеша скрыла бы регрессию движка.
        expect(proof.legacyHash).toBe(recorded.legacy);
      });

      it('differs from the 017.2 projection ONLY at evidence.contractVersion', async () => {
        const proof = proveContractVersionMigration(await scenario.run());
        expect(proof.diffPaths.length).toBeGreaterThan(0);
        for (const path of proof.diffPaths) expect(path).toMatch(/\/evidence\/contractVersion$/);
        expect([...proof.diffPaths].sort()).toEqual([...hashMap.goldens[scenario.id].diffPaths].sort());
      });

      it('the committed active golden is the 017.3 hash recorded in the mapping', async () => {
        const proof = proveContractVersionMigration(await scenario.run());
        const recorded = hashMap.goldens[scenario.id];
        expect(proof.activeHash).toBe(recorded.active);
        expect(readCommittedGolden(REPO_ROOT, scenario.goldenSource)).toBe(recorded.active);
      });
    });
  }

  it('017.2 compatibility is preserved: the contract still accepts pre-083 manifests', async () => {
    const { SUPPORTED_CONTRACT_VERSIONS } = await import('@trading/research-contracts/research');
    // Перебазировка голденов НЕ означает отказ от прежней версии: манифесты 017.1/017.2 обязаны
    // остаться валидными (append-only, ратифицировано платформенным verify_083_e1_contract_anchor).
    expect([...SUPPORTED_CONTRACT_VERSIONS]).toEqual(
      expect.arrayContaining(['017.1', LEGACY_CONTRACT_VERSION, ACTIVE_CONTRACT_VERSION]),
    );
  });

  it('structuralDiffPaths itself detects a payload change (guard against a vacuous proof)', () => {
    // Проверка проверки: если бы diff всегда возвращал пусто, все утверждения выше проходили бы
    // ни о чём.
    expect(structuralDiffPaths({ a: { b: 1 } }, { a: { b: 2 } })).toEqual(['/a/b']);
    expect(structuralDiffPaths({ a: 1 }, { a: 1 })).toEqual([]);
  });
});
