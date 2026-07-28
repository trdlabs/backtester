// PERF — микростанок на постройку контекста (`PointInTimeContextBuilder.build` + `deepFreeze`).
//
// Зачем отдельно от `profile-runner.mts`. Полный прогон на этой машине шумит сильнее, чем эффект
// волны B: при разрешённом load average один и тот же код давал 82.9, 60.4 и 70.0 мкс/бар от
// прогона к прогону. На таком фоне разницу в 5–10 мкс/бар измерить нельзя — её не видно, даже если
// она есть.
//
// Микростанок решает это не «более точным таймером», а другим соотношением сигнала к шуму: он
// гоняет ТОЛЬКО `build()` десятки тысяч раз подряд, поэтому один прогон длится доли секунды и
// повторов можно сделать много. Минимум из большого k — устойчивая оценка там, где минимум из
// трёх десятисекундных прогонов ещё нет.
//
//   pnpm exec tsx apps/backtester/scripts/profile-context.mts
//   CTX_BARS=20000 CTX_REPEATS=15 pnpm exec tsx apps/backtester/scripts/profile-context.mts

import { assertQuietBench, assertStableSamples, minOf } from './lib/bench-gate.js';
import { T0 } from './lib/profile-runner-fixture.js';
import { PointInTimeContextBuilder } from '../src/engine/context.js';
import { createSeededRng } from '../src/determinism/rng.js';
import type { Bar } from '@trading/research-contracts/research';

assertQuietBench('profile-context');

const BARS = Math.max(1, Number(process.env.CTX_BARS ?? 20_000));
const REPEATS = Math.max(2, Number(process.env.CTX_REPEATS ?? 15));
// `CTX_FREEZE=false` меряет ту же постройку без пербарной заморозки — это и есть цена шага B2,
// снятая напрямую, а не выведенная из доли в профиле.
const FREEZE = process.env.CTX_FREEZE !== 'false';

// Лента строится здесь, а не через `syntheticRows`: станку нужны свечи, а не канонические строки,
// и лишний слой конвертации только запутал бы, что именно попадает в замер.
const candles: readonly Readonly<Bar>[] = Object.freeze(
  Array.from({ length: BARS }, (_, i) => {
    const px = 100 + Math.sin(i / 50) * 5;
    return Object.freeze({ ts: T0 + i * 60_000, open: px, high: px + 0.5, low: px - 0.5, close: px, volume: 1000 });
  }),
);

const builder = new PointInTimeContextBuilder({
  run: { runId: 'ctx-bench', mode: 'research', seed: 1 } as never,
  params: Object.freeze({}),
  symbol: 'BTCUSDT',
  candles,
  rng: createSeededRng(1),
}, { freeze: FREEZE });

// Состояние портфеля меняется от бара к бару — как в настоящем прогоне, иначе `deepFreeze` увидел
// бы один и тот же уже замороженный объект и станок мерил бы не то, что мерит раннер.
function stateAt(i: number) {
  return {
    position: i % 3 === 0 ? Object.freeze({ side: 'long', size: 1, entryPrice: candles[i]!.close }) : null,
    pendingIntent: null,
    portfolio: Object.freeze({ equity: 10_000 + i, openPositions: i % 3 === 0 ? 1 : 0 }),
  } as never;
}

function pass(): number {
  const started = process.hrtime.bigint();
  let sink = 0;
  for (let i = 0; i < BARS; i += 1) {
    const ctx = builder.build(i, stateAt(i));
    // Читаем поле, чтобы построенный контекст нельзя было выкинуть как мёртвый код.
    sink += ctx.bar.close;
  }
  if (!Number.isFinite(sink)) throw new Error('sink разошёлся — станок мерил не то');
  return Number(process.hrtime.bigint() - started) / 1e6;
}

pass(); // прогрев JIT
pass();

const samples: number[] = [];
for (let r = 0; r < REPEATS; r += 1) samples.push(pass());

assertStableSamples('profile-context', samples);
const best = minOf(samples);
console.log(
  `[profile-context] build(freeze=${FREEZE}) ×${BARS}: min ${best.toFixed(1)} мс = ${((best * 1000) / BARS).toFixed(2)} мкс/бар ` +
    `(max ${Math.max(...samples).toFixed(1)} мс из ${REPEATS} повторов)`,
);
