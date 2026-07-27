// Чистая часть перф-станка раннера (analysis/18, шаг 1 «замерить, потом решать про Rust-ядро»).
//
// Здесь нет ни Docker, ни изолята, ни файловой системы: генератор синтетической ленты произвольной
// длины + trusted-стратегия-замыкание. Цель станка — измерить ЧИСТУЮ стоимость JS-раннера на бар
// (processBar / builder.build / decisionRecords), отделив её от границы сэндбокса: PR#166 показал,
// что путь исполнителя стоит 77.5 мкс/бар (batch), а весь engine — ~0.58 мс/бар на T2-окне, то есть
// ~0.5 мс/бар живёт в самом раннере и НЕ объясняется транспортом.
//
// Почему trusted-замыкание, а не бандл в изоляте: хук-замыкание стоит десятки наносекунд, поэтому
// всё, что покажет профиль, — это работа раннера вокруг хука. Режим изолята меряется отдельно тем же
// станком (`PROFILE_BACKEND=isolate`) и служит верхней границей, сопоставимой с 48.6 с.

import { createTrustedRouter } from '../../src/engine/module-executor.js';
import { createModuleRegistry } from '../../src/engine/sandbox/routing.js';
import { marketTapeFromCanonicalRows } from '../../src/engine/market-tape.js';
import { DEFAULT_RISK } from '../../src/engine/profiles.js';
import type { RunDeps } from '../../src/engine/runner.js';
import { CONTRACT_VERSION } from '@trading/research-contracts/research';
import type {
  BacktestRunRequest,
  CanonicalRowV2,
  ExecutionProfile,
  StrategyModule,
} from '@trading/research-contracts/research';

const SAME_BAR_NO_COST: ExecutionProfile = {
  id: 'paper_match',
  version: '1.0.0',
  fillModel: { kind: 'same_bar_close' } as never,
  feeModel: { kind: 'fixed_bps', bps: 0 },
  slippageModel: { kind: 'fixed_bps', bps: 0 },
};

const MANIFEST = {
  id: 'perf_probe',
  version: '1.0.0',
  kind: 'strategy',
  name: 'runner perf probe',
  summary: 'periodic entry/exit probe for runner CPU profiling',
  rationale: 'exercises the order/record path at a realistic rate without costing CPU itself',
  author: 'agent',
  contractVersion: CONTRACT_VERSION,
  status: 'research_only',
  paramsSchema: { type: 'object', additionalProperties: false, properties: {} },
  params: {},
  capabilities: { platformSdk: true },
  dataNeeds: {},
  hooks: ['onBarClose', 'onPositionBar'],
} as const;

export const T0 = 1_700_000_000_000;

/** Профиль торговой активности зонда. Влияет на долю баров, где раннер идёт по «тяжёлой» ветке. */
export interface ProbeShape {
  /** Через сколько баров зонд открывает позицию. */
  readonly entryEvery: number;
  /** Сколько баров держит позицию (в эти бары раннер строит ВТОРОЙ контекст на onPositionBar). */
  readonly holdBars: number;
  /**
   * Сколько закрытых свечей зонд запрашивает на каждом баре (0 — не запрашивать).
   *
   * Ось существует, потому что `pointInTimeDataApi.closedCandles` (dataset.ts:106) на КАЖДЫЙ вызов
   * делает `Object.freeze(candles.slice(start, t))` — то есть копию длиной `lookback`. Реальные
   * стратегии смотрят историю каждый бар, дешёвый зонд — нет, и без этой оси станок мерил бы
   * заведомо оптимистичный скелет.
   */
  readonly lookback: number;
}

export const DEFAULT_PROBE: ProbeShape = { entryEvery: 500, holdBars: 50, lookback: 0 };

/**
 * Trusted-стратегия: каждые `entryEvery` баров входит в long, через `holdBars` выходит.
 *
 * Сам хук намеренно почти бесплатен (счётчик + литерал) — станок меряет раннер, а не стратегию.
 * `onPositionBar` объявлен ОСОЗНАННО: его наличие заставляет `processBar` строить второй
 * `StrategyContext` на каждом баре открытой позиции (runner.ts §(3) post_entry_management), и без
 * него профиль недооценил бы реальную стоимость.
 */
function makeProbeFactory(shape: ProbeShape): () => StrategyModule {
  return () => {
    let bar = 0;
    let heldFor = -1;
    return {
      manifest: MANIFEST,
      onBarClose: (ctx: { readonly data: { closedCandles(n: number): readonly unknown[] } }) => {
        bar += 1;
        // Читаем историю, НЕ считая по ней ничего: цена самого доступа к данным — это стоимость
        // раннера (копия среза), а не стратегии, и именно её надо увидеть отдельно.
        if (shape.lookback > 0) ctx.data.closedCandles(shape.lookback);
        if (heldFor < 0 && bar % shape.entryEvery === 0) {
          heldFor = 0;
          return { kind: 'enter', side: 'long' };
        }
        return { kind: 'idle' };
      },
      onPositionBar: () => {
        if (heldFor < 0) return { kind: 'idle' };
        heldFor += 1;
        if (heldFor >= shape.holdBars) {
          heldFor = -1;
          return { kind: 'exit' };
        }
        return { kind: 'idle' };
      },
    } as unknown as StrategyModule;
  };
}

/**
 * Детерминированный ценовой ряд: LCG-блуждание вокруг тренда, без обращения к Math.random,
 * чтобы прогон был воспроизводим побайтово (и годился как база сравнения для Rust-порта).
 */
export function syntheticRows(symbol: string, n: number, seed: number): CanonicalRowV2[] {
  const out: CanonicalRowV2[] = new Array(n);
  let state = seed >>> 0;
  let px = 100;
  for (let i = 0; i < n; i += 1) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    const drift = ((state >>> 16) / 65_536 - 0.5) * 0.4;
    px = Math.max(1, px + drift);
    const high = px + 0.5;
    const low = px - 0.5;
    out[i] = {
      schema_version: 2,
      minute_ts: T0 + i * 60_000,
      symbol,
      open: px,
      high,
      low,
      close: px,
      volume: 1000,
      turnover: px * 1000,
      oi_total_usd: null,
      funding_rate: null,
      liq_long_usd: null,
      liq_short_usd: null,
      has_oi: false,
      has_funding: false,
      has_liquidations: false,
      taker_buy_volume_usd: null,
      taker_sell_volume_usd: null,
      has_taker_flow: false,
    } as unknown as CanonicalRowV2;
  }
  return out;
}

export interface WorkloadSpec {
  readonly symbols: readonly string[];
  readonly bars: number;
  readonly seed: number;
  readonly barMajor: boolean;
  readonly probe?: ProbeShape;
}

export function makeRequest(spec: WorkloadSpec): BacktestRunRequest {
  return {
    runId: 'runner-perf-probe',
    mode: 'research',
    moduleRef: { id: MANIFEST.id, version: MANIFEST.version },
    datasetRef: 'runner-perf-probe',
    symbols: [...spec.symbols],
    timeframe: '1m',
    period: {
      from: new Date(T0).toISOString(),
      to: new Date(T0 + spec.bars * 60_000).toISOString(),
    },
    riskProfileRef: { id: DEFAULT_RISK.id, version: DEFAULT_RISK.version },
    executionProfileRef: { id: SAME_BAR_NO_COST.id, version: SAME_BAR_NO_COST.version },
    seed: spec.seed,
    metrics: ['pnl'],
  } as unknown as BacktestRunRequest;
}

/** Trusted `RunDeps` (без Docker/изолята) на синтетической ленте длиной `spec.bars`. */
export function makeTrustedDeps(spec: WorkloadSpec): RunDeps {
  const factory = makeProbeFactory(spec.probe ?? DEFAULT_PROBE);
  const probe = factory();
  const registry = createModuleRegistry({
    strategies: [Object.assign(probe, { moduleFactory: factory })],
    riskProfiles: [DEFAULT_RISK],
    executionProfiles: [SAME_BAR_NO_COST],
  });

  const allRows: CanonicalRowV2[] = [];
  for (const [i, symbol] of spec.symbols.entries()) {
    allRows.push(...syntheticRows(symbol, spec.bars, spec.seed + i * 7919));
  }
  const built = marketTapeFromCanonicalRows('runner-perf-probe', '1m', allRows);
  if (!built.ok) throw new Error('perf fixture tape build failed: ' + built.detail);

  return {
    registry,
    marketTape: built.tape,
    router: createTrustedRouter(),
    barMajor: spec.barMajor,
  } as RunDeps;
}
