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
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENGINE_VERSION } from '@trdlabs/engine';

import {
  GOLDEN_SCENARIOS,
  proveEngineExtraction,
  readCommittedGolden,
} from '../test/helpers/golden-scenarios.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MAP_PATH = resolve(REPO_ROOT, 'apps/backtester/test/fixtures/f3-engine-migration/hash-map.json');
const WRITE = process.argv.includes('--write');

/** How the engine is consumed today: a released npm version, read from the installed manifest. */
function engineRelease(): string {
  const req = createRequire(import.meta.url);
  const pkg = JSON.parse(readFileSync(req.resolve('@trdlabs/engine/package.json'), 'utf8')) as {
    version: string;
  };
  return `@trdlabs/engine@${pkg.version}`;
}

interface Entry {
  readonly scenario: string;
  readonly source: string;
  readonly legacy: string;
  readonly active: string;
  readonly diffPaths: readonly string[];
}

/**
 * Скрипт одноразовый по своей природе: он сверяет откат с ФАЙЛОМ голдена, а тот после перебазировки
 * уже содержит пост-Ф3 значение. Чтобы повторный запуск не читался как «дрейф», уже перебазированное
 * состояние распознаётся по коммитнутой карте и называется своим именем. Постоянную проверку ведёт
 * `test/engine-extraction-migration.test.ts` — он сверяется с `legacy` из карты, а не с файлом.
 */
const priorMap: { goldens?: Record<string, Entry>; migration?: { provenOnEngineCommit?: string } } = (() => {
  try {
    return JSON.parse(readFileSync(MAP_PATH, 'utf8')) as {
      goldens?: Record<string, Entry>;
      migration?: { provenOnEngineCommit?: string };
    };
  } catch {
    return {};
  }
})();

const goldens: Record<string, Entry> = {};
let failed = 0;

for (const scenario of GOLDEN_SCENARIOS) {
  const proof = proveEngineExtraction(await scenario.run());
  const committed = readCommittedGolden(REPO_ROOT, scenario.goldenSource);

  // Гейт extraction-equivalence на одном сценарии: всё, кроме двух полей идентичности, обязано
  // остаться байт-в-байт прежним.
  const recorded = priorMap.goldens?.[scenario.id];
  const alreadyRebased = recorded !== undefined && committed === recorded.active;
  // После перебазировки на диске лежит пост-Ф3 хеш, поэтому якорь эквивалентности — `legacy` карты.
  const anchor = alreadyRebased ? recorded.legacy : committed;
  const equivalent = proof.preF3Hash === anchor;
  const onlyShape = proof.diffPaths.every((p) =>
    /\/evidence\/(evidenceFormatVersion|engineVersion)$|\/trades\/\d+\/synthetic$/.test(p),
  );

  console.log(`${scenario.id}:${alreadyRebased ? ' (already rebased — verifying against the committed map)' : ''}`);
  console.log(`  pre-Ф3 anchor     : ${anchor}`);
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
    legacy: anchor,
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
    provenOnEngineCommit: priorMap.migration?.provenOnEngineCommit ?? '',
    consumedAs: engineRelease(),
    engineSemanticsVersion: ENGINE_VERSION,
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
