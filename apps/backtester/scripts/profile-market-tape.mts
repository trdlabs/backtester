// PERF — декомпозиция цены РЫНОЧНОЙ ЛЕНТЫ на баре.
//
// Зачем. Замер `PROFILE_MARKET_KINDS=true/false` на полном движке дал 18–25 мкс/бар — четверть-треть
// всего бара и самый крупный опознанный блок. Но это ОДНО число на весь путь: оно не говорит, где
// именно эти микросекунды, а профиль показывал по market-* всего 8.5 мкс, потому что видел только
// self-time самих функций, а цена размазана по четырём разным местам.
//
// Резать вслепую тут уже пробовали: в прошлой сессии был почти сделан кэш присутствия kind'а в
// `serializeContext`, и он был бы НЕВЕРЕН — `oiWindow(1)` пуст и когда вида нет в ленте, и когда бар
// вне сетки ленты (`idx < 0`), а это разные вещи (опущенный ключ против `null`). Правку откатили, но
// цену так и не измерили. Станок существует, чтобы измерить её до следующей попытки.
//
// ЧТО РАЗБИРАЕТСЯ. Лента платится в четырёх местах, и ни одно из них не видно в отрыве:
//
//   1. `pointInTimeMarketApi` — 9 замыканий + два `Object.freeze` на КАЖДОМ баре (market-access.ts);
//   2. `serializeContext` — зондирует поверхность окнами `oiWindow(1)`/`liqWindow(1)` только чтобы
//      узнать, несёт ли лента вид; каждое окно — `windowMinutes` + `map` + `freeze`. Плюс два
//      `asOf()` и два спреда объекта (context-serializer.ts);
//   3. полезная нагрузка — два лишних поля в `JSON.stringify` снимка;
//   4. внутри изолята — `buildMarketAccess` (ещё 4 замыкания + freeze) И более длинный обход
//      `deepFreeze`, которому теперь есть что морозить в `ctx.market`.
//
// МЕТОД. Лестница из пар «с лентой / без ленты» на ОДНОМ и том же коде: каждая ступень добавляет
// ровно один слой, а цена слоя — разность разностей. Две ленты строятся из одной фикстуры, отличаясь
// только флагом `marketKinds`, поэтому всё остальное (свечи, seed, длина) побайтово одинаково.
//
// Сценарии ЧЕРЕДУЮТСЯ, а не идут фазами (урок bt#195): долгая фаза занимает ядро, фоновый
// оптимизирующий компилятор V8 не успевает, и следующая фаза весь прогон идёт неоптимизированной.
//
// ПОСТУРА — ПРОДОВАЯ. Заморозка контекста по умолчанию ВЫКЛЮЧЕНА (`TAPE_FREEZE=1` включает), потому
// что прод её снимает (`BACKTESTER_CONTEXT_FREEZE_DISABLED`, bt#180). Забытый ключ станка уже однажды
// дал число с несуществующей конфигурации, и вывод пришлось отзывать.
//
// ═══ ЧТО ЭТОТ СТАНОК НЕ МЕРИТ — ЧИТАТЬ ДО ТОГО, КАК БРАТЬ ЕГО ЧИСЛО ═══
//
// Его итог — НЕ «цена ленты». Полная разница «с лентой / без» на движке ≈30 мкс/бар (замер с
// повторами внутри процесса, 2026-08-03), и профиль обеих арм раскладывает её так:
//
//   ~12 мкс  сборка мусора
//   ~11 мкс  граница изолята (evalHarness + callHook + TextDecoder)
//   ~9 мкс   собственно код ленты   ← ТОЛЬКО ЭТО и меряет станок (его 7.4 сходятся)
//
// Первых двух строк он не видит СТРУКТУРНО, и это не изъян, а следствие устройства: он не пересекает
// границу изолята, а оба датасета держит в одной куче — то есть разницу по памяти вычитает сам.
//
// Практический смысл: правкой `pointInTimeMarketApi` и зонда состава отыгрывается максимум третья
// строка. Две трети цены создаёт ОБЪЁМ рыночных данных на баре, и лечится он уменьшением этого
// объёма, а не микроправками в перечисленных функциях.
//
// И отдельно: `--trace-gc` на этом пути ВРЁТ. Барный цикл идёт в рабочем потоке (свой изолят),
// стратегия — в третьем; трассировка собирает не тот изолят и занижает GC почти вдесятеро. Гипотеза
// «лента давит на кучу» была на этом основании отвергнута ошибочно. Для GC здесь — только профиль.
//
//   TAPE_BARS=20000 TAPE_REPEATS=7 pnpm exec tsx apps/backtester/scripts/profile-market-tape.mts

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PointInTimeContextBuilder } from '../src/engine/context.js';
import { serializeContext } from '../src/engine/sandbox/context-serializer.js';
import { createSeededRng } from '../src/determinism/rng.js';
import { buildTape } from './lib/profile-runner-fixture.js';
import { assertQuietBench, assertStableSamples, minOf } from './lib/bench-gate.js';
import type { PerBarState } from '../src/engine/context.js';
import type { StrategyContext } from '@trading/research-contracts/research';

assertQuietBench('profile-market-tape');

const BARS = Math.max(100, Number(process.env.TAPE_BARS ?? 20_000));
const REPEATS = Math.max(3, Number(process.env.TAPE_REPEATS ?? 7));
const FREEZE = process.env.TAPE_FREEZE === '1';
const SYMBOL = 'BTCUSDT';

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS = resolve(HERE, '../sandbox-harness-overlay');

// Обе ленты — из одной фикстуры, отличие ровно одно: несёт ли она виды.
const tapeWith = buildTape({ symbols: [SYMBOL], bars: BARS, seed: 1, barMajor: false, marketKinds: true });
const tapeNo = buildTape({ symbols: [SYMBOL], bars: BARS, seed: 1, barMajor: false, marketKinds: false });

const candles = tapeWith.candles(SYMBOL);
if (candles.length < BARS) throw new Error(`лента короче запрошенного: ${candles.length} < ${BARS}`);

const RUN = Object.freeze({ runId: 'market-tape-bench', mode: 'research' as const, seed: 1 });
const PARAMS = Object.freeze({ tpLadder: { tp1Pct: 1.5, tp2Pct: 3 }, maxHoldMin: 180 });
const STATE: PerBarState = Object.freeze({
  position: null,
  pendingIntent: null,
  portfolio: Object.freeze({ equity: 10_000, openPositions: 0 }),
});

function builderFor(tape: typeof tapeWith): PointInTimeContextBuilder {
  return new PointInTimeContextBuilder(
    { run: RUN, params: PARAMS, symbol: SYMBOL, candles, rng: createSeededRng(1), marketTape: tape },
    { freeze: FREEZE },
  );
}

// Построители создаются ОДИН раз на прогон, как в раннере (они per-symbol): иначе станок мерил бы
// ещё и разовую материализацию сетки, которая в реальном прогоне амортизируется по всем барам.
//
// У КАЖДОГО сценария — СВОЙ построитель, и это не педантизм. Построитель держит per-symbol
// `IndicatorEngine`, который стримит свечи; общий построитель на три сценария означал бы, что его
// движок проходит бары трижды за повтор, и второй проход идёт по прогретому состоянию. В первом же
// локальном прогоне это было видно прямо в таблице: сценарий 3 делает СТРОГО БОЛЬШЕ работы, чем
// сценарий 1, а «измерился» быстрее. Парные разности от этого не страдали (каждая пара сравнивала
// одинаковый по счёту проход), но общий множитель, который приходится держать в уме, — это лишний
// повод ошибиться, и дешевле его убрать.
const bWith = [builderFor(tapeWith), builderFor(tapeWith), builderFor(tapeWith)];
const bNo = [builderFor(tapeNo), builderFor(tapeNo), builderFor(tapeNo)];
const bProbe = { with: builderFor(tapeWith), no: builderFor(tapeNo) };

// Проверка, что ленты и правда различаются по составу — иначе весь замер измерял бы ноль.
{
  const probeWith = bProbe.with.build(1, STATE) as StrategyContext;
  const probeNo = bProbe.no.build(1, STATE) as StrategyContext;
  if (probeWith.market === undefined) throw new Error('лента "с видами" не выставила ctx.market — фикстура сломана');
  if (probeNo.market !== undefined) throw new Error('лента "без видов" выставила ctx.market — фикстура сломана');
  const snap = serializeContext(probeWith, 1) as unknown as Record<string, unknown>;
  if (!('oiAsOf' in snap)) throw new Error('снимок "с видами" не несёт oiAsOf — зонд состава сломан');
}

const { rehydrateContext } = (await import(resolve(HARNESS, 'rehydrate.mjs'))) as {
  rehydrateContext: (s: unknown, buf: unknown[], rng: unknown, oi?: unknown[], liq?: unknown[]) => unknown;
};

let sink = 0;

interface Scenario {
  readonly label: string;
  readonly run: (i: number) => void;
  /** Буферы сценария сбрасываются перед каждым повтором (для регидрации). */
  readonly reset?: () => void;
}

// ── Часть Б: внутриизолятная половина, гоняется на хосте напрямую ────────────────────────────────
// Код харнесса — обычный ESM. Абсолюты внутри изолята другие (свой V8-инстанс, свой JIT), но
// декомпозиция та самая, и это честнее оценки вычитанием.
const rehydBuffers: unknown[][] = [[], []];
const rehydOi: unknown[] = [];
const rehydLiq: unknown[] = [];
const rehydRngs = [createSeededRng(1), createSeededRng(1)];

const snapWith = serializeContext(bProbe.with.build(1, STATE) as StrategyContext, 1);
const snapNo = serializeContext(bProbe.no.build(1, STATE) as StrategyContext, 1);

const SCENARIOS: readonly Scenario[] = [
  {
    label: '1 build            без ленты',
    run: (i) => { sink += (bNo[0]!.build(i, STATE) as StrategyContext).bar.ts % 7; },
  },
  {
    label: '2 build            С ЛЕНТОЙ',
    run: (i) => { sink += (bWith[0]!.build(i, STATE) as StrategyContext).bar.ts % 7; },
  },
  {
    label: '3 +serialize       без ленты',
    run: (i) => { sink += serializeContext(bNo[1]!.build(i, STATE) as StrategyContext, i).barIndex % 7; },
  },
  {
    label: '4 +serialize       С ЛЕНТОЙ',
    run: (i) => { sink += serializeContext(bWith[1]!.build(i, STATE) as StrategyContext, i).barIndex % 7; },
  },
  {
    label: '5 +stringify       без ленты',
    run: (i) => { sink += JSON.stringify(serializeContext(bNo[2]!.build(i, STATE) as StrategyContext, i)).length; },
  },
  {
    label: '6 +stringify       С ЛЕНТОЙ',
    run: (i) => { sink += JSON.stringify(serializeContext(bWith[2]!.build(i, STATE) as StrategyContext, i)).length; },
  },
  {
    label: '7 rehydrate        без ленты',
    run: () => {
      rehydBuffers[0]!.push(candles[rehydBuffers[0]!.length]!);
      sink += rehydrateContext(snapNo, rehydBuffers[0]!, rehydRngs[0], [], []) === undefined ? 0 : 1;
    },
    reset: () => { rehydBuffers[0]!.length = 0; },
  },
  {
    label: '8 rehydrate        С ЛЕНТОЙ',
    run: () => {
      const n = rehydBuffers[1]!.length;
      rehydBuffers[1]!.push(candles[n]!);
      rehydOi.push({ ts: candles[n]!.ts, oiTotalUsd: 1_000_000 + n });
      rehydLiq.push({ ts: candles[n]!.ts, longUsd: 10 + n, shortUsd: 20 + n });
      sink += rehydrateContext(snapWith, rehydBuffers[1]!, rehydRngs[1], rehydOi, rehydLiq) === undefined ? 0 : 1;
    },
    reset: () => { rehydBuffers[1]!.length = 0; rehydOi.length = 0; rehydLiq.length = 0; },
  },
];

/** Один проход сценария по всем барам; возвращает миллисекунды. */
function once(s: Scenario): number {
  s.reset?.();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < BARS; i += 1) s.run(i);
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

for (const s of SCENARIOS) void once(s); // прогрев, результат отбрасывается

const samples: number[][] = SCENARIOS.map(() => []);
for (let r = 0; r < REPEATS; r += 1) {
  for (let s = 0; s < SCENARIOS.length; s += 1) samples[s]!.push(once(SCENARIOS[s]!));
}

const per: number[] = [];
console.log(`\n[market-tape] баров=${BARS} повторов=${REPEATS} заморозка=${FREEZE ? 'ВКЛ' : 'выкл (как в проде)'}\n`);
console.log('  сценарий                              мс      мкс/бар');
console.log('  ──────────────────────────────────────────────────────');
for (let s = 0; s < SCENARIOS.length; s += 1) {
  assertStableSamples(`profile-market-tape #${s + 1}`, samples[s]!);
  const best = minOf(samples[s]!);
  const p = (best * 1000) / BARS;
  per.push(p);
  console.log(`  ${SCENARIOS[s]!.label.padEnd(36)} ${best.toFixed(0).padStart(5)}  ${p.toFixed(3).padStart(10)}`);
}

// Атрибуция — разность разностей. Каждая строка отвечает за ровно один слой.
const surface = per[1]! - per[0]!;
const probe = per[3]! - per[2]! - surface;
const payload = per[5]! - per[4]! - (per[3]! - per[2]!);
const hostTotal = per[5]! - per[4]!;
const isolate = per[7]! - per[6]!;

console.log('\n  статья                                        мкс/бар');
console.log('  ──────────────────────────────────────────────────────');
console.log(`  поверхность pointInTimeMarketApi (host)  ${surface.toFixed(3).padStart(12)}`);
console.log(`  зонд состава + поля в serialize (host)   ${probe.toFixed(3).padStart(12)}`);
console.log(`  полезная нагрузка stringify (host)       ${payload.toFixed(3).padStart(12)}`);
console.log(`  ── хостовая половина, итого              ${hostTotal.toFixed(3).padStart(12)}`);
console.log(`  buildMarketAccess + deepFreeze (изолят)  ${isolate.toFixed(3).padStart(12)}`);
console.log(`  ══ ЛЕНТА, ИТОГО                          ${(hostTotal + isolate).toFixed(3).padStart(12)}`);
console.log(`\n  (sink=${sink} — чтобы V8 не выбросил замеряемую работу)\n`);
