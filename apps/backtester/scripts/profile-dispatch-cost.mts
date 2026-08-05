// PERF — предельная цена одного dispatch по классам событий (S0, выход 3).
//
// Мерит НЕ полный путь, а прирост: N синтетических конвертов одного класса через ту же границу
// изолята, что и прод (applySync по прекомпилированной ссылке). Классы различаются только
// размером и формой конверта — работа внутри харнесса намеренно вырождена до счётчика, потому
// что нас интересует цена ПЕРЕСЕЧЕНИЯ и разбора, а не цена стратегии.
//
//   pnpm exec tsx apps/backtester/scripts/profile-dispatch-cost.mts
import ivm from 'isolated-vm';
import { assertQuietBench, assertStableSamples, minOf } from './lib/bench-gate.js';

assertQuietBench('profile-dispatch-cost');

const N = Math.max(1000, Number(process.env.PROFILE_EVENTS ?? 200_000));
const REPEATS = Math.max(3, Number(process.env.PROFILE_REPEATS ?? 5));

/** Классы событий и их конверты — форма ровно как в §3.1/§3.3 спеки. */
const CLASSES: Record<string, (i: number) => unknown> = {
  bar: (i) => ({ seq: i, eventTsUs: 1e15 + i * 60_000_000, subscriptionId: 1,
    event: { kind: 'market.candle.closed', o: 1, h: 2, l: 0.5, c: 1.5, v: 100 } }),
  market_point: (i) => ({ seq: i, eventTsUs: 1e15 + i * 60_000_000, subscriptionId: 2,
    event: { kind: 'market.open_interest.observed', value: 123456.75 } }),
  order: (i) => ({ seq: i, eventTsUs: 1e15 + i * 60_000_000, subscriptionId: 0,
    event: { kind: 'order.accepted', clientOrderId: 'c-' + i } }),
  fill: (i) => ({ seq: i, eventTsUs: 1e15 + i * 60_000_000, subscriptionId: 0,
    event: { kind: 'fill', clientOrderId: 'c-' + i, price: 1.5, qty: 10, fee: 0.01, last: true } }),
  timer: (i) => ({ seq: i, eventTsUs: 1e15 + i * 60_000_000, subscriptionId: 0,
    event: { kind: 'timer', timerId: 't-' + i } }),
};

const isolate = new ivm.Isolate({ memoryLimit: 128 });
const context = isolate.createContextSync();
context.evalSync('globalThis.__n = 0; globalThis.__d = (j) => { const e = JSON.parse(j); __n += e.seq === -1 ? 0 : 1; return 0; };');
const dispatch = context.global.getSync('__d', { reference: true });

/** Один замер: N конвертов одного класса через applySync. */
function measure(make: (i: number) => unknown): number {
  const payloads = Array.from({ length: N }, (_, i) => JSON.stringify(make(i)));
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i += 1) dispatch.applySync(undefined, [payloads[i]!]);
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

const names = Object.keys(CLASSES);
const samples = new Map<string, number[]>(names.map((n) => [n, []]));

// Чередование round-robin, не фазами: фазовый порядок оставляет следующую арму неоптимизированной.
for (let r = 0; r < REPEATS; r += 1) {
  for (const name of names) samples.get(name)!.push(measure(CLASSES[name]!));
}

console.log(`[profile-dispatch-cost] N=${N} повторов=${REPEATS}`);
for (const name of names) {
  const walls = samples.get(name)!.slice().sort((a, b) => a - b);
  assertStableSamples(`dispatch:${name}`, walls);
  const us = (minOf(walls) * 1000) / N;
  console.log(`  ${name.padEnd(14)} ${us.toFixed(3)} мкс/событие`);
}
isolate.dispose();
