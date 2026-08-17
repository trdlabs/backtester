// 083 S3 СТУПЕНЬ 1 — ПАРИТЕТ ДОРОГ С N АКТОРАМИ И НЕСЛИПАНИЕ ПОТОКОВ (план cc#395 §8).
//
// ═══ ЗАЧЕМ ОТДЕЛЬНЫЙ ФАЙЛ, ЕСЛИ ПАРИТЕТ УЖЕ ЕСТЬ ═══
//
// `actor-boundary-parity` проверяет границу на ОДНОМ акторе. Всё, что появляется от второго, там
// не наблюдается вовсе: распределение лент по акторам, отдельный поток на каждого и — главное —
// пересечение `seq`. Расширять тот файл значило бы смешать два разных утверждения в одном прогоне.
//
// ═══ ПОЧЕМУ ПЕРЕСЕЧЕНИЕ `seq` — НЕ ДЕТАЛЬ, А ВЕСЬ ПРЕДМЕТ ═══
//
// `seq` actor-local и непрерывен от нуля у КАЖДОГО актора. Значит у двух акторов диапазоны
// пересекаются по построению: обе ленты содержат seq=0, 1, 2, … Реализация, склеивающая потоки в
// один документ или адресующая записи одним лишь `seq`, на односимвольном прогоне неотличима от
// правильной. Здесь она обязана быть отличима.
//
// ═══ ОДИН ФАЙЛ СТРАТЕГИИ, КАК И В ПАРИТЕТЕ ГРАНИЦЫ ═══
//
// Два рукописных зеркала дали бы расхождение, неотличимое от расхождения дорог. Файл один:
// песочная дорога исполняет его в изоляте, доверенная импортирует тот же файл в процесс.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';
import { CONTRACT_VERSION } from '@trading/research-contracts/research';
import type { ExecutionProfile, RiskProfile, StrategyModule } from '@trading/research-contracts/research';
import type { BacktestRunRequest } from '@trading/research-contracts';

import { createModuleRegistry, createExecutorRouter } from '../src/engine/sandbox/routing.js';
import { createTrustedRouter, InProcessTrustedModuleExecutor } from '../src/engine/module-executor.js';
import type { ModuleBundle } from '../src/engine/sandbox/bundle.js';
import { loadCandleDataset } from '../src/engine/dataset.js';
import { runBacktest } from '../src/engine/runner.js';
import { InMemoryArtifactStore } from '../src/artifacts/store.js';
import { contentRef } from '../src/determinism/hash.js';
import type { ActorTimelineDocument } from '../src/engine/actor/timeline-artifact.js';
import type { RunOutcome } from '../src/engine/artifacts.js';

const MINUTE_MS = 60_000;
const MINUTE_US = 60_000_000;
const T0 = Date.UTC(2024, 0, 1, 0, 0, 0);
const BAR_COUNT = 8;
const DATASET_REF = 'actor-multi-parity-1m';
const MODULE_ID = 'actor_multi_parity_probe';
const VENUE = 'bybit';

/**
 * ПОРЯДОК ОБРАТНО-АЛФАВИТНЫЙ — та же дисциплина, что и в `actor-production-wiring`.
 *
 * Пока порядок объявления, порядок прогона и алфавитный совпадают, отображение «по имени»
 * неотличимо от отображения «по позиции», и целый класс дефектов зеленеет тождественной
 * перестановкой. Здесь совпадения нет, поэтому скрещивание лент видно в ценах.
 */
const SYMBOLS = ['ETHUSDT', 'BTCUSDT'] as const;
/** Уровни разведены: цена филла — единственное, что отличает ленту от ленты. */
const BASE_OF: Readonly<Record<string, number>> = { ETHUSDT: 100, BTCUSDT: 150 };

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

/**
 * Профиль риска БЕЗ `maxConcurrentPositions`.
 *
 * Это не удобство теста, а вынужденность: `DEFAULT_RISK` объявляет `maxConcurrentPositions: 1`, и
 * многосимвольный прогон под ним отвергается portfolio-wide правилом ДО создания акторов —
 * решение владельца по риску от 2026-08-14, per-actor трактовка запрещена. То есть ступень 1
 * недостижима ни под одним поставляемым сегодня профилем; это зафиксировано и вынесено владельцу
 * отдельно, а не обойдено молча здесь.
 */
const MULTI_RISK: RiskProfile = {
  id: 'multi_symbol_risk',
  version: '1.0.0',
  exposureLimits: { maxPositionNotionalPct: 1.0 },
  allowedSides: ['long', 'short'],
} as unknown as RiskProfile;

const MANIFEST = {
  id: MODULE_ID,
  version: '1.0.0',
  kind: 'strategy' as const,
  name: 'multi-symbol boundary parity',
  summary: 'одна стратегия, две дороги, два актора',
  rationale: 'ни граница изолята, ни второй актор не вправе менять ответ',
  author: 'agent',
  contractVersion: CONTRACT_VERSION,
  status: 'research_only' as const,
  paramsSchema: { type: 'object', additionalProperties: false, properties: {} },
  params: {},
  capabilities: { platformSdk: true },
  dataNeeds: { closedCandlesUpToCurrent: true, asOfIndicators: false },
  lifecycle: 'event_driven',
  hooks: ['onEvent'],
  // ФИКСИРОВАННАЯ ветвь §5: каждое требование называет КОНКРЕТНЫЙ инструмент и обслуживает только
  // его. Порядок объявления — тот же обратно-алфавитный, что и у прогона.
  marketData: SYMBOLS.map((symbol, i) => ({
    kind: 'candles',
    id: `req-${symbol.toLowerCase()}`,
    instrument: { venue: VENUE, symbol },
    interval: MINUTE_US,
    // Прогрев РАЗНЫЙ у двух акторов: одинаковый сделал бы потоки структурно похожими, и склейка
    // читалась бы как норма. Разный прогрев разводит и число событий, и моменты готовности.
    lookback: i,
    revisionPolicy: { mode: 'final_only' },
    priceType: 'trade',
  })),
};

/**
 * ЕДИНСТВЕННЫЙ исходник стратегии — тот же файл для обеих дорог.
 *
 * Заметка несёт `init.symbol` и цену закрытия: если актору достанется чужая лента, разойдётся не
 * имя (оно берётся из `init`), а ЦЕНА. Имена и число заявок при скрещивании остались бы прежними.
 */
const STRATEGY_SOURCE = `
export function createActor(init) {
  let bar = -1;
  return {
    onEvent(event, ctx) {
      if (event.kind !== 'market.candle.closed') return [];
      bar += 1;
      const out = [{
        kind: 'annotate',
        note: 'sym=' + init.symbol
          + ' bar=' + bar
          + ' close=' + event.candle.close
          + ' ready=' + ctx.readiness,
      }];
      if (bar === 3) out.push({ kind: 'place', type: 'market', clientOrderId: init.symbol + '-in', side: 'buy', qtyUsd: 1000 });
      if (bar === 6) out.push({ kind: 'place', type: 'market', clientOrderId: init.symbol + '-out', side: 'sell', qtyUsd: 5000, reduceOnly: true });
      return out;
    },
  };
}
`;

function writeStrategyBundle(): { bundle: ModuleBundle; entryFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'actor-multi-parity-bundle-'));
  tempDirs.push(dir);
  mkdirSync(join(dir, 'module'), { recursive: true });
  const entryFile = join(dir, 'module/index.js');
  writeFileSync(entryFile, STRATEGY_SOURCE);
  return {
    entryFile,
    bundle: {
      bundleDir: dir,
      manifest: MANIFEST as unknown as ModuleBundle['manifest'],
      descriptor: {
        contractVersion: '1.0.0',
        kind: 'strategy',
        entryPoint: 'module/index.js',
        files: [
          { path: 'module/index.js', sha256: createHash('sha256').update(STRATEGY_SOURCE).digest('hex') },
        ],
        bundleHash: `sha256:${'ab'.repeat(32)}`,
      },
    },
  };
}

function writeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'actor-multi-parity-tape-'));
  tempDirs.push(dir);
  const symbols: Record<string, unknown[]> = {};
  for (const s of SYMBOLS) {
    const base = BASE_OF[s]!;
    symbols[s] = Array.from({ length: BAR_COUNT }, (_, i) => ({
      ts: T0 + i * MINUTE_MS,
      open: base + i,
      high: base + 1 + i,
      low: base - 1 + i,
      close: base + 0.5 + i,
      volume: 10,
    }));
  }
  writeFileSync(
    join(dir, `${DATASET_REF}.json`),
    JSON.stringify({ datasetRef: DATASET_REF, timeframe: '1m', candleVenue: VENUE, symbols }),
    'utf8',
  );
  return dir;
}

const NO_COST: ExecutionProfile = {
  id: 'paper_match',
  version: '1.0.0',
  // `next_bar_open`, А НЕ `same_bar_close`, И ЭТО ИСПРАВЛЕНИЕ ЛЖИ, А НЕ НАСТРОЙКА.
  //
  // Прежде здесь стояло `same_bar_close`, тогда как actor-дорога наливает по ОТКРЫТИЮ
  // СЛЕДУЮЩЕГО бара всегда: `fillModel` до неё не доезжает вовсе. То есть проба объявляла одну
  // модель и исполняла другую — и молчала об этом, потому что проверять расхождение было нечем.
  // Гейт профиля исполнения сделал его наблюдаемым, и это первое, что он нашёл.
  fillModel: { kind: 'next_bar_open' } as never,
  feeModel: { kind: 'fixed_bps', bps: 0 },
  slippageModel: { kind: 'fixed_bps', bps: 0 },
};

const request = (): BacktestRunRequest =>
  ({
    runId: 'actor-multi-parity',
    mode: 'research',
    moduleRef: { id: MANIFEST.id, version: MANIFEST.version },
    datasetRef: DATASET_REF,
    symbols: [...SYMBOLS],
    timeframe: '1m',
    period: {
      from: new Date(T0).toISOString(),
      to: new Date(T0 + BAR_COUNT * MINUTE_MS).toISOString(),
    },
    riskProfileRef: { id: MULTI_RISK.id, version: MULTI_RISK.version },
    executionProfileRef: { id: NO_COST.id, version: NO_COST.version },
    seed: 4242,
    metrics: ['pnl'],
  }) as unknown as BacktestRunRequest;

interface Road {
  readonly outcome: RunOutcome;
  readonly timelines: readonly ActorTimelineDocument[];
}

const refusalOf = (outcome: RunOutcome): string => {
  const issues = (outcome as { validation?: { issues?: { message: string }[] } }).validation?.issues;
  return issues?.[0]?.message ?? 'отказ без причины';
};

/** ВСЕ документы потока, а не первый: их ровно столько, сколько акторов, и это тоже утверждение. */
async function readTimelines(outcome: RunOutcome, store: InMemoryArtifactStore): Promise<readonly ActorTimelineDocument[]> {
  if (outcome.status !== 'completed') throw new Error(refusalOf(outcome));
  const refs = outcome.baseline.artifactRefs;
  return Promise.all(refs.map((r) => store.read(r as never) as Promise<ActorTimelineDocument>));
}

async function runTrusted(fixtureDir: string, entryFile: string): Promise<Road> {
  const namespace = (await import(pathToFileURL(entryFile).href)) as { createActor: unknown };
  // `moduleFactory` ОБЯЗАТЕЛЕН для многосимвольного прогона доверенной дороги, и это не формальность
  // теста: без per-symbol инстанцирования модуль с состоянием протёк бы между символами и разошёлся
  // с песочным близнецом, где изоляция есть по построению. Раннер отвергает такой прогон явно.
  // Фабрика отдаёт то же пространство имён того же файла — второй реализации по-прежнему нет.
  const module = {
    manifest: MANIFEST,
    createActor: namespace.createActor,
    moduleFactory: () => ({ manifest: MANIFEST, createActor: namespace.createActor }),
  } as unknown as StrategyModule;
  const store = new InMemoryArtifactStore();
  const executor = new InProcessTrustedModuleExecutor();
  const outcome = await runBacktest(request(), {
    registry: createModuleRegistry({
      strategies: [module],
      riskProfiles: [MULTI_RISK],
      executionProfiles: [NO_COST],
    }),
    dataset: loadCandleDataset(DATASET_REF, fixtureDir),
    router: createTrustedRouter(executor),
    eventDrivenEnabled: true,
    artifactStore: store,
  } as never);
  // Сессий не осталось НИ ОДНОЙ — при двух акторах это утверждение сильнее, чем при одном:
  // закрывать надо обе, и утечка ровно одной здесь видна.
  expect(executor.activeActorSessions()).toBe(0);
  return { outcome, timelines: await readTimelines(outcome, store) };
}

async function runSandboxed(fixtureDir: string, bundle: ModuleBundle): Promise<Road> {
  const store = new InMemoryArtifactStore();
  const router = createExecutorRouter({ sandboxBackend: 'isolate' });
  let outcome: RunOutcome;
  try {
    outcome = await runBacktest(request(), {
      registry: createModuleRegistry({
        strategyBundles: [bundle],
        riskProfiles: [MULTI_RISK],
        executionProfiles: [NO_COST],
      }),
      dataset: loadCandleDataset(DATASET_REF, fixtureDir),
      router,
      eventDrivenEnabled: true,
      artifactStore: store,
    } as never);
    expect(router.errors()).toEqual([]);
  } finally {
    router.closeAll();
  }
  return { outcome, timelines: await readTimelines(outcome, store) };
}

describe('N акторов: граница не меняет ответ', () => {
  it('обе дороги дают ПОБАЙТОВО один результат на двух акторах', async () => {
    const fixtureDir = writeFixture();
    const { bundle, entryFile } = writeStrategyBundle();

    const trusted = await runTrusted(fixtureDir, entryFile);
    const sandboxed = await runSandboxed(fixtureDir, bundle);

    expect(trusted.outcome.status).toBe('completed');
    expect(sandboxed.outcome.status).toBe('completed');
    expect(contentRef(sandboxed.outcome)).toBe(contentRef(trusted.outcome));
  }, 120_000);

  it('потоки обоих акторов совпадают событие в событие', async () => {
    const fixtureDir = writeFixture();
    const { bundle, entryFile } = writeStrategyBundle();

    const trusted = await runTrusted(fixtureDir, entryFile);
    const sandboxed = await runSandboxed(fixtureDir, bundle);

    expect(sandboxed.timelines).toEqual(trusted.timelines);
  }, 120_000);
});

describe('ПОТОКИ N АКТОРОВ НЕ СКЛЕИВАЮТСЯ', () => {
  it('на пересекающихся seq каждый актор ведёт СВОЙ документ', async () => {
    const fixtureDir = writeFixture();
    const { bundle } = writeStrategyBundle();
    const { timelines } = await runSandboxed(fixtureDir, bundle);

    // Документов ровно столько, сколько акторов. Один документ на прогон означал бы, что потоки
    // сведены в общий, и `seq` в нём перестал бы быть actor-local.
    expect(timelines).toHaveLength(SYMBOLS.length);
    expect(timelines.map((t) => t.symbol).sort()).toEqual([...SYMBOLS].sort());
    // Идентичности различны — общий `actorId` сделал бы принадлежность записей невосстановимой.
    expect(new Set(timelines.map((t) => t.actorId)).size).toBe(SYMBOLS.length);

    // ВОТ РАДИ ЧЕГО ПРОБА СТОИТ: диапазоны `seq` ПЕРЕСЕКАЮТСЯ. Если бы они шли подряд, склейка
    // потоков была бы безобидна и проба ничего бы не проверяла.
    const seqSets = timelines.map((t) => new Set(t.rows.map((r) => r.seq)));
    const overlap = [...seqSets[0]!].filter((s) => seqSets[1]!.has(s));
    expect(overlap.length).toBeGreaterThan(0);

    // И при пересечении номеров записи НЕ перемешаны: ни в одном документе нет подписки ЧУЖОГО
    // требования. Утверждение именно такое, а не «все подписки свои»: у хостовых событий
    // (таймеры, статусы) `subscriptionId` равен `host`, они не принадлежат ничьему требованию, и
    // требовать от них «своей» подписки значило бы проверять не то.
    for (const doc of timelines) {
      const foreignIds = MANIFEST.marketData
        .filter((r) => r.instrument.symbol !== doc.symbol)
        .map((r) => r.id);
      const leaked = doc.rows.filter((r) => foreignIds.some((id) => r.subscriptionId.includes(id)));
      expect(leaked).toEqual([]);
    }
    // ПРОВЕРКА ПРОВЕРКИ для строки выше: у каждого актора СВОИ подписки действительно встречаются.
    // Без этого «чужих нет» зеленело бы и на потоке из одних хостовых событий.
    for (const doc of timelines) {
      const own = MANIFEST.marketData.find((r) => r.instrument.symbol === doc.symbol)!;
      expect(doc.rows.some((r) => r.subscriptionId.includes(own.id))).toBe(true);
    }
  }, 120_000);

  it('ПРОВЕРКА ПРОВЕРКИ: оба актора торговали, и каждый по СВОЕЙ ленте', async () => {
    // Без этого «потоки не склеились» зеленело бы и на двух пустых потоках. Цена филла — то
    // единственное, что отличает ленту от ленты: имена заявок берутся из `init.symbol` и при
    // скрещивании лент остались бы прежними.
    const fixtureDir = writeFixture();
    const { bundle } = writeStrategyBundle();
    const { outcome } = await runSandboxed(fixtureDir, bundle);
    if (outcome.status !== 'completed') throw new Error(refusalOf(outcome));

    const result = outcome.baseline;
    expect(result.evidence.simulatedOrders.map((o) => o.id).sort()).toEqual(
      [...SYMBOLS].flatMap((s) => [`${s}-in`, `${s}-out`]).sort(),
    );
    expect(result.trades).toHaveLength(SYMBOLS.length);

    // Цена входа каждого актора обязана прийти из ЕГО ленты. Заявка подана на баре 3, налив —
    // по ОТКРЫТИЮ бара 4, то есть `base + 4`: 104 у ETH и 154 у BTC. Перепутать их нечем.
    //
    // ОГОВОРКА, ЧТОБЫ ЧИСЛО НЕ ЧИТАЛОСЬ КАК ПОДГОНКА: профиль исполнения объявляет
    // `same_bar_close`, а налив идёт по следующему открытию. До actor-дороги из профиля доезжают
    // только `feeModel.bps` и `slippageModel.bps` — `fillModel` не доезжает, и гейта, отвергающего
    // профиль с неисполнимой fill-моделью, нет (у РИСК-профиля такой whitelist есть). Это
    // предсуществующее расхождение, не внесённое этим срезом и одинаковое на одном символе;
    // вынесено отдельно, а не починено здесь молча.
    const fills = result.evidence.simulatedFills;
    for (const s of SYMBOLS) {
      const entry = fills.find((f) => f.orderId === `${s}-in`);
      expect(entry?.fillPrice).toBe(BASE_OF[s]! + 4);
    }
  }, 120_000);
});
