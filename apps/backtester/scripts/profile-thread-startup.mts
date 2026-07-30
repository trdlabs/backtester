// ИЗ ЧЕГО СОСТОИТ СЕКУНДА СТАРТА ПОТОКА — и можно ли её не платить.
//
// Замер `bench-thread-threshold` дал потоку постоянную цену ≈1 с. Из неё выводится порог: ниже
// стольких-то баров вынос цикла в поток — убыток. Но прежде чем закреплять порог, надо понять,
// ЧТО ИМЕННО стоит эту секунду, потому что от ответа зависит, нужен ли порог вообще.
//
// Гипотеза: это НЕ создание потока (в Node оно стоит миллисекунды), а импорт графа модулей под
// загрузчиком TypeScript. Если так, то цена привязана к ПОТОКУ, а не к ПРОГОНУ, и тёплый пул
// (поток создаётся один раз, изолят — свежий на каждый прогон) убирает её целиком. Тогда порог не
// нужен ни для лёгкой стратегии, ни для тяжёлой — а он от стратегии зависит: выигрыш потока это
// плата за одно пересечение границы изолята, и чем больше стратегия считает внутри хука, тем
// меньше остаётся экономить (bt#196: 144 мкс при пустом хуке против 18 мкс при ~1 мс счёта).
//
// Ступени лестницы — вложенные, каждая добавляет ровно одну статью:
//   1) создать поток и дождаться готовности — только `new Worker` на пустом entry;
//   2) то же плюс импорт графа модулей барного цикла (`bar-loop-worker.mts` без прогона);
//   3) второй прогон в ТОМ ЖЕ потоке — показывает, сколько стоит прогон, когда граф уже импортирован.
//
// Третья ступень и есть ответ на главный вопрос: если она много дешевле второй, тёплый пул окупается.
//
//   pnpm exec tsx apps/backtester/scripts/profile-thread-startup.mts

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { assertQuietBench, assertStableSamples, minOf } from './lib/bench-gate.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPEATS = Math.max(3, Number(process.env.PTS_REPEATS ?? 5));

assertQuietBench('profile-thread-startup');

const scratch = mkdtempSync(join(tmpdir(), 'pts-'));
const emptyEntry = join(scratch, 'empty-worker.mjs');
writeFileSync(
  emptyEntry,
  `import { parentPort } from 'node:worker_threads';\nparentPort.postMessage('ready');\nparentPort.on('message', () => parentPort.postMessage('pong'));\n`,
);

/** Entry, который импортирует ТОТ ЖЕ граф, что и барный цикл, но ничего не считает. */
const graphEntry = join(scratch, 'graph-worker.mts');
const barLoopDir = resolve(HERE, '../src/engine/thread');
writeFileSync(
  graphEntry,
  `import { parentPort } from 'node:worker_threads';
const port = parentPort;
port.postMessage('ready');
port.on('message', async () => {
  // Тот же набор динамических импортов, что и в bar-loop-worker.mts.
  await Promise.all([
    import(${JSON.stringify(join(barLoopDir, '../run-strategy.js'))}),
    import(${JSON.stringify(join(barLoopDir, '../data-adapter.js'))}),
    import(${JSON.stringify(join(barLoopDir, '../../data/reader.js'))}),
    import(${JSON.stringify(join(barLoopDir, '../sandbox/overlay-router-spec.js'))}),
    import(${JSON.stringify(join(barLoopDir, '../sandbox/bundle.js'))}),
    import(${JSON.stringify(join(barLoopDir, '../trusted-registry.js'))}),
    import(${JSON.stringify(join(barLoopDir, '../tape-columns.js'))}),
  ]);
  port.postMessage('imported');
});
`,
);

/** execArgv с загрузчиком TypeScript — тот же, что использует шов (`run-in-thread.ts`). */
function execArgvWithLoader(): string[] {
  const hasTsLoader = process.execArgv.some((a) => a.includes('tsx'));
  return hasTsLoader ? [...process.execArgv] : ['--import', 'tsx', ...process.execArgv];
}

const ms = (t0: bigint): number => Number(process.hrtime.bigint() - t0) / 1e6;

/** Ступень 1: только создание потока (entry — обычный `.mjs`, загрузчик не нужен). */
async function rungSpawnOnly(): Promise<number> {
  const t0 = process.hrtime.bigint();
  const w = new Worker(emptyEntry);
  await new Promise<void>((res) => w.once('message', () => res()));
  const dt = ms(t0);
  await w.terminate();
  return dt;
}

/** Ступень 2: создание потока ПОД ЗАГРУЗЧИКОМ плюс импорт графа барного цикла. */
async function rungSpawnPlusGraph(): Promise<{ total: number; spawn: number; imports: number }> {
  const t0 = process.hrtime.bigint();
  const w = new Worker(graphEntry, { execArgv: execArgvWithLoader() });
  await new Promise<void>((res) => w.once('message', () => res()));
  const spawn = ms(t0);
  const t1 = process.hrtime.bigint();
  w.postMessage('go');
  await new Promise<void>((res) => w.once('message', () => res()));
  const imports = ms(t1);
  await w.terminate();
  return { total: spawn + imports, spawn, imports };
}

/** Ступень 3: ВТОРОЙ импорт в том же потоке — сколько стоит повторное использование тёплого потока. */
async function rungWarmSecondUse(): Promise<number> {
  const w = new Worker(graphEntry, { execArgv: execArgvWithLoader() });
  await new Promise<void>((res) => w.once('message', () => res()));
  w.postMessage('go');
  await new Promise<void>((res) => w.once('message', () => res()));
  // Первый импорт оплачен — меряем второй.
  const t0 = process.hrtime.bigint();
  w.postMessage('go');
  await new Promise<void>((res) => w.once('message', () => res()));
  const dt = ms(t0);
  await w.terminate();
  return dt;
}

// Чередование, а не фазы: помеха раскладывается на все ступени поровну (bt#195).
const spawnOnly: number[] = [];
const spawnLoader: number[] = [];
const graphImport: number[] = [];
const warmReuse: number[] = [];

for (let rep = 0; rep <= REPEATS; rep += 1) {
  const a = await rungSpawnOnly();
  const b = await rungSpawnPlusGraph();
  const c = await rungWarmSecondUse();
  if (rep === 0) continue; // прогрев
  spawnOnly.push(a);
  spawnLoader.push(b.spawn);
  graphImport.push(b.imports);
  warmReuse.push(c);
}

for (const [label, s] of [
  ['создание потока', spawnOnly],
  ['создание под загрузчиком', spawnLoader],
  ['импорт графа', graphImport],
  ['повторное использование', warmReuse],
] as const) {
  assertStableSamples(label, s);
}

const mSpawn = minOf(spawnOnly);
const mSpawnLoader = minOf(spawnLoader);
const mGraph = minOf(graphImport);
const mWarm = minOf(warmReuse);
const coldTotal = mSpawnLoader + mGraph;

console.log('\n  ИЗ ЧЕГО СКЛАДЫВАЕТСЯ СТАРТ ПОТОКА (минимум из повторов)\n');
console.log(`    создание потока, entry без типов        ${mSpawn.toFixed(0).padStart(7)} мс`);
console.log(`    создание потока под загрузчиком tsx     ${mSpawnLoader.toFixed(0).padStart(7)} мс`);
console.log(`    импорт графа модулей барного цикла      ${mGraph.toFixed(0).padStart(7)} мс`);
console.log(`   ─────────────────────────────────────────────────`);
console.log(`    ХОЛОДНЫЙ старт, итого                  ${coldTotal.toFixed(0).padStart(7)} мс`);
console.log(`    повторное использование тёплого потока  ${mWarm.toFixed(0).padStart(7)} мс`);

const share = (100 * mGraph) / coldTotal;
console.log(`\n  Доля импорта графа в холодном старте: ${share.toFixed(0)}%`);
console.log(`  Экономия от тёплого потока: ${(coldTotal - mWarm).toFixed(0)} мс на прогон\n`);

if (share > 60) {
  console.log('  ВЫВОД: цена привязана к ПОТОКУ, а не к прогону. Тёплый пул убирает её целиком,');
  console.log('  и порог по числу баров становится не нужен — ни для лёгкой стратегии, ни для тяжёлой.\n');
} else {
  console.log('  ВЫВОД: импорт графа не доминирует — тёплый пул экономит мало, порог остаётся нужен.\n');
}

rmSync(scratch, { recursive: true, force: true });
