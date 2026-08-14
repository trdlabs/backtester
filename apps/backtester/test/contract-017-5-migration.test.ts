// Доказательство миграции result-голденов 017.4 → 017.5 (Д3 3.3в).
//
// Голова цепи. Утверждает ровно три вещи, и каждая проверяема:
//   1. `legacy` этого звена — committed-голден ПРЕДЫДУЩЕЙ эпохи: он равен `active` предыдущего
//      звена, и цепь замкнута явно, а не «по построению». На диске его больше нет — с момента
//      перебазировки файл содержит `active` ЭТОГО звена. Путать две величины нельзя: ровно на
//      такой путанице предыдущий дериватор сравнивал проекцию с полным payload'ом;
//   2. `active` равен свежему 017.5-прогону — и он же лежит в файле голдена;
//   3. единственное расхождение — `evidence.contractVersion`.
//
// Причина сдвига измерена лестницей опубликованных пар engine/SDK (0.10/0.15 → 0.15/0.19): после
// нормализации версии соседние ступени дают побайтно одинаковый payload. То есть перебазировка
// вызвана строкой версии, а не дрейфом движка.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GOLDEN_SCENARIOS,
  PRE_D3_CONTRACT_VERSION,
  D3_CONTRACT_VERSION,
  projectContractVersion,
  proveD3ContractMigration,
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
) as { contract: { from: string; to: string }; goldens: Record<string, Entry> };

/** Предыдущее звено цепи: 083 S1, бамп контракта 017.3 → 017.4. Ф3 (переезд исполнительного ядра
 *  на `@trdlabs/engine`) — звено ПЕРЕД ним, а не это. */
const prevHashMap = JSON.parse(
  readFileSync(
    resolve(REPO_ROOT, 'apps/backtester/test/fixtures/017-4-migration/hash-map.json'),
    'utf8',
  ),
) as { goldens: Record<string, Entry> };

describe('017.4 → 017.5 golden migration proof', () => {
  it('mapping fixture records the ratified version pair', () => {
    expect(hashMap.contract).toEqual({ from: PRE_D3_CONTRACT_VERSION, to: D3_CONTRACT_VERSION });
    expect(Object.keys(hashMap.goldens).sort()).toEqual(GOLDEN_SCENARIOS.map((s) => s.id).sort());
  });

  for (const scenario of GOLDEN_SCENARIOS) {
    describe(scenario.id, () => {
      it('rolling back evidence.contractVersion reproduces the 017.4 golden exactly', async () => {
        const proof = proveD3ContractMigration(await scenario.run());
        // Если это падает — вместе с версией контракта уехало что-то ещё, и перебазировка хеша
        // скрыла бы регрессию движка.
        expect(proof.legacyHash).toBe(hashMap.goldens[scenario.id].legacy);
      });

      it('differs from the 017.4 projection ONLY at evidence.contractVersion', async () => {
        const proof = proveD3ContractMigration(await scenario.run());
        expect(proof.diffPaths.length).toBeGreaterThan(0);
        for (const path of proof.diffPaths) expect(path).toMatch(/\/evidence\/contractVersion$/);
        expect([...proof.diffPaths].sort()).toEqual([...hashMap.goldens[scenario.id].diffPaths].sort());
      });

      it('the chain is unbroken: this link starts where the 017.4 link ended', () => {
        // Звено начинается ровно там, где кончилось предыдущее. Без этой сцепки карта могла бы
        // ссылаться на любое значение, и «доказательство» стало бы самоссылкой.
        expect(hashMap.goldens[scenario.id].legacy).toBe(prevHashMap.goldens[scenario.id].active);
      });

      it('the committed golden on disk IS the 017.5 hash recorded here', async () => {
        const proof = proveD3ContractMigration(await scenario.run());
        expect(proof.activeHash).toBe(hashMap.goldens[scenario.id].active);
        expect(readCommittedGolden(REPO_ROOT, scenario.goldenSource)).toBe(
          hashMap.goldens[scenario.id].active,
        );
      });
    });
  }

  it('SUPPORTED_CONTRACT_VERSIONS stays append-only — membership, NOT validity of old manifests', async () => {
    const { SUPPORTED_CONTRACT_VERSIONS } = await import('@trading/research-contracts/research');
    const { EVENT_DRIVEN_MIN_CONTRACT_VERSION, LIFECYCLE_FIELD_MIN_CONTRACT_VERSION } = await import(
      '@trdlabs/sdk/research-contract'
    );

    // Перебазировка голденов не выбрасывает прежние версии из набора.
    expect([...SUPPORTED_CONTRACT_VERSIONS]).toEqual(
      expect.arrayContaining(['017.1', '017.2', PRE_D3_CONTRACT_VERSION, D3_CONTRACT_VERSION]),
    );

    // ПРИНАДЛЕЖНОСТЬ НАБОРУ НЕОБХОДИМА, НО НЕ ДОСТАТОЧНА, и «манифесты 017.1–017.4 остаются
    // валидными» было бы неправдой. Валидность определяет ПАРА (версия, форма):
    //
    //   форма манифеста                            | минимальная версия
    //   ───────────────────────────────────────────┼────────────────────────────────────
    //   поля `lifecycle` нет (⇒ single_position)   | любая из набора, начиная с 017.1
    //   `lifecycle` объявлен явно, любое значение  | 017.3 (LIFECYCLE_FIELD_MIN)
    //   `lifecycle: 'event_driven'`                | 017.5 (EVENT_DRIVEN_MIN)
    //
    // Второй порог поднят вместе с этим контрактом, и в этом всё различие: 017.4 из набора не
    // ушёл, но манифест, объявляющий под ним `event_driven`, отклоняется
    // `unsupported_contract_version` — версия работает по назначению, а не ломается. Фикстура
    // `event-driven-probe` переведена на 017.5 именно поэтому, а не «чтобы позеленело».
    //
    // Пороги проверяются, а не пересказываются: подвинь их SDK молча — покраснеет здесь.
    expect(LIFECYCLE_FIELD_MIN_CONTRACT_VERSION).toBe('017.3');
    expect(EVENT_DRIVEN_MIN_CONTRACT_VERSION).toBe(D3_CONTRACT_VERSION);
  });

  it('the projection is not vacuous: it actually rolls the version back', () => {
    // Проверка проверки. Если бы проекция ничего не меняла, все утверждения выше проходили бы ни
    // о чём — ровно тот guard, что стоит у двух соседних пруфов.
    const payload = { evidence: { contractVersion: D3_CONTRACT_VERSION, seed: 1 } };
    const rolled = projectContractVersion(payload, D3_CONTRACT_VERSION, PRE_D3_CONTRACT_VERSION);
    expect(rolled).toEqual({ evidence: { contractVersion: PRE_D3_CONTRACT_VERSION, seed: 1 } });
    expect(structuralDiffPaths(rolled, payload)).toEqual(['/evidence/contractVersion']);
  });
});
