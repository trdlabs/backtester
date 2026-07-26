// Ф3 (shared-execution-engine, rollout шаг 4) — гейт extraction-equivalence как ТЕСТ, а не как
// заявление в отчёте.
//
// Утверждение, которое здесь доказывается: перенос исполнительного ядра из `apps/backtester/src/engine`
// в пакет `@trdlabs/engine` не изменил НИ ОДНОГО числа в выходе прогона. Всё, что сдвинулось, —
// добавленные ключи ФОРМЫ, и их ровно три вида, каждый предписан:
//
//   • `evidence.evidenceFormatVersion` — решение владельца (A) о run identity (2026-07-25);
//   • `evidence.engineVersion`         — «run/evidence records gain an engineVersion» (карточка,
//                                         раздел «Contract / API / schema changes»);
//   • `Trade.synthetic`                — решение SSOT 5: принудительное end-of-data закрытие
//                                         помечается явно, а не выводится из `closeReason`.
//
// Механика доказательства та же, что у 017-миграции: откатить в свежем прогоне ровно эти ключи и
// потребовать, чтобы хеш совпал с ДО-Ф3 голденом. Совпал — значит ордера, филлы, risk-решения,
// сделки и equity байт-в-байт прежние. Перебазировка голдена обязана себя доказать; «прогнал и
// вставил новое значение» спрятало бы регрессию извлечения в том же коммите.
//
// Почему sizing (решение 3) и funding (решение 4) не двигают эти голдены — тоже проверяемо, а не
// на веру: sizing от MTM-equity отличается от cash-прокси только при уже открытой позиции (на входе
// портфель flat, а у flat `equity == cash` по построению), а funding — opt-in и в этих фикстурах
// выключен. Обе ветки покрыты отдельно: `risk-engine.test.ts` и `funding-engine.test.ts`.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENGINE_VERSION } from '@trdlabs/engine';

import { EVIDENCE_FORMAT_VERSION } from '../src/engine/artifacts.js';
import {
  GOLDEN_SCENARIOS,
  projectToPreF3Shape,
  proveEngineExtraction,
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
  readFileSync(
    resolve(REPO_ROOT, 'apps/backtester/test/fixtures/f3-engine-migration/hash-map.json'),
    'utf8',
  ),
) as {
  migration: { initiative: string; phase: string; to: string; enginePin: string; cause: string };
  goldens: Record<string, Entry>;
};

/** Только эти пути имеют право разойтись. Список закрыт: новый ключ формы — новая правка ЗДЕСЬ. */
const ALLOWED_DIFF = /\/evidence\/(evidenceFormatVersion|engineVersion)$|\/synthetic$/;

describe('Ф3 extraction-equivalence: backtester on @trdlabs/engine', () => {
  it('mapping fixture names the migration and the exact engine commit it was proven against', () => {
    expect(hashMap.migration.initiative).toBe('shared-execution-engine');
    expect(hashMap.migration.phase).toBe('Ф3');
    expect(hashMap.migration.to).toBe('@trdlabs/engine');
    // Пин — это адрес доказательства. Без него запись «эквивалентно» не проверяема задним числом.
    expect(hashMap.migration.enginePin).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(hashMap.goldens).sort()).toEqual(GOLDEN_SCENARIOS.map((s) => s.id).sort());
  });

  it('the run records WHICH core produced it (identity is not a constant the host invents)', () => {
    expect(EVIDENCE_FORMAT_VERSION).toBe('1');
    expect(ENGINE_VERSION).toBe(
      // Версия приходит из самого пакета: если ядро сменит версию, а голдены не перебазируются под
      // пруф, это падение, а не молчаливое расхождение идентичности.
      JSON.parse(readFileSync(resolve(REPO_ROOT, 'vendor/engine/package.json'), 'utf8')).version,
    );
  });

  for (const scenario of GOLDEN_SCENARIOS) {
    describe(scenario.id, () => {
      it('rolling back ONLY the Ф3-added shape keys reproduces the pre-Ф3 golden exactly', async () => {
        const proof = proveEngineExtraction(await scenario.run());
        // Если это падает — извлечение ядра сдвинуло payload, и перебазировка голдена скрыла бы
        // регрессию. Это и есть гейт «Extraction equivalence» из карточки инициативы.
        expect(proof.preF3Hash).toBe(hashMap.goldens[scenario.id].legacy);
      });

      it('differs from the pre-Ф3 shape ONLY at the prescribed keys', async () => {
        const proof = proveEngineExtraction(await scenario.run());
        expect(proof.diffPaths.length).toBeGreaterThan(0);
        for (const path of proof.diffPaths) expect(path).toMatch(ALLOWED_DIFF);
        expect([...proof.diffPaths].sort()).toEqual(
          [...hashMap.goldens[scenario.id].diffPaths].sort(),
        );
      });

      it('the committed golden IS the post-Ф3 hash recorded in the mapping', async () => {
        const proof = proveEngineExtraction(await scenario.run());
        expect(proof.activeHash).toBe(hashMap.goldens[scenario.id].active);
        expect(readCommittedGolden(REPO_ROOT, scenario.goldenSource)).toBe(
          hashMap.goldens[scenario.id].active,
        );
      });
    });
  }

  it('the projection is not vacuous: it actually removes the keys it claims to', () => {
    // Проверка проверки. Если бы проекция ничего не убирала, все утверждения выше проходили бы ни
    // о чём — ровно та ловушка, от которой 017-пруф защищается своим guard'ом.
    const payload = {
      evidence: { seed: 1, evidenceFormatVersion: '1', engineVersion: '0.0.0', contractVersion: '017.3' },
      trades: [{ id: 't', realizedPnl: 1.5, synthetic: 'end_of_data' }],
    };
    const projected = projectToPreF3Shape(payload);
    expect(projected).toEqual({
      evidence: { seed: 1, contractVersion: '017.3' },
      trades: [{ id: 't', realizedPnl: 1.5 }],
    });
    expect([...structuralDiffPaths(projected, payload)].sort()).toEqual([
      '/evidence/engineVersion',
      '/evidence/evidenceFormatVersion',
      '/trades/0/synthetic',
    ]);
  });
});
