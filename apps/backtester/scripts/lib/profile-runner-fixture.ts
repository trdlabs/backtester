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

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

import { loadConfig } from '../../src/config.js';
import { createTrustedRouter } from '../../src/engine/module-executor.js';
import { createExecutorRouter, createModuleRegistry } from '../../src/engine/sandbox/routing.js';
import { createSandboxPolicyRegistry } from '../../src/engine/sandbox-policy.js';
import { loadBundle } from '../../src/engine/sandbox/bundle.js';
import { marketTapeFromCanonicalRows } from '../../src/engine/market-tape.js';
import { DEFAULT_EXEC, DEFAULT_RISK } from '../../src/engine/profiles.js';
import type { RunDeps } from '../../src/engine/runner.js';
import { CONTRACT_VERSION } from '@trading/research-contracts/research';
import type {
  BacktestRunRequest,
  CanonicalRowV2,
  ExecutionProfile,
  MarketTapeDataset,
  StrategyModule,
} from '@trading/research-contracts/research';

const SAME_BAR_NO_COST: ExecutionProfile = {
  id: 'paper_match',
  version: '1.0.0',
  fillModel: { kind: 'same_bar_close' } as never,
  feeModel: { kind: 'fixed_bps', bps: 0 },
  slippageModel: { kind: 'fixed_bps', bps: 0 },
};

/**
 * Параметры стратегии, сопоставимые по размеру с боевыми.
 *
 * Зачем. `params` входят в снимок контекста и потому `JSON.stringify`-уются в сообщение изоляту
 * НА КАЖДОМ БАРЕ, хотя весь прогон неизменны. Станок держал `params: {}` — то есть единственную
 * конфигурацию, которой в проде не бывает: у боевой `long_oi` `DEFAULT_PARAMS` весит 1123 байта.
 *
 * ЗАМЕРЕНО (зеркало, 60 тыс. баров, чередование арм, минимумы): пустые params — 77.0 мкс/бар,
 * 840 байт — 74.8. Разницы НЕТ, арма с параметрами даже быстрее. То есть на этом объёме payload
 * цена перехода от размера практически не зависит.
 *
 * Это ОПРОВЕРГАЕТ наклон «9.7 мкс на килобайт», выведенный из `profile-isolate-boundary`: у той
 * лестницы в собственных данных 512 байт мерились медленнее 653, что и было признаком шума.
 * Вывод для будущих правок: выносить инварианты (`params`/`run`) за границу ради скорости
 * СМЫСЛА НЕТ — механизм вызова стоит дорого сам по себе, а не из-за байтов.
 *
 * Фикстура всё равно остаётся реалистичной: конфигурация станка должна совпадать с прод-постурой
 * по умолчанию, иначе следующий забытый ключ снова даст число, к проду не относящееся.
 *
 * Форма скопирована со структуры long_oi (ладдер TP, DCA-массивы, окна, защита), а не набрана
 * случайным мусором: размер должен набираться так же — вложенностью и числом ключей, потому что
 * от этого зависит и стоимость `JSON.parse` внутри изолята, не только длина строки.
 */
const REALISTIC_PARAMS = {
  trigger: { mode: 'high_to_low', pct: 10, windowMin: 20, minVolumeUsd: 250_000 },
  watch: { maxMinutes: 40, cooldownMinutes: 20, minBouncePct: 0.5, maxBouncePct: 4 },
  entry: { requireOiRecovery: true, oiRecoveryPct: 0.6, oiWindowMin: 3, requireLongLiq: true, minLongLiqUsd: 50_000 },
  tpLadder: { tp1Pct: 1.5, tp1Action: 'partial_exit', tp1ExitPercent: 50, tp2Pct: 3 },
  dca: { maxAdds: 2, dropPcts: [1.5, 3], sizeMultipliers: [1, 1.5], requireOiConfirm: true, minGapMin: 5 },
  protection: { moveProtectionToBEAfterTp1: true, hardStopPct: 5, trailAfterTp2Pct: 1 },
  failFast: { enabled: false, afterMin: 12, maxAdversePct: 2.5, requireNoTp1: true },
  warmup: { candlesMin: 30, requireOiHistory: true, requireLiqHistory: false },
  // ВНИМАНИЕ: сюда нельзя класть `sizing`/`filters`/лимиты риска и исполнения. Валидатор бьёт
  // `separation_violation` (FR-015): размер ордера и фильтры инструментов — зона RiskProfile /
  // ExecutionProfile, а не параметров стратегии. Первая редакция фикстуры содержала `sizing`,
  // и это поймал CI, а не локальный `tsc`: правку ФИКСТУРЫ надо гонять тестами, а не только типами.
  oiRecovery: { windowMin: 3, minPct: 0.6, smoothing: 'none', requireMonotonic: false },
  liqConfirm: { windowMin: 5, minLongUsd: 50_000, minRatioPct: 60, ignoreShortSide: true },
  bounce: { minPct: 0.5, maxPct: 4, measureFrom: 'local_low', confirmBars: 2 },
  maxHoldMin: 180,
  hardStopPct: 5,
} as const;

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
  // `additionalProperties: true` — схема здесь не проверяет форму, а лишь пропускает параметры;
  // цель фикстуры в том, чтобы через границу ходил реалистичный по размеру объект.
  paramsSchema: { type: 'object', additionalProperties: true, properties: {} },
  params: REALISTIC_PARAMS,
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
/**
 * Несёт ли синтетическая лента рыночные виды (OI / funding / ликвидации / taker).
 *
 * Знать это обязательно, потому что виды меняют не значения, а СОСТАВ работы на баре:
 * `PointInTimeContextBuilder` выставляет `ctx.market` только когда лента несёт хотя бы один вид,
 * и тогда на каждом баре дополнительно строится PIT-поверхность, а `serializeContext` ещё и
 * зондирует её окнами. Без видов вся эта ветка не исполняется вовсе.
 *
 * До появления этого флага станок умел мерить ТОЛЬКО ленту без видов — то есть форму, которой на
 * проде не бывает: боевые ленты `mock-platform` несут все четыре. Замеры станка поэтому были
 * неполны по построению, и расхождение с прод-путём списывалось на машину.
 */
export function syntheticRows(symbol: string, n: number, seed: number, marketKinds = false): CanonicalRowV2[] {
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
      // Значения выведены из той же цены — детерминированы и не требуют второго генератора.
      oi_total_usd: marketKinds ? px * 1_000_000 : null,
      funding_rate: marketKinds ? 0.0001 : null,
      liq_long_usd: marketKinds ? px * 10 : null,
      liq_short_usd: marketKinds ? px * 8 : null,
      has_oi: marketKinds,
      has_funding: marketKinds,
      has_liquidations: marketKinds,
      taker_buy_volume_usd: marketKinds ? px * 500 : null,
      taker_sell_volume_usd: marketKinds ? px * 480 : null,
      has_taker_flow: marketKinds,
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
  /**
   * Какой модуль исполняет прогон. `probe` — trusted-замыкание (меряет скелет раннера);
   * `bundle` — реальный бандл в V8-изоляте (меряет то, что реально стоит прод-путь).
   */
  readonly module?: { readonly id: string; readonly version: string };
  /** Несёт ли лента рыночные виды. Прод-ленты несут все четыре; `false` — форма, которой на проде нет. */
  readonly marketKinds?: boolean;
  /** Батч баров 17b. Отсутствие/меньше 2 ⇒ выключен, как в проде. */
  readonly batchBars?: number;
  /** Путь к настоящей ленте (`.ndjson`/`.ndjson.gz`). Задан ⇒ `bars`/`seed`/`marketKinds` не используются. */
  readonly tapeFile?: string;
  /**
   * Профили риска и исполнения: `nocost` (историческая точка отсчёта станка) или `prod`.
   *
   * `nocost` — `paper_match`: заполнение по закрытию ТОГО ЖЕ бара, нулевые комиссия и проскальзывание.
   * Выбран когда-то ради сравнимости trusted- и isolate-режимов между собой.
   * `prod` — `default_exec`: заполнение по открытию СЛЕДУЮЩЕГО бара, настоящие bps. Это то, что
   * исполняет прод, и на торговом пути разница не косметическая: расчёт pending переносится на
   * следующий бар, считаются комиссия и проскальзывание.
   *
   * Режим ПОТОКА обязан быть `prod`: поток строит прод-реестр (`strategyBundleRegistry`), и
   * `paper_match` в нём отсутствует — запрос будет отклонён как `invalid_module_ref`.
   */
  readonly execProfile?: 'nocost' | 'prod';
}

export function makeRequest(spec: WorkloadSpec): BacktestRunRequest {
  // При настоящей ленте период и символы берутся ИЗ ДАННЫХ, а не из `T0`/`spec.bars`: запрос с
  // чужим окном отклонится валидацией ещё до симуляции, и это выглядело бы как поломка станка.
  const real = spec.tapeFile !== undefined ? rowsFromFile(spec.tapeFile) : undefined;
  const period = real !== undefined
    ? {
        from: new Date(real[0]!.minute_ts).toISOString(),
        to: new Date(real[real.length - 1]!.minute_ts).toISOString(),
      }
    : {
        from: new Date(T0).toISOString(),
        to: new Date(T0 + spec.bars * 60_000).toISOString(),
      };
  const symbols = real !== undefined
    ? [...new Set(real.map((r) => r.symbol))]
    : [...spec.symbols];
  return {
    runId: 'runner-perf-probe',
    mode: 'research',
    moduleRef: spec.module ?? { id: MANIFEST.id, version: MANIFEST.version },
    datasetRef: real !== undefined ? 'runner-perf-real' : 'runner-perf-probe',
    symbols,
    timeframe: '1m',
    period,
    riskProfileRef: { id: DEFAULT_RISK.id, version: DEFAULT_RISK.version },
    executionProfileRef:
      spec.execProfile === 'prod'
        ? { id: DEFAULT_EXEC.id, version: DEFAULT_EXEC.version }
        : { id: SAME_BAR_NO_COST.id, version: SAME_BAR_NO_COST.version },
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

  // Та же лента, что и у isolate-режима (`buildTape`), включая рыночные виды: иначе два режима
  // одного станка мерили бы РАЗНЫЙ объём работы на баре, и сравнивать их было бы нельзя.
  return {
    registry,
    marketTape: buildTape(spec),
    router: createTrustedRouter(),
    barMajor: spec.barMajor,
  } as RunDeps;
}

/** Лента строится отдельно от deps, чтобы isolate- и trusted-режим мерили ОДНИ И ТЕ ЖЕ данные. */
/**
 * Настоящие канонические строки из файла (`.ndjson` или `.ndjson.gz`), выгруженные из mock-platform.
 *
 * Синтетическая лента — случайное блуждание с гладким OI — НЕ ПОРОЖДАЕТ паттернов, на которые
 * реагируют реальные стратегии: `short_after_pump` ждёт памп +10% за 20 минут, `long_oi` — дамп с
 * восстановлением открытого интереса и подтверждением ликвидациями. Обе на синтетике дают ноль
 * сделок (проверено счётчиком в станке). Значит батч 17b на ней работает все 100% баров, и любой
 * замер батча на синтетике — его ПОТОЛОК, а не рабочее значение.
 *
 * Выгрузка делается `scripts/export-rows.py` (см. control-center) и кладётся рядом со станком;
 * в репозиторий не коммитится — это десятки мегабайт рыночных данных, а не фикстура кода.
 */
function rowsFromFile(path: string): CanonicalRowV2[] {
  const raw = path.endsWith('.gz') ? gunzipSync(readFileSync(path)) : readFileSync(path);
  const rows: CanonicalRowV2[] = [];
  for (const line of raw.toString('utf8').split('\n')) {
    if (line.length > 0) rows.push(JSON.parse(line) as CanonicalRowV2);
  }
  if (rows.length === 0) throw new Error(`лента ${path}: ноль строк — фикстура пуста`);
  return rows;
}

/**
 * Строки ленты — настоящие из файла или синтетические. Отдельно от `buildTape`, потому что режиму
 * ПОТОКА нужны именно строки: через границу потока едут колонки (`encodeTapeColumns`), а не лента —
 * у ленты есть методы, а structured clone переносит только данные.
 */
export function buildRows(spec: WorkloadSpec): CanonicalRowV2[] {
  if (spec.tapeFile !== undefined) return rowsFromFile(spec.tapeFile);
  const allRows: CanonicalRowV2[] = [];
  for (const [i, symbol] of spec.symbols.entries()) {
    allRows.push(...syntheticRows(symbol, spec.bars, spec.seed + i * 7919, spec.marketKinds === true));
  }
  return allRows;
}

/** Ссылка на датасет — одна и та же у ленты и у колонок, иначе поток соберёт ленту под чужим именем. */
export function datasetRefOf(spec: WorkloadSpec): string {
  return spec.tapeFile !== undefined ? 'runner-perf-real' : 'runner-perf-probe';
}

export function buildTape(spec: WorkloadSpec): MarketTapeDataset {
  if (spec.tapeFile !== undefined) {
    const rows = rowsFromFile(spec.tapeFile);
    const built = marketTapeFromCanonicalRows('runner-perf-real', '1m', rows);
    if (!built.ok) throw new Error('perf fixture tape build failed: ' + built.detail);
    return built.tape;
  }
  const allRows: CanonicalRowV2[] = [];
  for (const [i, symbol] of spec.symbols.entries()) {
    allRows.push(...syntheticRows(symbol, spec.bars, spec.seed + i * 7919, spec.marketKinds === true));
  }
  const built = marketTapeFromCanonicalRows('runner-perf-probe', '1m', allRows);
  if (!built.ok) throw new Error('perf fixture tape build failed: ' + built.detail);
  return built.tape;
}

/**
 * `RunDeps` для прогона РЕАЛЬНОГО бандла в V8-изоляте — прод-путь после backtester#166.
 *
 * Отличия от trusted-режима, каждое умышленное:
 * - стратегия приходит как `strategyBundles` (provenance `bundle`), иначе роутер не уведёт её в
 *   сэндбокс вообще (`routing.ts`: sandbox-исполнитель только для bundle-provenance);
 * - `wallTimeMsPerCall` поднят: дефолтные 2 с рассчитаны на один бар, а под профилировщиком на
 *   десятках тысяч баров батч упрётся в них и прогон упадёт по таймауту, а не по существу;
 * - `barBatching.maxBars` = 64 — то же значение, что дефолт прод-воркера; без него путь
 *   выродится в lockstep (450 мкс/бар) и замер будет мерить уже почищенный #166 транспорт.
 *
 * Универс-сессии в isolate-режиме не поддерживаются (routing.ts падает fail-fast) — поэтому их тут нет.
 */
/**
 * ЧЕМ СТАНОК ОТЛИЧАЕТСЯ ОТ ПРОДА — список обязателен к сверке перед любым выводом.
 *
 * Расхождения станка с прод-путём породили в этой программе несколько неверных выводов подряд:
 * числа снимались на конфигурации, которой в проде не существует, а разница списывалась на железо.
 * Поэтому отличия перечислены здесь явно, а не расползаются по умолчаниям.
 *
 * | ось | станок | прод |
 * | --- | --- | --- |
 * | рыночные виды ленты | `PROFILE_MARKET_KINDS` (по умолчанию НЕТ) | все четыре ЕСТЬ |
 * | батч баров 17b | `PROFILE_BATCH_BARS` (по умолчанию 0 = выкл, как в проде) | выкл |
 * | заморозка контекста | `PROFILE_CONTEXT_FREEZE` (по умолчанию вкл) | СНЯТА |
 * | поток барного цикла | НЕТ — цикл на главном потоке, заход АСИНХРОННЫЙ | поток + СИНХРОННЫЙ заход |
 *
 * Последняя строка — известное и НЕ закрытое расхождение: асинхронный заход стоит измеренные
 * ~150 мкс/бар (bt#191/196), которых прод не платит. Пока станок не умеет гонять цикл в потоке,
 * всё, что профиль показывает про `evalHarness` / `idle` / `TextDecoder`, к проду не относится.
 */
export function makeIsolateDeps(spec: WorkloadSpec, bundleDir: string, wallTimeMsPerCall: number): RunDeps {
  const policy = loadConfig().overlaySandbox.policy;
  const scaled = { ...policy, limits: { ...policy.limits, wallTimeMsPerCall } };

  // Тот же exec-профиль, что и в trusted-режиме: иначе режимы исполняли бы разные модели заполнения
  // и разницу во времени нельзя было бы отнести к границе изоляции.
  const registry = createModuleRegistry({
    strategyBundles: [loadBundle(bundleDir)],
    riskProfiles: [DEFAULT_RISK],
    // Оба профиля в реестре: какой из них исполнится, решает ССЫЛКА В ЗАПРОСЕ, а не состав реестра.
    executionProfiles: [SAME_BAR_NO_COST, DEFAULT_EXEC],
    sandboxPolicies: [scaled],
  });

  const router = createExecutorRouter({
    sandboxBackend: 'isolate',
    sandboxPolicies: createSandboxPolicyRegistry([scaled]),
    sandboxPolicyRef: { id: scaled.id, version: scaled.version },
  });

  return {
    registry,
    marketTape: buildTape(spec),
    router,
    barMajor: spec.barMajor,
    // Батч 17b по умолчанию ВЫКЛЮЧЕН — как в проде. Раньше здесь стояло жёсткое `{ maxBars: 64 }`,
    // и станок мерил ветку, которой прод не исполняет: батч меняет не только транспорт, но и путь
    // в `runSymbol` (окно контекстов вместо одного) — то есть другой объём работы на баре.
    ...(spec.batchBars !== undefined && spec.batchBars >= 2 ? { barBatching: { maxBars: spec.batchBars } } : {}),
    sandboxPolicyRef: { id: scaled.id, version: scaled.version },
  } as RunDeps;
}
