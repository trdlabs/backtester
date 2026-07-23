#!/usr/bin/env node
// Деривация и проверка committed result-голденов backtester'а.
//
// Раньше эти голдены назывались «platform-derived» и ссылались на
// `scripts/derive_slice6a_goldens.mjs` в trading-platform. Скрипта там больше нет и не будет: 041
// удалил из платформы research/backtest-движок. Владение переехало сюда; после Ф2 инициативы
// `shared-execution-engine` оно перейдёт к `@trdlabs/engine` вместе с golden tapes. Платформа
// владеет только contract acceptance gates.
//
//   node --import tsx apps/backtester/scripts/derive_goldens.mjs           # проверить (по умолчанию)
//   node --import tsx apps/backtester/scripts/derive_goldens.mjs --write   # перезаписать голдены
//
// Запись — ТОЛЬКО по явному флагу: голден, который переписывается сам при расхождении, ничего не
// доказывает. В обоих режимах прогоняется миграционное доказательство: свежий результат с
// откаченным `evidence.contractVersion` обязан дать в точности legacy-хеш, а structural diff между
// legacy- и активной проекциями обязан состоять только из путей, оканчивающихся на
// `/evidence/contractVersion`. Не сошлось — значит вместе с версией контракта уехало что-то ещё, и
// перезапись спрятала бы регрессию.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACTIVE_CONTRACT_VERSION,
  GOLDEN_SCENARIOS,
  LEGACY_CONTRACT_VERSION,
  proveContractVersionMigration,
  readCommittedGolden,
} from '../test/helpers/golden-scenarios.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MAP_PATH = resolve(REPO_ROOT, 'apps/backtester/test/fixtures/017-migration/hash-map.json');

const write = process.argv.includes('--write');
const errors = [];
const fail = (m) => errors.push(m);

const readMap = () => {
  try {
    return JSON.parse(readFileSync(MAP_PATH, 'utf8'));
  } catch {
    return { contract: { from: LEGACY_CONTRACT_VERSION, to: ACTIVE_CONTRACT_VERSION }, goldens: {} };
  }
};

const map = readMap();
const nextGoldens = {};

for (const scenario of GOLDEN_SCENARIOS) {
  const payload = await scenario.run();
  const proof = proveContractVersionMigration(payload);
  const recorded = map.goldens?.[scenario.id];

  // 1. Различие active↔legacy — только версия контракта, нигде больше.
  const offending = proof.diffPaths.filter((p) => !p.endsWith('/evidence/contractVersion'));
  if (offending.length > 0) {
    fail(`${scenario.id}: diff beyond the contract version: ${JSON.stringify(offending)}`);
  } else if (proof.diffPaths.length === 0) {
    fail(`${scenario.id}: legacy projection is identical — evidence.contractVersion not found in payload`);
  }

  // 2. Откат версии обязан восстановить ИМЕННО замороженный на 017.2 хеш.
  const legacyExpected = recorded?.legacy;
  if (legacyExpected === undefined) {
    if (!write) fail(`${scenario.id}: no legacy hash recorded in hash-map.json (run with --write once)`);
  } else if (proof.legacyHash !== legacyExpected) {
    fail(
      `${scenario.id}: legacy projection hash ${proof.legacyHash} != recorded ${legacyExpected} — ` +
        `something OTHER than the contract version moved`,
    );
  }

  // 3. Активный голден совпадает с тем, что лежит в репо.
  const committed = readCommittedGolden(REPO_ROOT, scenario.goldenSource);
  if (proof.activeHash !== committed) {
    if (write) {
      const path = resolve(REPO_ROOT, scenario.goldenSource);
      const raw = readFileSync(path, 'utf8');
      writeFileSync(
        path,
        scenario.goldenSource.endsWith('.hash')
          ? `${proof.activeHash}\n`
          : raw.replace(/sha256:[0-9a-f]{64}/, proof.activeHash),
        'utf8',
      );
      console.log(`wrote ${scenario.goldenSource}: ${committed} -> ${proof.activeHash}`);
    } else {
      fail(`${scenario.id}: active golden ${committed} != derived ${proof.activeHash} (${scenario.goldenSource})`);
    }
  }

  nextGoldens[scenario.id] = {
    scenario: scenario.id,
    source: scenario.goldenSource,
    legacy: legacyExpected ?? proof.legacyHash,
    active: proof.activeHash,
    diffPaths: [...proof.diffPaths].sort(),
  };
}

if (write && errors.length === 0) {
  writeFileSync(
    MAP_PATH,
    `${JSON.stringify(
      { contract: { from: LEGACY_CONTRACT_VERSION, to: ACTIVE_CONTRACT_VERSION }, goldens: nextGoldens },
      null,
      2,
    )}\n`,
    'utf8',
  );
  console.log(`wrote ${MAP_PATH}`);
}

if (errors.length > 0) {
  console.error('derive_goldens: FAIL');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(
  `derive_goldens: OK (${GOLDEN_SCENARIOS.length} goldens; ` +
    `${LEGACY_CONTRACT_VERSION} → ${ACTIVE_CONTRACT_VERSION} migration proven${write ? '; written' : ''})`,
);
