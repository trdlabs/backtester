// 083 S1 — перебазировка committed result-голденов под контракт 017.4, ПОД ДОКАЗАТЕЛЬСТВОМ.
//
// ИСТОРИЧЕСКОЕ ЗВЕНО (с 083 S3), режим — ПРОВЕРКА КАРТА-К-КАРТЕ. Полная цепь на сегодня:
//
//   017.2 --[derive_goldens.mjs]--> 017.3 --[derive-f3-goldens.mts]--> Ф3 --[ЭТОТ СКРИПТ]--> 017.4
//        --[derive-017-5-goldens.mts]--> 017.5
//
// ЧТО ИЗМЕНИЛОСЬ, КОГДА ЗВЕНО ПЕРЕСТАЛО БЫТЬ ГОЛОВОЙ. Файлы голденов держат `active` головы, а не
// этого звена, поэтому якорь больше НЕ читается с диска: сравнение с ним сравнивало бы величины
// разных эпох и докладывало бы дрейф на полностью целой цепи. Якорь берётся из карты предыдущего
// звена, а замыкание вперёд — из карты следующего.
//
// Для каждого сценария скрипт:
//   1. прогоняет его и НОРМАЛИЗУЕТ результат к собственной эпохе (внутри `proveS1ContractMigration`);
//   2. откатывает в нём ровно одно поле — `evidence.contractVersion` — обратно к 017.3;
//   3. ТРЕБУЕТ, чтобы хеш этой проекции совпал с `active` Ф3-карты, чтобы `active` совпал с
//      записанным в своей карте, и чтобы он же был `legacy` следующего звена. Не совпало —
//      скрипт падает: значит вместе с версией контракта уехало что-то ещё.
//
// ЗАПИСЬ ОТСЮДА ЗАПРЕЩЕНА и остаётся запрещённой: `--write` доходит до `assertOwnsGoldenFiles` и
// бросает. Проверочный режим при этом осмыслен и потому сохранён целиком — историческое звено
// перестаёт владеть файлами, но не перестаёт доказывать свой переход.
//
// Почему без проекций, в отличие от двух звеньев выше. Те ведутся на до-Ф3 форме, потому что их
// якоря заморожены в той эпохе. Здесь якорь — файл голдена, а в нём после Ф3 лежит хеш ПОЛНОГО
// payload'а. Сверять с ним проекцию нельзя: это величины разной природы, и такая проверка не может
// пройти ни при каких значениях (эту ошибку уже ловили — см. «ПОПРАВКА ПОСЛЕ Ф3» в шапке
// `derive_goldens.mjs`).
//
// `--reanchor` здесь СОЗНАТЕЛЬНО НЕ РЕАЛИЗОВАН. У соседних скриптов он существует для случая
// «арифметика изменилась намеренно и доказана вне скрипта». Здесь арифметика не менялась вовсе:
// сдвинулась одна строка, и её сдвиг доказуем откатом. Флаг, который тут нечем оправдать, — это
// приглашение обойти гейт в следующий раз, когда доказательство не сойдётся.
//
// Запуск: pnpm exec tsx apps/backtester/scripts/derive-017-4-goldens.mts [--write]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GOLDEN_SCENARIOS,
  PRE_S1_CONTRACT_VERSION,
  S1_CONTRACT_VERSION,
  proveS1ContractMigration,
} from '../test/helpers/golden-scenarios.js';
import { assertOwnsGoldenFiles } from '../test/helpers/migration-chain.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MAP_PATH = resolve(REPO_ROOT, 'apps/backtester/test/fixtures/017-4-migration/hash-map.json');
const F3_MAP_PATH = resolve(
  REPO_ROOT,
  'apps/backtester/test/fixtures/f3-engine-migration/hash-map.json',
);
const NEXT_MAP_PATH = resolve(
  REPO_ROOT,
  'apps/backtester/test/fixtures/017-5-migration/hash-map.json',
);
const WRITE = process.argv.includes('--write');

if (process.argv.includes('--reanchor')) {
  console.error(
    '--reanchor здесь не поддержан: сдвиг вызван одной строкой версии и обязан доказываться откатом.',
  );
  process.exit(2);
}

interface Entry {
  readonly scenario: string;
  readonly source: string;
  readonly legacy: string;
  readonly active: string;
  readonly diffPaths: readonly string[];
}

const f3Map = JSON.parse(readFileSync(F3_MAP_PATH, 'utf8')) as {
  goldens: Record<string, { active: string }>;
};

/** Следующее звено цепи: 083 S3, бамп 017.4 → 017.5. Его `legacy` обязан быть нашим `active`. */
const nextMap = JSON.parse(readFileSync(NEXT_MAP_PATH, 'utf8')) as {
  goldens: Record<string, { legacy: string }>;
};

const priorMap = (() => {
  try {
    return JSON.parse(readFileSync(MAP_PATH, 'utf8')) as {
      contract: { from: string; to: string };
      goldens: Record<string, Entry>;
    };
  } catch {
    return undefined;
  }
})();

const goldens: Record<string, Entry> = {};
let failed = 0;

for (const scenario of GOLDEN_SCENARIOS) {
  const proof = proveS1ContractMigration(await scenario.run());
  const recorded = priorMap?.goldens?.[scenario.id];

  // ЯКОРЬ БЕРЁТСЯ ИЗ КАРТЫ ПРЕДЫДУЩЕГО ЗВЕНА, А НЕ С ДИСКА. Пока звено было головой, файл голдена
  // и был его `active`, и сверка с диском имела смысл. С появлением 017.5 на диске лежит `active`
  // НОВОЙ головы: сравнение с ним сравнивало бы величины разных эпох и давало бы ложный дрейф на
  // полностью целой цепи.
  //
  // Историческое звено проверяется КАРТА-К-КАРТЕ: пришло оттуда, куда пришёл предшественник, и
  // ушло туда, откуда уходит преемник. Файлов голденов оно не касается вовсе.
  const f3Active = f3Map.goldens?.[scenario.id]?.active;
  const anchor = f3Active;
  const chained = anchor !== undefined;

  // Замыкание ВПЕРЁД: `active` этого звена обязан быть `legacy` следующего. Без него звено могло
  // бы «доказать» переход, который в цепи никем не подхвачен.
  const nextLegacy = nextMap.goldens?.[scenario.id]?.legacy;

  const equivalent = anchor !== undefined && proof.legacyHash === anchor;
  const onlyVersion =
    proof.diffPaths.length > 0 &&
    proof.diffPaths.every((p) => p.endsWith('/evidence/contractVersion'));

  console.log(`${scenario.id}: (historical link — verifying map-to-map, goldens untouched)`);
  console.log(`  anchor (Ф3 active) : ${anchor ?? '(нет записи)'}`);
  console.log(`  rolled back        : ${proof.legacyHash} ${equivalent ? '✓ equivalent' : '✗ DRIFTED'}`);
  console.log(`  active             : ${proof.activeHash}`);
  console.log(`  next link legacy   : ${nextLegacy ?? '(нет записи)'}`);
  console.log(`  diffPaths          : ${proof.diffPaths.join(', ') || '(none)'}`);

  if (!chained) {
    console.error(
      `  ✗ ${scenario.id}: у Ф3-карты нет записи сценария — цепь миграций разорвана назад`,
    );
    failed += 1;
    continue;
  }
  if (recorded !== undefined && proof.activeHash !== recorded.active) {
    console.error(
      `  ✗ ${scenario.id}: active ${proof.activeHash} != записанного в карте ${recorded.active} — звено сдвинулось`,
    );
    failed += 1;
    continue;
  }
  if (nextLegacy !== proof.activeHash) {
    console.error(
      `  ✗ ${scenario.id}: active ${proof.activeHash} != legacy следующего звена ${nextLegacy ?? '(нет записи)'} — цепь миграций разорвана вперёд`,
    );
    failed += 1;
    continue;
  }
  if (!onlyVersion) {
    console.error(
      proof.diffPaths.length === 0
        ? `  ✗ ${scenario.id}: откат ничего не изменил — evidence.contractVersion не найден в payload'е`
        : `  ✗ ${scenario.id}: расхождение вышло за пределы evidence.contractVersion`,
    );
    failed += 1;
    continue;
  }
  if (!equivalent) {
    console.error(
      `  ✗ ${scenario.id}: вместе с версией контракта уехало что-то ещё — перебазировка запрещена`,
    );
    failed += 1;
    continue;
  }

  goldens[scenario.id] = {
    scenario: scenario.id,
    source: scenario.goldenSource,
    legacy: anchor,
    active: proof.activeHash,
    diffPaths: [...proof.diffPaths].sort(),
  };
}

if (failed > 0) {
  console.error(`\n${failed} scenario(s) failed the migration gate — nothing written.`);
  process.exit(1);
}

const mapping = {
  contract: { from: PRE_S1_CONTRACT_VERSION, to: S1_CONTRACT_VERSION },
  migration: {
    epic: '083',
    slice: 'S1',
    cause:
      'runner.ts кладёт CONTRACT_VERSION в RunEvidence, а evidence входит в канонический payload прогона — значит бамп контракта меняет content-hash каждого прогона. Исключить contractVersion из хеша нельзя: identity прогона обязана включать версию контракта, по которому он исполнен.',
  },
  goldens,
};

if (!WRITE) {
  console.log('\n(dry run — pass --write to rebase the goldens and the mapping fixture)');
  console.log(JSON.stringify(mapping, null, 2));
  process.exit(0);
}

// ЗДЕСЬ ЭТОТ ВЫЗОВ ТЕПЕРЬ БРОСАЕТ, и именно ради этого он и был поставлен заранее. Цепь выросла на
// звено 017-5, право записи перешло к нему — а код этого скрипта править не пришлось: владелец
// выводится из MIGRATION_CHAIN, а не помнится автором. Ровно того механизма не хватало
// derive-f3-goldens, и он молча откатывал голдены на эпоху назад.
assertOwnsGoldenFiles('017-4-migration');

mkdirSync(dirname(MAP_PATH), { recursive: true });
writeFileSync(MAP_PATH, `${JSON.stringify(mapping, null, 2)}\n`, 'utf8');
console.log(`\nwrote ${MAP_PATH}`);

for (const entry of Object.values(goldens)) {
  const path = resolve(REPO_ROOT, entry.source);
  if (entry.source.endsWith('.hash')) {
    writeFileSync(path, `${entry.active}\n`, 'utf8');
  } else {
    const raw = readFileSync(path, 'utf8');
    writeFileSync(path, raw.replace(/sha256:[0-9a-f]{64}/, entry.active), 'utf8');
  }
  console.log(`rebased ${entry.source}`);
}
