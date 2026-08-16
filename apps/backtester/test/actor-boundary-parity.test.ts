// 083 S3 — ПАРИТЕТ ГРАНИЦЫ ИСПОЛНЕНИЯ: прямой актор против актора в изоляте.
//
// ВОПРОС, НА КОТОРЫЙ ОТВЕЧАЕТ ЭТОТ ФАЙЛ, РОВНО ОДИН: меняет ли граница ответ. Всё остальное —
// запрос, лента, профили, seed, раннер, сборка результата — совпадает побайтово, различается
// ТОЛЬКО исполнитель: `InProcessTrustedModuleExecutor` против `IsolateModuleExecutor`.
//
// ═══ ПОЧЕМУ КОД СТРАТЕГИИ ЗДЕСЬ ОДИН ФАЙЛ, А НЕ ДВЕ КОПИИ ═══
//
// Обычный приём в этом репозитории — держать доверенный модуль и бандл двумя рукописными
// зеркалами (`short-after-pump` живёт и там, и там). Для паритета ГРАНИЦЫ он не годится:
// расхождение зеркал неотличимо от расхождения дорог, и зелёный гейт означал бы «я аккуратно
// переписал», а красный — «я где-то опечатался». Ни то, ни другое не про границу.
//
// Здесь файл ОДИН. Песочная дорога исполняет его в изоляте из bundleDir; доверенная — импортирует
// ТОТ ЖЕ файл в процесс. «Одна и та же стратегия» перестаёт быть заявлением и становится
// свойством конструкции: копии, которая могла бы разойтись, не существует.
//
// ═══ ЧТО СТРАТЕГИЯ НАМЕРЕННО ДЕЛАЕТ ═══
//
// Она подобрана так, чтобы через границу проехало КАЖДОЕ семейство, а не только заявка:
//
//   • `ctx.rng.next()` на каждом баре — лента случайности живёт у хоста, а разыгрывается за
//     границей; расхождение положения генератора видно числом в заметке;
//   • `ctx.position()` — снимок, восстановленный функцией, а не полем;
//   • `place` во время ПРОГРЕВА — отклоняется, суффикс батча обрывается, `order.denied` приезжает
//     каскадом в том же frontier;
//   • `timer.set` → `timer.fired` — хостовое событие без подписки;
//   • вход и `reduceOnly`-выход — филлы, сделка, ненулевой pnl.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';
import { CONTRACT_VERSION } from '@trading/research-contracts/research';
import type { ExecutionProfile, StrategyModule } from '@trading/research-contracts/research';
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
import { DEFAULT_RISK } from '../src/engine/profiles.js';

const MINUTE_MS = 60_000;
const MINUTE_US = 60_000_000;
const T0 = Date.UTC(2024, 0, 1, 0, 0, 0);
const BAR_COUNT = 10;
const DATASET_REF = 'actor-parity-1m';
const MODULE_ID = 'actor_parity_probe';
const VENUE = 'bybit';

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

const MANIFEST = {
  id: MODULE_ID,
  version: '1.0.0',
  kind: 'strategy' as const,
  name: 'actor boundary parity',
  summary: 'одна стратегия, две дороги исполнения',
  rationale: 'граница изолята не вправе менять ответ',
  author: 'agent',
  contractVersion: CONTRACT_VERSION,
  status: 'research_only' as const,
  paramsSchema: { type: 'object', additionalProperties: false, properties: {} },
  params: {},
  capabilities: { platformSdk: true },
  dataNeeds: { closedCandlesUpToCurrent: true, asOfIndicators: false },
  lifecycle: 'event_driven',
  hooks: ['onEvent'],
  marketData: [
    {
      kind: 'candles',
      id: 'req-candles',
      instrument: { venue: VENUE, symbol: 'BTCUSDT' },
      interval: MINUTE_US,
      // Прогрев НЕНУЛЕВОЙ намеренно: он даёт отклонённую заявку, а вместе с ней — обрыв суффикса
      // батча и каскадный `order.denied`. Без него паритет проверялся бы только на успешном пути.
      lookback: 2,
      revisionPolicy: { mode: 'final_only' },
      priceType: 'trade',
    },
    {
      // Агрегированный вид рядом со свечами: паритет обязан покрывать и его доставку, и разрыв
      // наблюдаемости. Венью тут — идентичность инструмента, а не заявление о происхождении
      // значения: у кросс-биржевой величины его нет по построению.
      kind: 'open_interest',
      id: 'req-oi',
      instrument: { venue: VENUE, symbol: 'BTCUSDT' },
      interval: MINUTE_US,
      lookback: 0,
      revisionPolicy: { mode: 'final_only' },
      scope: 'aggregate',
      unit: 'usd',
    },
  ],
};

/**
 * ЕДИНСТВЕННЫЙ исходник стратегии. Его же грузит доверенная дорога — импортом в процесс.
 *
 * Заметка на каждом баре несёт розыгрыш генератора в ПОЛНОЙ точности (`toString()`, не
 * округление): урезанное число совпало бы у двух разных лент случайности, и гейт зеленел бы на
 * расхождении, ради обнаружения которого он и стоит.
 */
const STRATEGY_SOURCE = `
export function createActor(init) {
  let bar = -1;
  const feed = [];
  return {
    onEvent(event, ctx) {
      if (event.kind === 'market.open_interest.observed') {
        feed.push('oi@' + event.oi.effectiveTsUs + '=' + event.oi.value.oiTotalUsd);
        return [];
      }
      if (event.kind === 'market.subscription.status_changed') {
        feed.push('gap@' + event.status.expectedTsUs
          + (event.status.lastObservedTsUs === undefined ? '' : '<' + event.status.lastObservedTsUs));
        return [];
      }
      if (event.kind !== 'market.candle.closed') return [];
      bar += 1;
      const pos = ctx.position();
      const out = [{
        kind: 'annotate',
        note: 'bar=' + bar
          + ' seed=' + init.seed
          + ' sym=' + init.symbol
          + ' subs=' + init.subscriptions.map((s) => s.subscriptionId).join('|')
          + ' ready=' + ctx.readiness
          + ' state=' + ctx.tradingState
          + ' now=' + ctx.clock.nowUs()
          + ' feed=' + feed.join(',')
          + ' open=' + ctx.orders.open().length
          + ' pos=' + (pos === undefined ? 'flat' : pos.side + '@' + pos.avgEntryPrice)
          + ' draw=' + ctx.rng.next().toString(),
      }];
      if (bar === 0) out.push({ kind: 'timer.set', timerId: 't-0', afterUs: 120000000 });
      // ВО ВРЕМЯ ПРОГРЕВА — заявка обязана быть отклонена, а всё после неё в батче пропущено.
      if (bar === 1) out.push({ kind: 'place', type: 'market', clientOrderId: 'warmup-denied', side: 'buy', qtyUsd: 1000 });
      if (bar === 1) out.push({ kind: 'annotate', note: 'этот суффикс обязан быть пропущен' });
      if (bar === 3) out.push({ kind: 'place', type: 'market', clientOrderId: 'parity-in', side: 'buy', qtyUsd: 1000 });
      if (bar === 6) out.push({ kind: 'place', type: 'market', clientOrderId: 'parity-out', side: 'sell', qtyUsd: 5000, reduceOnly: true });
      return out;
    },
  };
}
`;

/** bundleDir на диске: тело исполняется только в изоляте (FR-010), но файл читаем и напрямую. */
function writeStrategyBundle(): { bundle: ModuleBundle; entryFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'actor-parity-bundle-'));
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
          {
            path: 'module/index.js',
            sha256: createHash('sha256').update(STRATEGY_SOURCE).digest('hex'),
          },
        ],
        bundleHash: `sha256:${'ef'.repeat(32)}`,
      },
    },
  };
}

/** Лента с линейным ростом: филлы получают разные цены, сделка выходит с ненулевым pnl. */
function writeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'actor-parity-tape-'));
  tempDirs.push(dir);
  writeFileSync(
    join(dir, `${DATASET_REF}.json`),
    JSON.stringify({
      datasetRef: DATASET_REF,
      timeframe: '1m',
      candleVenue: VENUE,
      symbols: {
        BTCUSDT: Array.from({ length: BAR_COUNT }, (_, i) => ({
          ts: T0 + i * MINUTE_MS,
          open: 100 + i,
          high: 101 + i,
          low: 99 + i,
          close: 100.5 + i,
          volume: 10,
        })),
      },
    }),
    'utf8',
  );
  return dir;
}

const NO_COST: ExecutionProfile = {
  id: 'paper_match',
  version: '1.0.0',
  fillModel: { kind: 'same_bar_close' } as never,
  feeModel: { kind: 'fixed_bps', bps: 0 },
  slippageModel: { kind: 'fixed_bps', bps: 0 },
};

const request = (): BacktestRunRequest =>
  ({
    runId: 'actor-parity',
    mode: 'research',
    moduleRef: { id: MANIFEST.id, version: MANIFEST.version },
    datasetRef: DATASET_REF,
    symbols: ['BTCUSDT'],
    timeframe: '1m',
    period: {
      from: new Date(T0).toISOString(),
      to: new Date(T0 + BAR_COUNT * MINUTE_MS).toISOString(),
    },
    riskProfileRef: { id: DEFAULT_RISK.id, version: DEFAULT_RISK.version },
    executionProfileRef: { id: NO_COST.id, version: NO_COST.version },
    seed: 4242,
    metrics: ['pnl'],
  }) as unknown as BacktestRunRequest;

interface Road {
  readonly outcome: RunOutcome;
  readonly timeline: ActorTimelineDocument;
}

const refusalOf = (outcome: RunOutcome): string => {
  const issues = (outcome as { validation?: { issues?: { message: string }[] } }).validation?.issues;
  return issues?.[0]?.message ?? 'отказ без причины';
};

async function readTimeline(outcome: RunOutcome, store: InMemoryArtifactStore): Promise<ActorTimelineDocument> {
  if (outcome.status !== 'completed') throw new Error(refusalOf(outcome));
  const ref = outcome.baseline.artifactRefs[0]!;
  return (await store.read(ref as never)) as ActorTimelineDocument;
}

/** ДОВЕРЕННАЯ дорога: тот же файл, импортированный В ЭТОТ процесс. */
async function runTrusted(fixtureDir: string, entryFile: string): Promise<Road> {
  const namespace = (await import(pathToFileURL(entryFile).href)) as { createActor: unknown };
  // Модуль для реестра — пространство имён того же файла плюс манифест. Никакой второй реализации.
  const module = { manifest: MANIFEST, createActor: namespace.createActor } as unknown as StrategyModule;
  const store = new InMemoryArtifactStore();
  const executor = new InProcessTrustedModuleExecutor();
  const outcome = await runBacktest(request(), {
    registry: createModuleRegistry({
      strategies: [module],
      riskProfiles: [DEFAULT_RISK],
      executionProfiles: [NO_COST],
    }),
    dataset: datasetWithOi(fixtureDir),
    router: createTrustedRouter(executor),
    eventDrivenEnabled: true,
    artifactStore: store,
  } as never);
  // Прямой исполнитель не оставил сессий — это и есть его половина «нет утечек».
  expect(executor.activeActorSessions()).toBe(0);
  return { outcome, timeline: await readTimeline(outcome, store) };
}

/**
 * Фикстура свечей, ДОПОЛНЕННАЯ наблюдениями open interest.
 *
 * Формат фикстуры 018 агрегатов не несёт, а паритет обязан проверяться и на них: доставка нового
 * вида идёт другим кодом (`aggregateEventFor`, состояние разрыва наблюдаемости), и граница изолята
 * не вправе менять ответ и там. Обёртка отдаёт ОДИН И ТОТ ЖЕ вход обеим дорогам — иначе
 * сравнивались бы два разных входа, и совпадение не значило бы ничего.
 *
 * Наблюдения НЕ на каждом баре намеренно: пропуск порождает `market.subscription.status_changed`,
 * и паритет обязан покрывать его тоже — это событие собирается из состояния, живущего МЕЖДУ
 * frontier'ами, то есть ровно там, где две дороги могли бы разойтись незаметно.
 */
function datasetWithOi(fixtureDir: string): ReturnType<typeof loadCandleDataset> {
  const base = loadCandleDataset(DATASET_REF, fixtureDir);
  const observed = new Map<number, number>();
  base.candles('BTCUSDT').forEach((c, i) => {
    if (i % 2 === 0) observed.set(c.ts, 5_000 + i);
  });
  return {
    ...base,
    openInterest: () => ({
      at: (minuteTs: number) => {
        const oiTotalUsd = observed.get(minuteTs);
        return oiTotalUsd === undefined ? undefined : { ts: minuteTs, oiTotalUsd };
      },
      covered: (minuteTs: number) => observed.has(minuteTs),
    }),
  } as unknown as ReturnType<typeof loadCandleDataset>;
}

/** ПЕСОЧНАЯ дорога: тот же файл, исполненный в изоляте. */
async function runSandboxed(fixtureDir: string, bundle: ModuleBundle): Promise<Road> {
  const store = new InMemoryArtifactStore();
  const router = createExecutorRouter({ sandboxBackend: 'isolate' });
  let outcome: RunOutcome;
  try {
    outcome = await runBacktest(request(), {
      registry: createModuleRegistry({
        strategyBundles: [bundle],
        riskProfiles: [DEFAULT_RISK],
        executionProfiles: [NO_COST],
      }),
      dataset: datasetWithOi(fixtureDir),
      router,
      eventDrivenEnabled: true,
      artifactStore: store,
    } as never);
    // Диагностика песочницы обязана быть ПУСТОЙ: непустая означала бы, что что-то деградировало
    // fail-closed, а прогон всё равно доехал — то есть числа посчитаны не по стратегии.
    expect(router.errors()).toEqual([]);
  } finally {
    router.closeAll();
  }
  return { outcome, timeline: await readTimeline(outcome, store) };
}

describe('граница изолята не меняет ответ', () => {
  it('обе дороги дают ПОБАЙТОВО один результат', async () => {
    // Последовательно, а не `Promise.all`: два прогона в одном процессе делят кэши и временные
    // каталоги, и параллельный запуск проверял бы живучесть обвязки вместо паритета.
    const fixtureDir = writeFixture();
    const { bundle, entryFile } = writeStrategyBundle();

    const trusted = await runTrusted(fixtureDir, entryFile);
    const sandboxed = await runSandboxed(fixtureDir, bundle);

    expect(trusted.outcome.status).toBe('completed');
    expect(sandboxed.outcome.status).toBe('completed');
    // ЦЕЛИКОМ, а не выборкой полей: расхождение за пределами того, что перечислил бы автор
    // проверки, — ровно то, что выборочное сравнение пропускает.
    expect(contentRef(sandboxed.outcome)).toBe(contentRef(trusted.outcome));
  }, 120_000);

  it('поток диспетчеризации совпадает событие в событие', async () => {
    // Хеш результата уже сошёлся выше, но он агрегат: сойдясь, он не говорит, ЧТО именно
    // совпало. Поток — самая подробная запись прогона, и здесь он сравнивается целиком.
    const fixtureDir = writeFixture();
    const { bundle, entryFile } = writeStrategyBundle();

    const trusted = await runTrusted(fixtureDir, entryFile);
    const sandboxed = await runSandboxed(fixtureDir, bundle);

    expect(sandboxed.timeline).toEqual(trusted.timeline);
  }, 120_000);

  it('ПРОВЕРКА ПРОВЕРКИ: прогон действительно торговал, а не совпал на пустоте', async () => {
    // Два пустых прогона совпадают побайтово и не доказывают ничего. Здесь перечислено, что
    // именно пересекло границу: розыгрыши генератора, отклонённая при прогреве заявка с обрывом
    // суффикса, сработавший таймер, вход, reduceOnly-выход и закрытая сделка.
    const fixtureDir = writeFixture();
    const { bundle } = writeStrategyBundle();
    const { outcome, timeline } = await runSandboxed(fixtureDir, bundle);
    if (outcome.status !== 'completed') throw new Error(refusalOf(outcome));

    const result = outcome.baseline;
    expect(result.summary.barsProcessed).toBe(BAR_COUNT);
    expect(result.evidence.simulatedOrders.map((o) => o.id)).toEqual(['parity-in', 'parity-out']);
    expect(result.evidence.simulatedFills).toHaveLength(2);
    expect(result.trades).toHaveLength(1);
    expect(result.summary.closedTradesCount).toBe(1);

    const commands = timeline.rows.flatMap((r) => r.commands);
    const notes = commands
      .filter((c) => c.command.kind === 'annotate')
      .map((c) => (c.command as { note: string }).note);
    // Генератор РАЗЫГРЫВАЛСЯ и давал РАЗНЫЕ числа: одинаковые означали бы, что лента стоит на
    // месте, а совпадение дорог было бы совпадением двух неподвижных генераторов.
    const draws = notes.map((n) => n.split(' draw=')[1]).filter((d): d is string => d !== undefined);
    expect(draws.length).toBeGreaterThanOrEqual(BAR_COUNT);
    expect(new Set(draws).size).toBe(draws.length);
    // АГРЕГИРОВАННЫЙ ВИД ДЕЙСТВИТЕЛЬНО ДОСТАВЛЯЛСЯ — иначе паритет по нему был бы вакуумным:
    // `feed=` совпал бы у обеих дорог пустым, и «побайтово одинаково» не значило бы про новый вид
    // ничего. Проверяются ОБА состояния, потому что собираются они разным кодом: наблюдение — из
    // бара, разрыв — из состояния, живущего МЕЖДУ frontier'ами.
    expect(notes.some((n) => / feed=[^ ]*oi@/.test(n))).toBe(true);
    expect(notes.some((n) => / feed=[^ ]*gap@/.test(n))).toBe(true);
    // Прогрев наблюдался автором и заявка при нём отклонена, а суффикс батча пропущен.
    expect(notes.some((n) => n.includes('ready=warming_up'))).toBe(true);
    expect(notes.some((n) => n.includes('ready=ready'))).toBe(true);
    const denied = commands.find(
      (c) => c.command.kind === 'place' && (c.command as { clientOrderId: string }).clientOrderId === 'warmup-denied',
    );
    expect(denied?.status).toBe('rejected');
    const skipped = commands.filter((c) => c.status === 'skipped');
    expect(skipped).toHaveLength(1);
    // Таймер сработал: хостовое событие без подписки доехало до автора.
    expect(timeline.rows.some((r) => r.event.kind === 'timer.fired')).toBe(true);
    // Позиция была видна автору именно как СНИМОК с полями контракта.
    expect(notes.some((n) => /pos=long@\d/.test(n))).toBe(true);
  }, 120_000);
});
