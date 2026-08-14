// Д3 3.3в — перебазировка committed result-голденов под контракт 017.5, ПОД ДОКАЗАТЕЛЬСТВОМ.
//
// Голова цепи миграций. Полная цепь на сегодня:
//
//   017.2 --> 017.3 --> Ф3 --> 017.4 --[ЭТОТ СКРИПТ]--> 017.5
//
// Для каждого сценария скрипт:
//   1. прогоняет его под 017.5;
//   2. откатывает ровно одно поле — evidence.contractVersion — обратно к 017.4;
//   3. ТРЕБУЕТ, чтобы хеш этой проекции совпал с тем, что лежит на диске СЕЙЧАС, и чтобы это же
//      значение было active предыдущего звена. Не совпало — ничего не пишется.
//
// Причина сдвига измерена ОТДЕЛЬНО, лестницей опубликованных пар engine/SDK от 0.10/0.15 до
// 0.15/0.19: после нормализации contractVersion соседние ступени дают ПОБАЙТНО одинаковый payload,
// то есть пять минорных версий движка не изменили полезную нагрузку вовсе. Единственная разница на
// всём пути — строка версии. Хеш при этом использовался как финальная проверка, а не как средство
// локализации: «хеши разошлись» не называет ни одного поля.
//
// --reanchor СОЗНАТЕЛЬНО НЕ РЕАЛИЗОВАН — по той же причине, что и у предыдущего звена.
//
// Запуск: pnpm exec tsx apps/backtester/scripts/derive-017-5-goldens.mts [--write]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GOLDEN_SCENARIOS,
  PRE_D3_CONTRACT_VERSION,
  D3_CONTRACT_VERSION,
  proveD3ContractMigration,
  readCommittedGolden,
} from '../test/helpers/golden-scenarios.js';
import { assertOwnsGoldenFiles } from '../test/helpers/migration-chain.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MAP_PATH = resolve(REPO_ROOT, 'apps/backtester/test/fixtures/017-5-migration/hash-map.json');
const PREV_MAP_PATH = resolve(
  REPO_ROOT,
  'apps/backtester/test/fixtures/017-4-migration/hash-map.json',
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

const prevMap = JSON.parse(readFileSync(PREV_MAP_PATH, 'utf8')) as {
  goldens: Record<string, { active: string }>;
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
  const proof = proveD3ContractMigration(await scenario.run());
  const committed = readCommittedGolden(REPO_ROOT, scenario.goldenSource);
  const recorded = priorMap?.goldens?.[scenario.id];

  // Повторный прогон после записи: на диске уже новое значение, поэтому якорь берётся из карты.
  // Без этой ветки скрипт был бы одноразовым и на второй запуск сообщал бы о несуществующем дрейфе.
  const alreadyRebased = recorded !== undefined && committed === recorded.active;
  const anchor = alreadyRebased ? recorded.legacy : committed;

  // Цепь обязана быть замкнута ЯВНО: якорь этого звена — то же самое значение, что `active`
  // предыдущего. Если это перестало быть так, звенья разъехались, и молча переписывать голден
  // нельзя, даже когда откат сошёлся сам с собой.
  const prevActive = prevMap.goldens?.[scenario.id]?.active;
  const chained = prevActive !== undefined && anchor === prevActive;

  const equivalent = proof.legacyHash === anchor;
  const onlyVersion =
    proof.diffPaths.length > 0 &&
    proof.diffPaths.every((p) => p.endsWith('/evidence/contractVersion'));

  console.log(`${scenario.id}:${alreadyRebased ? ' (already rebased — verifying against the map)' : ''}`);
  console.log(`  pre-D3 anchor : ${anchor}`);
  console.log(`  rolled back   : ${proof.legacyHash} ${equivalent ? '✓ equivalent' : '✗ DRIFTED'}`);
  console.log(`  new active    : ${proof.activeHash}`);
  console.log(`  diffPaths     : ${proof.diffPaths.join(', ') || '(none)'}`);

  if (!chained) {
    console.error(
      `  ✗ ${scenario.id}: якорь ${anchor} != active карты 017.4 ${prevActive ?? '(нет записи)'} — цепь миграций разорвана`,
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
  contract: { from: PRE_D3_CONTRACT_VERSION, to: D3_CONTRACT_VERSION },
  migration: {
    epic: 'Д3',
    slice: '3.3в',
    cause:
      'Контракт поднялся 017.4 → 017.5 (SDK 0.19.0): CONTRACT_VERSION входит в RunEvidence, а evidence — в канонический payload, поэтому бамп версии меняет content-hash каждого прогона. Лестница пар engine/SDK показала, что ничего кроме этой строки не изменилось.',
  },
  goldens,
};

if (!WRITE) {
  console.log('\n(dry run — pass --write to rebase the goldens and the mapping fixture)');
  console.log(JSON.stringify(mapping, null, 2));
  process.exit(0);
}

// Сегодня это звено — голова, и проверка проходит. Она стоит здесь не «на всякий случай»: когда
// цепь вырастет ещё раз, достаточно будет дописать строку в MIGRATION_CHAIN, и этот скрипт начнёт
// отказываться от записи файлов САМ, без правки своего кода. Ровно того механизма не хватало
// derive-f3-goldens, и он молча откатывал голдены на эпоху назад.
assertOwnsGoldenFiles('017-5-migration');

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
