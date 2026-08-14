// Цепь миграций голденов: объявление обязано соответствовать данным, а файлами голденов владеет
// только её голова.
//
// Почему это отдельный гейт. Файлы голденов ОБЩИЕ на всю цепь — их три, а звеньев уже четыре.
// Значит любой не-головной дериватор, записав туда свой `active`, откатит голдены на эпоху назад.
// 083 S1 это и произошло: `derive-f3-goldens --write` стал успешно писать хеши эпохи Ф3 поверх
// 017.4 — причём ровно после того, как ему ПОЧИНИЛИ проверку эквивалентности. До починки он падал
// на несошедшемся якоре и не писал ничего; после — начал проходить, и запись, которую никто не
// пересматривал, ожила.
//
// Отсюда два утверждения ниже, и они разные:
//   1. право записи выводится из порядка звеньев, а не помнится в каждом скрипте;
//   2. сам порядок не разошёлся с данными — соседние звенья действительно сцеплены.
// Без второго первое защищало бы неверную цепь так же надёжно, как верную.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GOLDEN_SCENARIOS, readCommittedGolden } from './helpers/golden-scenarios.js';
import { CHAIN_HEAD, MIGRATION_CHAIN, assertOwnsGoldenFiles } from './helpers/migration-chain.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface Entry {
  readonly legacy: string;
  readonly active: string;
}

function loadMap(relPath: string): Record<string, Entry> {
  const raw = JSON.parse(readFileSync(resolve(REPO_ROOT, relPath), 'utf8')) as {
    goldens: Record<string, Entry>;
  };
  return raw.goldens;
}

describe('цепь миграций голденов', () => {
  it('голова — последнее объявленное звено', () => {
    expect(CHAIN_HEAD).toBe(MIGRATION_CHAIN[MIGRATION_CHAIN.length - 1]);
    expect(CHAIN_HEAD.id).toBe('017-5-migration');
  });

  it('каждое объявленное звено существует на диске', () => {
    // Иначе объявление могло бы ссылаться на выдуманное звено, и вычисленная из него голова была
    // бы неверна при полностью «зелёном» гейте.
    for (const link of MIGRATION_CHAIN) {
      expect(existsSync(resolve(REPO_ROOT, link.map)), `${link.id}: ${link.map}`).toBe(true);
    }
  });

  it('соседние звенья сцеплены: active предыдущего == legacy следующего, по каждому сценарию', () => {
    // Это проверка ПОРЯДКА, а не только наличия. Переставь строки в MIGRATION_CHAIN — и здесь
    // упадёт, потому что сцепка направленная.
    for (let i = 1; i < MIGRATION_CHAIN.length; i += 1) {
      const prev = loadMap(MIGRATION_CHAIN[i - 1]!.map);
      const next = loadMap(MIGRATION_CHAIN[i]!.map);
      for (const scenario of GOLDEN_SCENARIOS) {
        expect(
          next[scenario.id]?.legacy,
          `${MIGRATION_CHAIN[i - 1]!.id} → ${MIGRATION_CHAIN[i]!.id} / ${scenario.id}`,
        ).toBe(prev[scenario.id]?.active);
      }
    }
  });

  it('на диске лежит active ГОЛОВЫ, а не какого-то звена середины', () => {
    const head = loadMap(CHAIN_HEAD.map);
    for (const scenario of GOLDEN_SCENARIOS) {
      expect(readCommittedGolden(REPO_ROOT, scenario.goldenSource), scenario.id).toBe(
        head[scenario.id]?.active,
      );
    }
  });
});

describe('право записи в файлы голденов', () => {
  it('голова цепи писать может', () => {
    expect(() => assertOwnsGoldenFiles(CHAIN_HEAD.id)).not.toThrow();
  });

  it('историческое звено — не может, и отказ называет нынешнего владельца', () => {
    // Регрессия 083 S1 ровно здесь: до этого гейта derive-f3-goldens --write успешно откатывал
    // все три голдена в эпоху Ф3.
    expect(() => assertOwnsGoldenFiles('f3-engine-migration')).toThrow(/не голова цепи/);
    // Прежняя голова стала историческим звеном — и потеряла право записи ТЕМ ЖЕ механизмом,
    // без правки своего кода. Ради этого реестр и заведён.
    expect(() => assertOwnsGoldenFiles('017-4-migration')).toThrow(/не голова цепи/);
    expect(() => assertOwnsGoldenFiles('f3-engine-migration')).toThrow(/017-5-migration/);
  });

  it('незаявленное звено — тоже не может', () => {
    // Молчаливое «разрешить неизвестному» вернуло бы ту же дыру для любого нового скрипта.
    expect(() => assertOwnsGoldenFiles('017-6-migration')).toThrow(/не объявлено/);
  });

  it('отказ — исключение, а не тихий пропуск записи', () => {
    // Дериватор, «успешно отработавший, но ничего не записавший», читается оператором как «всё в
    // порядке». Здесь пиннится именно бросок.
    let threw = false;
    try {
      assertOwnsGoldenFiles('017-migration');
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
