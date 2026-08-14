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
  projectContractVersion,
  projectToLegacyContractVersion,
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

/** Карта следующего звена цепи миграций: Ф3, переезд исполнительного ядра на `@trdlabs/engine`. */
const f3HashMap = JSON.parse(
  readFileSync(
    resolve(REPO_ROOT, 'apps/backtester/test/fixtures/f3-engine-migration/hash-map.json'),
    'utf8',
  ),
) as { goldens: Record<string, HashMapEntry> };

/** Карта головы цепи: 083 S1, бамп контракта 017.3 → 017.4. Её `active` и лежит на диске. */
const s1HashMap = JSON.parse(
  readFileSync(
    resolve(REPO_ROOT, 'apps/backtester/test/fixtures/017-4-migration/hash-map.json'),
    'utf8',
  ),
) as { goldens: Record<string, HashMapEntry> };

/** Голова цепи после Д3: бамп контракта 017.4 → 017.5. Её `active` и лежит на диске. */
const d3HashMap = JSON.parse(
  readFileSync(
    resolve(REPO_ROOT, 'apps/backtester/test/fixtures/017-5-migration/hash-map.json'),
    'utf8',
  ),
) as { goldens: Record<string, HashMapEntry> };

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

      it('the 017.3 hash recorded here is the pre-Ф3 anchor the next migration starts from', async () => {
        const proof = proveContractVersionMigration(await scenario.run());
        const recorded = hashMap.goldens[scenario.id];
        expect(proof.activeHash).toBe(recorded.active);
        // Ф3 (переезд на `@trdlabs/engine`) перебазировала committed-голдены ещё раз, поэтому файл
        // на диске больше НЕ равен 017.3-хешу. Чтобы это доказательство не протухло, а осталось
        // звеном цепи, оно сцепляется со следующими звеньями. Разрыв в любом месте — падение
        // здесь, а не тихий дрейф.
        //
        // 083 S1 добавил четвёртое звено, и файл на диске уехал ещё раз: теперь там 017.4-хеш.
        // Цепь проверяется ЦЕЛИКОМ, а не только до ближайшего соседа: иначе её середина могла бы
        // разъехаться незамеченной, пока концы сходятся.
        expect(recorded.active).toBe(f3HashMap.goldens[scenario.id].legacy);
        expect(f3HashMap.goldens[scenario.id].active).toBe(s1HashMap.goldens[scenario.id].legacy);
        // Д3 добавил пятое звено (017.4 → 017.5): файл на диске уехал ещё раз. Цепь по-прежнему
        // проверяется ЦЕЛИКОМ — до головы, а не до ближайшего соседа.
        expect(s1HashMap.goldens[scenario.id].active).toBe(d3HashMap.goldens[scenario.id].legacy);
        expect(readCommittedGolden(REPO_ROOT, scenario.goldenSource)).toBe(
          d3HashMap.goldens[scenario.id].active,
        );
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

// Проекция версии стала параметрической: цепь миграций растёт, и следующему звену нужна та же
// операция для другой пары версий, а историческим пруфам — нормализация входа к своей эпохе.
// Пара 017.2→017.3 остаётся обёрткой над ней, поэтому смысл существующих вызовов не меняется.
describe('projectContractVersion', () => {
  it('заменяет версию только там, где она равна `from`', () => {
    const payload = {
      baseline: { evidence: { contractVersion: '017.3', seed: 1 } },
      variant: { evidence: { contractVersion: '017.2', seed: 2 } },
    };
    expect(projectContractVersion(payload, '017.3', '017.4')).toEqual({
      baseline: { evidence: { contractVersion: '017.4', seed: 1 } },
      variant: { evidence: { contractVersion: '017.2', seed: 2 } },
    });
  });

  it('обходит вложенные evidence рекурсивно (у overlay-прогона их два)', () => {
    const payload = { a: { b: { evidence: { contractVersion: '017.3' } } } };
    expect(projectContractVersion(payload, '017.3', '017.4')).toEqual({
      a: { b: { evidence: { contractVersion: '017.4' } } },
    });
  });

  it('проходит сквозь массивы', () => {
    const payload = { runs: [{ evidence: { contractVersion: '017.3' } }] };
    expect(projectContractVersion(payload, '017.3', '017.4')).toEqual({
      runs: [{ evidence: { contractVersion: '017.4' } }],
    });
  });

  it('не тождество: сопоставление по `from` действительно проверяется', () => {
    // Безусловная запись выровняла бы узел, стоящий на чужой версии, и стёрла бы сигнал о том,
    // что payload собран из разных источников. Здесь такой узел обязан остаться нетронутым.
    const payload = { evidence: { contractVersion: '017.9' } };
    expect(projectContractVersion(payload, '017.3', '017.4')).toEqual(payload);
  });

  it('историческая обёртка выражена через неё и даёт прежний результат', () => {
    const payload = { evidence: { contractVersion: ACTIVE_CONTRACT_VERSION } };
    expect(projectToLegacyContractVersion(payload)).toEqual(
      projectContractVersion(payload, ACTIVE_CONTRACT_VERSION, LEGACY_CONTRACT_VERSION),
    );
  });
});
