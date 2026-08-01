// PERF — декомпозиция ПОЛНОГО пути хука внутри харнесса.
//
// Зачем ещё один станок. Три уже есть, и между ними осталась дыра:
//   · `profile-isolate-boundary` — цена ПЕРЕХОДА, но внутри изолята у неё заглушка, не харнесс;
//   · `profile-rehydrate`        — только `rehydrateContext`, один шаг из семи;
//   · `--cpu-prof` на runner'е   — видит `evalHarness` одним native-кадром и внутрь не заглядывает.
//
// Отсюда неразобранный остаток: механизм вызова 7.2 мкс + rehydrate 3.2 мкс ≈ 10.4, а профиль
// показывает у `evalHarness` 33 мкс. Разница живёт внутри изолята, и ни один станок её не называл.
//
// МЕТОД. Тот же приём, что у `profile-rehydrate`: код харнесса — обычный ESM, и он гоняется здесь
// НА ХОСТЕ напрямую. Абсолютные числа внутри изолята отличаются (другой V8-инстанс, другой JIT),
// но декомпозиция и порядок величин — те самые. Это честнее, чем оценка вычитанием, которой я
// пользовался до сих пор.
//
// Лестница: каждый сценарий добавляет ровно один слой, цена слоя — разность соседних.
//
//   1 parse            — `JSON.parse` сообщения                        ← разбор входа
//   2 + rehydrate      — плюс восстановление контекста                 ← сборка ctx
//   3 + dispatch       — плюс поиск хука и его вызов                   ← сам бандл
//   4 hook (полный)    — весь `__isolateHarness.hook`, включая ответ    ← + normalize + stringify
//
// Сценарии ЧЕРЕДУЮТСЯ, а не идут фазами (урок bt#195): долгая фаза занимает ядро, фоновый
// оптимизирующий компилятор V8 не успевает, и следующая фаза весь прогон идёт неоптимизированной.
// Внутри прогона смещение постоянно, поэтому гейт воспроизводимости его не видит.
//
//   HOOK_BARS=20000 HOOK_REPEATS=7 pnpm exec tsx apps/backtester/scripts/profile-harness-hook.mts

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertQuietBench, assertStableSamples, minOf } from './lib/bench-gate.js';

assertQuietBench('profile-harness-hook');

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS = resolve(HERE, '../sandbox-harness-overlay');

const BARS = Math.max(1, Number(process.env.HOOK_BARS ?? 20_000));
const REPEATS = Math.max(3, Number(process.env.HOOK_REPEATS ?? 7));

interface Bar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function makeBar(i: number): Bar {
  const px = 100 + Math.sin(i / 50) * 5;
  return {
    ts: 1_700_000_000_000 + i * 60_000,
    open: px,
    high: px + 0.5,
    low: px - 0.5,
    close: px,
    volume: 1000,
  };
}

// Параметры сопоставимы по размеру с боевыми (`long_oi` — 1123 байта): они входят в снимок и
// потому разбираются на каждом баре. Пустой объект дал бы не ту цену `JSON.parse`.
const PARAMS = {
  trigger: { mode: 'high_to_low', pct: 10, windowMin: 20, minVolumeUsd: 250_000 },
  watch: { maxMinutes: 40, cooldownMinutes: 20, minBouncePct: 0.5, maxBouncePct: 4 },
  entry: { requireOiRecovery: true, oiRecoveryPct: 0.6, oiWindowMin: 3, minLongLiqUsd: 50_000 },
  tpLadder: { tp1Pct: 1.5, tp1Action: 'partial_exit', tp1ExitPercent: 50, tp2Pct: 3 },
  dca: { maxAdds: 2, dropPcts: [1.5, 3], sizeMultipliers: [1, 1.5], minGapMin: 5 },
  protection: { moveProtectionToBEAfterTp1: true, hardStopPct: 5, trailAfterTp2Pct: 1 },
  failFast: { enabled: false, afterMin: 12, maxAdversePct: 2.5 },
  sizing: { baseOrderUsd: 100, maxNotionalUsd: 500, maxConcurrentPositions: 5 },
  maxHoldMin: 180,
};

const SYMBOL = 'BTCUSDT';

function messageFor(bar: Bar, barIndex: number): string {
  return JSON.stringify({
    hook: 'onBarClose',
    snapshot: {
      run: { runId: 'harness-hook-bench', mode: 'research', seed: 1 },
      params: PARAMS,
      symbol: SYMBOL,
      barIndex,
      bar,
      position: null,
      pendingIntent: null,
      portfolio: { equity: 10_000, openPositions: 0 },
      clockNow: bar.ts,
    },
    newBar: bar,
  });
}

// Бандл-заглушка той же формы, что фикстуры станка: считает бары и возвращает idle. Работы в нём
// нет намеренно — меряется обвязка харнесса, а не стратегия.
const bundleModule = {
  default: function createStrategyModule() {
    let n = 0;
    return {
      manifest: { id: 'harness_hook_probe', version: '1.0.0' },
      onBarClose(_ctx: unknown) {
        n += 1;
        return { kind: 'idle' };
      },
      onPositionBar(_ctx: unknown) {
        return { kind: 'idle' };
      },
    };
  },
};
(globalThis as Record<string, unknown>).__bundleModule = bundleModule;

const { rehydrateContext, createSeededRng } = (await import(resolve(HARNESS, 'rehydrate.mjs'))) as {
  rehydrateContext: (snapshot: unknown, buffer: unknown[], rng: unknown) => unknown;
  createSeededRng: (seed: number) => unknown;
};
await import(resolve(HARNESS, 'isolate-entry.mjs'));
const harness = (globalThis as Record<string, unknown>).__isolateHarness as {
  initSymbol(symbol: string, seed: number): string;
  hook(msgJson: string): string;
};

const initRes = JSON.parse(harness.initSymbol(SYMBOL, 1)) as { ok: boolean; detail?: string };
if (!initRes.ok) {
  throw new Error(`харнесс не проинициализировался: ${initRes.detail ?? 'без причины'}`);
}

const bars = Array.from({ length: BARS }, (_, i) => makeBar(i));
const messages = bars.map((b, i) => messageFor(b, i));

// Отдельный экземпляр бандла для сценария «dispatch»: гонять тот же, что живёт в харнессе, нельзя —
// его состояние продвигалось бы дважды за итерацию и сценарии перестали бы быть сопоставимы.
const dispatchInstance = bundleModule.default();

let sink = 0;

interface Scenario {
  readonly label: string;
  readonly run: (msg: string, i: number) => void;
}

// Буферы свечей у каждого сценария СВОИ и растут одинаково: иначе `rehydrateContext` в одном
// сценарии видел бы более длинную историю, и разность слоёв смешалась бы с разностью данных.
const buffers: Bar[][] = [[], [], []];
const rngs = [createSeededRng(1), createSeededRng(1), createSeededRng(1)];

const SCENARIOS: readonly Scenario[] = [
  {
    label: 'parse            (разбор входа)',
    run: (msg) => {
      const m = JSON.parse(msg) as { snapshot: { barIndex: number } };
      sink += m.snapshot.barIndex;
    },
  },
  {
    label: '+ rehydrate      (сборка ctx)',
    run: (msg) => {
      const m = JSON.parse(msg) as { snapshot: unknown; newBar: Bar };
      buffers[0].push(m.newBar);
      const ctx = rehydrateContext(m.snapshot, buffers[0], rngs[0]) as { bar: Bar };
      sink += ctx.bar.ts % 7;
    },
  },
  {
    label: '+ dispatch       (вызов бандла)',
    run: (msg) => {
      const m = JSON.parse(msg) as { snapshot: unknown; newBar: Bar };
      buffers[1].push(m.newBar);
      const ctx = rehydrateContext(m.snapshot, buffers[1], rngs[1]);
      const out = dispatchInstance.onBarClose(ctx as never) as { kind: string };
      sink += out.kind.length;
    },
  },
  {
    label: 'hook (полный)    (+ normalize + ответ)',
    run: (msg) => {
      sink += harness.hook(msg).length;
    },
  },
];

/** Один проход сценария по всем барам; возвращает миллисекунды. */
function once(s: Scenario): number {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < BARS; i += 1) s.run(messages[i]!, i);
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

// Прогрев: по одному проходу каждого сценария, результат отбрасывается.
for (const s of SCENARIOS) void once(s);

// Буферы после прогрева обнуляем — иначе замерный проход стартовал бы с вдвое длинной историей.
for (const b of buffers) b.length = 0;

const samples: number[][] = SCENARIOS.map(() => []);
for (let r = 0; r < REPEATS; r += 1) {
  for (let s = 0; s < SCENARIOS.length; s += 1) {
    // Буфер сценария перед каждым повтором сбрасывается: длина истории обязана быть одинаковой
    // во всех повторах, иначе поздние повторы систематически дороже ранних.
    if (s === 1) buffers[0].length = 0;
    if (s === 2) buffers[1].length = 0;
    samples[s]!.push(once(SCENARIOS[s]!));
  }
}

console.log(`\n[harness-hook] баров=${BARS} повторов=${REPEATS} params=${JSON.stringify(PARAMS).length} байт\n`);
console.log('  слой                                        мс      мкс/бар      Δ к предыдущему');
console.log('  ─────────────────────────────────────────────────────────────────────────────────');

let prev: number | undefined;
for (let s = 0; s < SCENARIOS.length; s += 1) {
  const label = SCENARIOS[s]!.label;
  const arr = samples[s]!;
  assertStableSamples(`profile-harness-hook #${s + 1}`, arr);
  const best = minOf(arr);
  const per = (best * 1000) / BARS;
  const delta = prev === undefined ? '' : `${per - prev >= 0 ? '+' : ''}${(per - prev).toFixed(3)}`;
  console.log(`  ${label.padEnd(42)} ${best.toFixed(0).padStart(5)}  ${per.toFixed(3).padStart(10)}  ${delta.padStart(18)}`);
  prev = per;
}

console.log(`\n  (sink=${sink} — чтобы V8 не выбросил замеряемую работу)\n`);
