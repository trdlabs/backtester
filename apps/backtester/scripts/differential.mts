// Волна C — differential-харнесс на замороженных лентах.
//
// Он идёт ПЕРВЫМ шагом волны, потому что на её время заменяет golden'ы в роли детектора регрессий:
// волна C единственная двигает golden'ы, и при разъехавшихся хешах отличить ожидаемое численное
// изменение от сломанного поведения нечем.
//
// Два режима:
//
//   capture --out <dir>   прогнать замороженные сценарии и сложить артефакты в каталог
//   compare <before> <after> [--out отчёт.md] [--expect-changed a.b,c.d]   сравнить два каталога
//
// Как этим пользоваться правильно (важно):
//
//   git checkout perf/pre-wave-a
//   pnpm exec tsx apps/backtester/scripts/differential.mts capture --out .artifacts/diff/before
//   git checkout <ветка волны C>
//   pnpm exec tsx apps/backtester/scripts/differential.mts capture --out .artifacts/diff/after
//   pnpm exec tsx apps/backtester/scripts/differential.mts compare .artifacts/diff/before .artifacts/diff/after
//
// Эталон — `perf/pre-wave-a` (= состояние ДО волны A), а не текущий main. Иначе дрейф, случайно
// внесённый в волне A или B, будет запечён при переморозке и станет невидимым. Это единственная
// защита от того, что автономная сессия ускорит движок и одновременно тихо сломает поведение.
//
// Замер тут ни при чём: харнесс проверяет ЗНАЧЕНИЯ, а не время, поэтому гейт тишины стенда ему не
// нужен и он намеренно не подключён — иначе занятая машина блокировала бы проверку корректности.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BacktestRunRequest } from '@trading/research-contracts';

import {
  compareArtifacts,
  formatDifferentialReport,
  staleExceptions,
  type DifferentialReport,
} from './lib/differential-report.js';
import { buildOverlayDataset } from '../src/engine/data-adapter.js';
import { runOverlayBacktest } from '../src/engine/run-overlay.js';
import { buildTrustedRegistry } from '../src/engine/trusted-registry.js';
import { FixtureDataPort } from '../src/data/reader.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REQUESTS_DIR = resolve(HERE, '../test/fixtures/overlay/requests');
const FIXTURES_DIR = resolve(HERE, '../fixtures/candles');

const argv = process.argv.slice(2);
const mode = argv[0];
const flagValue = (name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};

function frozenScenarios(): readonly string[] {
  return readdirSync(REQUESTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
}

async function captureOne(file: string): Promise<unknown> {
  const request = JSON.parse(readFileSync(join(REQUESTS_DIR, file), 'utf8')) as BacktestRunRequest;
  const registry = buildTrustedRegistry();
  const marketTape = await buildOverlayDataset(new FixtureDataPort(FIXTURES_DIR), {
    datasetRef: request.datasetRef,
    symbols: request.symbols,
    timeframe: request.timeframe,
    period: request.period,
  });
  const outcome = await runOverlayBacktest(request, { registry, marketTape });
  // Сериализуем через JSON, а не через канонический сериализатор: канонический КВАНТУЕТ, то есть
  // спрятал бы ровно тот сдвиг, который волна C и производит. Здесь нужны сырые числа.
  return JSON.parse(JSON.stringify(outcome));
}

async function capture(outDir: string): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  for (const file of frozenScenarios()) {
    const artifact = await captureOne(file);
    writeFileSync(join(outDir, file), `${JSON.stringify(artifact, null, 2)}\n`);
    console.log(`[differential] captured ${file}`);
  }
  console.log(`[differential] ${frozenScenarios().length} сценариев → ${outDir}`);
}

function compare(beforeDir: string, afterDir: string, outPath?: string, expectChanged: readonly string[] = []): void {
  const reports = new Map<string, DifferentialReport>();
  const names = readdirSync(beforeDir).filter((f) => f.endsWith('.json')).sort();
  const afterNames = new Set(readdirSync(afterDir).filter((f) => f.endsWith('.json')));

  // Пропавший или появившийся сценарий — уже структурное расхождение, и молчать о нём нельзя:
  // сравнение «того, что нашлось в обоих» выглядело бы зелёным при потерянном сценарии.
  for (const name of names) {
    if (!afterNames.has(name)) {
      console.error(`[differential] сценарий ${name} есть в ${beforeDir}, но отсутствует в ${afterDir}`);
      process.exitCode = 2;
      return;
    }
  }
  for (const name of afterNames) {
    if (!names.includes(name)) {
      console.error(`[differential] сценарий ${name} появился в ${afterDir} — состав сценариев изменился`);
      process.exitCode = 2;
      return;
    }
  }

  // Пустой набор — НЕ зелёный вердикт. `every` на пустом множестве истинно, и без этой проверки
  // «сценариев не нашлось» печаталось бы как «переморозка разрешена». Ровно тот класс ошибки,
  // ради которого харнесс и существует.
  if (names.length === 0) {
    console.error(`[differential] в ${beforeDir} нет ни одного сценария — сравнивать нечего`);
    process.exitCode = 2;
    return;
  }

  for (const name of names) {
    const a = JSON.parse(readFileSync(join(beforeDir, name), 'utf8')) as unknown;
    const b = JSON.parse(readFileSync(join(afterDir, name), 'utf8')) as unknown;
    reports.set(name, compareArtifacts(a, b, '', expectChanged));
  }

  const report = formatDifferentialReport(reports, { expectChanged });
  console.log(report);
  if (outPath !== undefined) {
    writeFileSync(outPath, `${report}\n`);
    console.log(`\n[differential] отчёт → ${outPath}`);
  }

  // Код возврата — машинный гейт переморозки. 0 = сдвинулись только величины.
  const allowed =
    [...reports.values()].every((r) => r.refreezeAllowed) &&
    staleExceptions(reports, expectChanged).length === 0;
  if (!allowed) process.exitCode = 1;
}

if (mode === 'capture') {
  const out = flagValue('--out');
  if (out === undefined) {
    console.error('usage: differential.mts capture --out <dir>');
    process.exit(2);
  }
  await capture(resolve(out));
} else if (mode === 'compare') {
  const before = argv[1];
  const after = argv[2];
  if (before === undefined || after === undefined) {
    console.error('usage: differential.mts compare <beforeDir> <afterDir> [--out report.md]');
    process.exit(2);
  }
  // `--expect-changed a.b,c.d` — объявить расхождения ожидаемыми. Единственный законный случай:
  // маркер вроде `engineVersion`, обязанный измениться вместе с семантикой.
  const expect = (flagValue('--expect-changed') ?? '').split(',').map((x) => x.trim()).filter((x) => x !== '');
  compare(resolve(before), resolve(after), flagValue('--out'), expect);
} else {
  console.error('usage: differential.mts capture --out <dir> | compare <beforeDir> <afterDir> [--out report.md]');
  process.exit(2);
}
