// Ф3 (shared-execution-engine) — перебазировка committed result-голденов под ДОКАЗАТЕЛЬСТВО.
//
// Скрипт не «прогнал и вставил новое значение». Для каждого сценария он:
//   1. прогоняет его на новом исполнительном ядре (`@trdlabs/engine`);
//   2. откатывает в результате ровно те ключи, которые Ф3 добавила к ФОРМЕ выхода: два поля
//      идентичности прогона (`evidence.evidenceFormatVersion`, `evidence.engineVersion`, решение
//      (A)) и маркер `Trade.synthetic` для принудительного end-of-data закрытия (решение SSOT 5);
//   3. ТРЕБУЕТ, чтобы хеш этой проекции совпал с committed-голденом ДО Ф3. Не совпал — скрипт
//      падает и ничего не пишет: значит переезд ядра сдвинул payload, и перебазировка спрятала бы
//      регрессию вместо того, чтобы её показать.
//
// Только после того, как все сценарии доказали эквивалентность, пишутся новые значения голденов и
// mapping-фикстура `test/fixtures/f3-engine-migration/hash-map.json` — коммитнутый артефакт
// миграции, по которому видно происхождение каждого нового хеша без раскопок в git.
//
// Запуск: pnpm exec tsx apps/backtester/scripts/derive-f3-goldens.mts [--write]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GOLDEN_SCENARIOS,
  proveEngineExtraction,
  readCommittedGolden,
} from '../test/helpers/golden-scenarios.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MAP_PATH = resolve(REPO_ROOT, 'apps/backtester/test/fixtures/f3-engine-migration/hash-map.json');
const WRITE = process.argv.includes('--write');

/** Коммит `trdlabs/engine`, на который запинован submodule `vendor/engine`. */
function enginePin(): string {
  const raw = readFileSync(resolve(REPO_ROOT, '.git/modules/vendor/engine/HEAD'), 'utf8').trim();
  return raw.startsWith('ref:')
    ? readFileSync(resolve(REPO_ROOT, '.git/modules/vendor/engine', raw.slice(4).trim()), 'utf8').trim()
    : raw;
}

interface Entry {
  readonly scenario: string;
  readonly source: string;
  readonly legacy: string;
  readonly active: string;
  readonly diffPaths: readonly string[];
}

const goldens: Record<string, Entry> = {};
let failed = 0;

for (const scenario of GOLDEN_SCENARIOS) {
  const proof = proveEngineExtraction(await scenario.run());
  const committed = readCommittedGolden(REPO_ROOT, scenario.goldenSource);

  // Гейт extraction-equivalence на одном сценарии: всё, кроме двух полей идентичности, обязано
  // остаться байт-в-байт прежним.
  const equivalent = proof.preF3Hash === committed;
  const onlyShape = proof.diffPaths.every((p) =>
    /\/evidence\/(evidenceFormatVersion|engineVersion)$|\/synthetic$/.test(p),
  );

  console.log(`${scenario.id}:`);
  console.log(`  committed (pre-Ф3): ${committed}`);
  console.log(`  rolled back       : ${proof.preF3Hash} ${equivalent ? '✓ equivalent' : '✗ DRIFTED'}`);
  console.log(`  new active        : ${proof.activeHash}`);
  console.log(`  diffPaths         : ${proof.diffPaths.join(', ') || '(none)'}`);
  if (!equivalent || !onlyShape || proof.diffPaths.length === 0) {
    console.error(
      `  ✗ ${scenario.id}: extraction equivalence NOT proven — refusing to rebase this golden`,
    );
    failed += 1;
    continue;
  }

  goldens[scenario.id] = {
    scenario: scenario.id,
    source: scenario.goldenSource,
    legacy: committed,
    active: proof.activeHash,
    diffPaths: [...proof.diffPaths].sort(),
  };
}

if (failed > 0) {
  console.error(`\n${failed} scenario(s) failed the equivalence gate — nothing written.`);
  process.exit(1);
}

const mapping = {
  migration: {
    initiative: 'shared-execution-engine',
    phase: 'Ф3',
    from: 'backtester-owned engine layer',
    to: '@trdlabs/engine',
    enginePin: enginePin(),
    cause:
      'run identity (A): RunEvidence carries its own evidenceFormatVersion + engineVersion (the research contract version stays an ordinary hashed field), plus SSOT decision 5: the forced end-of-data MTM close is now marked Trade.synthetic. Shape-only — no numeric field moved.',
  },
  goldens,
};

if (!WRITE) {
  console.log('\n(dry run — pass --write to rebase the goldens and the mapping fixture)');
  console.log(JSON.stringify(mapping, null, 2));
  process.exit(0);
}

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
