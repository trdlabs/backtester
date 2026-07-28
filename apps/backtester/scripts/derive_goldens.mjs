#!/usr/bin/env node
// Деривация и проверка committed result-голденов backtester'а.
//
// Раньше эти голдены назывались «platform-derived» и ссылались на
// `scripts/derive_slice6a_goldens.mjs` в trading-platform. Скрипта там больше нет и не будет: 041
// удалил из платформы research/backtest-движок. Владение переехало сюда; после Ф2 инициативы
// `shared-execution-engine` оно перейдёт к `@trdlabs/engine` вместе с golden tapes. Платформа
// владеет только contract acceptance gates.
//
//   node --import tsx apps/backtester/scripts/derive_goldens.mjs                       # проверить
//   node --import tsx apps/backtester/scripts/derive_goldens.mjs --write                # записать
//   … --write --reanchor --reason "<почему значения сдвинулись>"                        # переанкерить
//
// ПОПРАВКА ПОСЛЕ Ф3. Этот пруф ведётся на ДО-Ф3 проекции (`proveContractVersionMigration` снимает
// поля идентичности Ф3). Значит его `activeHash` — это пре-Ф3 якорь, а НЕ то, что лежит в файле
// голдена: там после Ф3 хеш полного payload'а. Сравнивать их между собой нельзя — они разной
// природы, и проверка, делавшая это, не могла пройти ни при каких значениях. Правильный партнёр
// для сверки — `legacy` из Ф3-карты, он же и есть пре-Ф3 якорь.
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
const reanchor = process.argv.includes('--reanchor');
const reasonAt = process.argv.indexOf('--reason');
const reason = reasonAt === -1 ? undefined : process.argv[reasonAt + 1];
if (reanchor && !write) {
  console.error('--reanchor требует --write');
  process.exit(2);
}
if (reanchor && (reason === undefined || reason.trim() === '')) {
  console.error('--reanchor требует --reason: якорь без причины это стёртая история');
  process.exit(2);
}
const F3_MAP_PATH = resolve(REPO_ROOT, 'apps/backtester/test/fixtures/f3-engine-migration/hash-map.json');
const f3Map = JSON.parse(readFileSync(F3_MAP_PATH, 'utf8'));
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
    if (reanchor) {
      console.log(`reanchored ${scenario.id}: legacy ${legacyExpected} -> ${proof.legacyHash}`);
    } else {
      fail(
        `${scenario.id}: legacy projection hash ${proof.legacyHash} != recorded ${legacyExpected} — ` +
          `something OTHER than the contract version moved (намеренный сдвиг: --reanchor --reason "…")`,
      );
    }
  }

  // 3. Пре-Ф3 якорь этой миграции обязан совпасть с `legacy` следующего звена цепи (Ф3).
  //    Файл голдена здесь НЕ участвует: после Ф3 в нём лежит хеш полного payload'а, величина
  //    другой природы. Владеет файлом `derive-f3-goldens.mts`, и он же его перебазирует.
  const f3Legacy = f3Map.goldens?.[scenario.id]?.legacy;
  if (f3Legacy !== undefined && proof.activeHash !== f3Legacy) {
    fail(
      `${scenario.id}: пре-Ф3 якорь ${proof.activeHash} != legacy Ф3-карты ${f3Legacy} — цепь миграций разорвана`,
    );
  }

  nextGoldens[scenario.id] = {
    scenario: scenario.id,
    source: scenario.goldenSource,
    legacy: reanchor && legacyExpected !== undefined && proof.legacyHash !== legacyExpected
      ? proof.legacyHash
      : (legacyExpected ?? proof.legacyHash),
    active: proof.activeHash,
    diffPaths: [...proof.diffPaths].sort(),
    ...(reanchor && legacyExpected !== undefined && proof.legacyHash !== legacyExpected
      ? { reanchoredFrom: legacyExpected, reanchorReason: reason }
      : recorded?.reanchoredFrom !== undefined
        ? { reanchoredFrom: recorded.reanchoredFrom, reanchorReason: recorded.reanchorReason }
        : {}),
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
