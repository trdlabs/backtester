// 083 S3 ступень 1 — перебазировка committed result-голденов под контракт 017.6, ПОД ДОКАЗАТЕЛЬСТВОМ.
//
// Голова цепи миграций. Полная цепь на сегодня:
//
//   017.2 --> 017.3 --> Ф3 --> 017.4 --> 017.5 --[ЭТОТ СКРИПТ]--> 017.6
//
// Для каждого сценария скрипт:
//   1. прогоняет его под 017.6;
//   2. откатывает ровно одно поле — evidence.contractVersion — обратно к 017.5;
//   3. ТРЕБУЕТ, чтобы хеш этой проекции совпал с committed-голденом ПРЕДЫДУЩЕЙ эпохи и чтобы это
//      же значение было `active` предыдущего звена. Не совпало — ничего не пишется. До первой
//      записи этим якорем и является файл на диске; после записи файл содержит уже `active`, и
//      якорь берётся из карты (ветка `alreadyRebased` ниже) — иначе повторный прогон сообщал бы
//      о дрейфе, которого нет.
//
// Причина сдвига НАЗВАНА, а не предположена: контракт 017.6 отличается от 017.5 ровно новой ВЕТВЬЮ
// привязки требования к инструменту (`symbolFrom: 'actor'`), которой ни один из этих сценариев не
// пользуется — все их манифесты остались на фиксированной ветви. Значит в payload'е меняться нечему
// кроме самой строки версии, и именно это здесь доказывается откатом, а не принимается на слово.
//
// Побочно на этом же шаге приехали два минора SDK (0.20.0 — оракул result-digest, 0.21.0 —
// candle-origin). Оба живут в подпути `@trdlabs/sdk/historical`; движок его не импортирует, и в
// канонический payload оттуда ничего не попадает. Откат ниже — проверка и этого утверждения тоже.
//
// --reanchor СОЗНАТЕЛЬНО НЕ РЕАЛИЗОВАН — по той же причине, что и у предыдущего звена.
//
// Запуск: pnpm exec tsx apps/backtester/scripts/derive-017-6-goldens.mts [--write]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GOLDEN_SCENARIOS,
  PRE_S3_CONTRACT_VERSION,
  S3_CONTRACT_VERSION,
  proveS3ContractMigration,
  readCommittedGolden,
} from '../test/helpers/golden-scenarios.js';
import { assertOwnsGoldenFiles } from '../test/helpers/migration-chain.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MAP_PATH = resolve(REPO_ROOT, 'apps/backtester/test/fixtures/017-6-migration/hash-map.json');
const PREV_MAP_PATH = resolve(
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
  const proof = proveS3ContractMigration(await scenario.run());
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
  console.log(`  pre-S3 anchor : ${anchor}`);
  console.log(`  rolled back   : ${proof.legacyHash} ${equivalent ? '✓ equivalent' : '✗ DRIFTED'}`);
  console.log(`  new active    : ${proof.activeHash}`);
  console.log(`  diffPaths     : ${proof.diffPaths.join(', ') || '(none)'}`);

  if (!chained) {
    console.error(
      `  ✗ ${scenario.id}: якорь ${anchor} != active карты 017.5 ${prevActive ?? '(нет записи)'} — цепь миграций разорвана`,
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
  contract: { from: PRE_S3_CONTRACT_VERSION, to: S3_CONTRACT_VERSION },
  migration: {
    epic: '083 S3',
    slice: 'ступень 1 multi-symbol',
    cause:
      'Контракт поднялся 017.5 → 017.6 (SDK 0.22.0, engine 0.18.0): привязка требования к инструменту стала размеченным объединением. CONTRACT_VERSION входит в RunEvidence, а evidence — в канонический payload, поэтому бамп меняет content-hash каждого прогона. Новой ветвью (symbolFrom) ни один из этих сценариев не пользуется, поэтому кроме строки версии в payload меняться нечему — и это доказано откатом, а не принято на слово.',
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
assertOwnsGoldenFiles('017-6-migration');

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
