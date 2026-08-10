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
//
// `--reanchor --reason "…"` — для ОДНОГО законного случая: значения сдвинулись намеренно и это
// доказано вне этого скрипта (волна C — квантизация ушла на границу артефакта; differential на
// замороженных лентах показал ноль структурных расхождений). Тогда утверждение «откат Ф3-полей
// восстанавливает до-Ф3 голден» перестаёт быть верным навсегда: тот голден замораживался под
// прежней арифметикой, и вернуть его нельзя, не подделав историю.
//
// Переанкеривание НЕ ослабляет структурную часть гейта: расхождение по-прежнему обязано состоять
// только из Ф3-полей формы. Двигается лишь абсолютный якорь, а прежнее значение с причиной
// остаётся в карте — чтобы новое число не читалось потом как «всегда таким было».

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENGINE_VERSION } from '@trdlabs/engine';

import {
  GOLDEN_SCENARIOS,
  proveEngineExtraction,
  readCommittedGolden,
} from '../test/helpers/golden-scenarios.js';
import { assertOwnsGoldenFiles } from '../test/helpers/migration-chain.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MAP_PATH = resolve(REPO_ROOT, 'apps/backtester/test/fixtures/f3-engine-migration/hash-map.json');
const WRITE = process.argv.includes('--write');
const REANCHOR = process.argv.includes('--reanchor');
const reasonAt = process.argv.indexOf('--reason');
const REASON = reasonAt === -1 ? undefined : process.argv[reasonAt + 1];
if (REANCHOR && !WRITE) {
  console.error('--reanchor требует --write: переанкеривание это запись, а не проверка');
  process.exit(2);
}
if (REANCHOR && (REASON === undefined || REASON.trim() === '')) {
  console.error('--reanchor требует --reason: якорь без причины это стёртая история');
  process.exit(2);
}

/**
 * How the engine is consumed today: the pinned npm version, read from OUR manifest.
 *
 * Не через `require.resolve('@trdlabs/engine/package.json')`: пакет не экспортирует этот подпуть
 * (`exports` содержит только `.`), поэтому такой резолв падает с ERR_PACKAGE_PATH_NOT_EXPORTED.
 * Пин в нашем манифесте — то же самое утверждение и не зависит от чужой карты экспортов.
 */
function engineRelease(): string {
  const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'apps/backtester/package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const version = pkg.dependencies?.['@trdlabs/engine'];
  if (version === undefined) throw new Error('derive-f3-goldens: @trdlabs/engine не найден в зависимостях');
  return `@trdlabs/engine@${version}`;
}

interface Entry {
  readonly scenario: string;
  readonly source: string;
  readonly legacy: string;
  readonly active: string;
  readonly diffPaths: readonly string[];
  /** Прежний якорь, если он переносился осознанно (`--reanchor`). */
  readonly reanchoredFrom?: string;
  readonly reanchorReason?: string;
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
  // Якорь эквивалентности — пре-Ф3 голден. До первой перебазировки он лежит в файле; после неё
  // файл принадлежит уже следующим звеньям цепи, и единственная запись пре-Ф3 значения — карта.
  //
  // Раньше признак «уже перебазировано» выводился сравнением файла с `active` ЭТОЙ карты. Это
  // держалось ровно пока Ф3 была головой цепи. 083 S1 добавил четвёртое звено и перебазировал
  // файл под 017.4 — теперь он не равен ни `active`, ни `legacy`, признак давал false, якорем
  // становился 017.4-хеш, и скрипт сравнивал пре-Ф3 проекцию с полным payload'ом: величины разной
  // природы, сойтись не могут ни при каких значениях. Читалось это как `DRIFTED` и толкало к
  // `--reanchor`, который молча сдвинул бы исторический якорь — то есть ровно к той подделке, от
  // которой гейт защищает.
  //
  // Карта — источник истины для своего якоря, и она не зависит от того, что с файлом сделали
  // звенья ниже по цепи. `committed` остаётся запасным вариантом лишь для самого первого прогона,
  // когда записи ещё нет.
  const alreadyRebased = recorded !== undefined && committed !== recorded.legacy;
  const anchor = recorded?.legacy ?? committed;
  const equivalent = proof.preF3Hash === anchor;
  const onlyShape = proof.diffPaths.every((p) =>
    /\/evidence\/(evidenceFormatVersion|engineVersion)$|\/trades\/\d+\/synthetic$/.test(p),
  );

  console.log(`${scenario.id}:${alreadyRebased ? ' (already rebased — verifying against the committed map)' : ''}`);
  console.log(`  pre-Ф3 anchor     : ${anchor}`);
  console.log(`  rolled back       : ${proof.preF3Hash} ${equivalent ? '✓ equivalent' : '✗ DRIFTED'}`);
  console.log(`  new active        : ${proof.activeHash}`);
  console.log(`  diffPaths         : ${proof.diffPaths.join(', ') || '(none)'}`);
  // Структурная часть гейта не ослабляется переанкериванием НИКОГДА: расхождение обязано состоять
  // только из Ф3-полей формы, иначе поехало поведение, а не арифметика.
  if (!onlyShape || proof.diffPaths.length === 0) {
    console.error(`  ✗ ${scenario.id}: расхождение вышло за пределы Ф3-полей формы — переанкеривание запрещено`);
    failed += 1;
    continue;
  }
  if (!equivalent && !REANCHOR) {
    console.error(
      `  ✗ ${scenario.id}: extraction equivalence NOT proven — refusing to rebase this golden` +
        ` (намеренный сдвиг значений переанкеривается флагом --reanchor --reason "…")`,
    );
    failed += 1;
    continue;
  }
  const moved = !equivalent;
  if (moved) console.log(`  ↳ переанкерено: ${anchor} -> ${proof.preF3Hash} (${REASON ?? ''})`);

  goldens[scenario.id] = {
    scenario: scenario.id,
    source: scenario.goldenSource,
    legacy: moved ? proof.preF3Hash : anchor,
    active: proof.activeHash,
    diffPaths: [...proof.diffPaths].sort(),
    // Прежний якорь не исчезает: иначе новое число со временем читалось бы как «всегда таким было».
    ...(moved
      ? { reanchoredFrom: anchor, reanchorReason: REASON }
      : recorded?.reanchoredFrom !== undefined
        ? { reanchoredFrom: recorded.reanchoredFrom, reanchorReason: recorded.reanchorReason }
        : {}),
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

// Файлы голденов общие на всю цепь, поэтому владеет ими только её голова. Проверка стоит ДО
// записи карты: отказ должен быть полным, а не «карту переписал, файлы нет» — половинчатая запись
// оставила бы карту и диск рассогласованными, и следующий прогон объявил бы дрейф там, где его нет.
assertOwnsGoldenFiles('f3-engine-migration');

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
