// СКВОЗНОЙ ПРОГОН ACTOR-ПУТИ: файл фикстуры → `loadCandleDataset` → `runBacktest` → результат.
//
// Чем это отличается от `actor-production-wiring.test.ts`. Там датасет — объект, собранный тестом, а
// исполнитель — заглушка: проверялось, что продовая функция отдаёт `RunAccumulators` нужной формы.
// Здесь не подставлено НИЧЕГО из того, что есть в проде: свечи читаются с диска настоящим
// загрузчиком, происхождение свечей приезжает из ПОЛЯ ФАЙЛА, стратегия — настоящий
// `EventDrivenModule`, актор создаётся настоящим trusted-исполнителем через `router.forStrategy`, а
// результат собирает тот же `assembleResult`, что и у legacy.
//
// Ровно эта цепочка и была не проверена: каждое звено по отдельности зеленело, а вместе они ни разу
// не запускались — путь упирался в исполнителя, который lifecycle актора не умел вовсе.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { CONTRACT_VERSION } from '@trading/research-contracts/research';
import type { ExecutionProfile, StrategyModule } from '@trading/research-contracts/research';
import type { BacktestRunRequest } from '@trading/research-contracts';
import type { ActorCommand, ActorContext, ActorInit, ActorInputEvent } from '@trdlabs/sdk/research-contract';

import { createModuleRegistry } from '../src/engine/sandbox/routing.js';
import { createTrustedRouter, InProcessTrustedModuleExecutor } from '../src/engine/module-executor.js';
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
const BAR_COUNT = 8;
const DATASET_REF = 'actor-e2e-1m';

/** Лента с ЛИНЕЙНЫМ ростом: филлы получают разные цены, и сделка выходит с ненулевым pnl. */
const barsJson = () =>
  Array.from({ length: BAR_COUNT }, (_, i) => ({
    ts: T0 + i * MINUTE_MS,
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100.5 + i,
    volume: 10,
  }));

/** Настоящий файл фикстуры на диске — тот же формат, что читает прод. */
function writeFixture(candleVenue: string | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), 'actor-e2e-'));
  const file = {
    datasetRef: DATASET_REF,
    timeframe: '1m',
    ...(candleVenue !== undefined ? { candleVenue } : {}),
    symbols: { BTCUSDT: barsJson() },
  };
  writeFileSync(join(dir, `${DATASET_REF}.json`), JSON.stringify(file), 'utf8');
  return dir;
}

const BASE_MANIFEST = {
  version: '1.0.0',
  kind: 'strategy' as const,
  name: 'actor e2e',
  summary: 'сквозной прогон actor-пути',
  rationale: 'гейт цепочки фикстура → датасет → раннер',
  author: 'agent',
  contractVersion: CONTRACT_VERSION,
  status: 'research_only' as const,
  paramsSchema: { type: 'object', additionalProperties: false, properties: {} },
  params: {},
  capabilities: { platformSdk: true },
  dataNeeds: { closedCandlesUpToCurrent: true, asOfIndicators: false },
  id: 'actor_e2e_probe',
  lifecycle: 'event_driven',
  hooks: ['onEvent'],
  marketData: [
    {
      kind: 'candles',
      id: 'req-candles',
      instrument: { venue: 'bybit', symbol: 'BTCUSDT' },
      interval: MINUTE_US,
      lookback: 0,
      revisionPolicy: { mode: 'final_only' },
      priceType: 'trade',
    },
  ],
};

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

/**
 * НАСТОЯЩИЙ зарегистрированный профиль — тот же объект, что стоит в `TRUSTED_REGISTRY_DEFINITION`.
 *
 * Прежде здесь жил `NO_LIMITS = { id: 'risk_none', … }`, сконструированный самим тестом, и на нём
 * набор был зелен. Это доказывало сквозную семантику на конфигурации, в которую прод попасть НЕ
 * МОЖЕТ: в реестре такого профиля нет. Долг снят вместе с риск-контуром — теперь путь открыт на
 * том же профиле, что и прод, и «сквозной прогон проходит» означает ровно то, что читается.
 */
const RISK = DEFAULT_RISK;

/**
 * Настоящий `EventDrivenModule`: входит на первой свече, выходит `reduceOnly` на четвёртой.
 *
 * `seen` наполняется ИЗ АКТОРА, то есть с той стороны границы исполнения. Пустой `seen` при
 * `status: 'completed'` означал бы прогон, посчитавший что-то без стратегии.
 */
function eventDrivenProbe() {
  const seen: { kind: ActorInputEvent['kind']; readiness: string; hasPosition: boolean }[] = [];
  const created: ActorInit[] = [];
  const make = (): StrategyModule =>
    ({
      manifest: BASE_MANIFEST,
      createActor(init: ActorInit) {
        created.push(init);
        let bar = -1;
        return {
          onEvent(event: ActorInputEvent, ctx: ActorContext): readonly ActorCommand[] {
            if (event.kind === 'market.candle.closed') bar += 1;
            seen.push({
              kind: event.kind,
              readiness: ctx.readiness,
              hasPosition: ctx.position() !== undefined,
            });
            if (event.kind !== 'market.candle.closed') return [];
            if (bar === 0) {
              return [
                { kind: 'place', type: 'market', clientOrderId: 'e2e-in', side: 'buy', qtyUsd: 1000 } as ActorCommand,
              ];
            }
            if (bar === 3) {
              return [
                {
                  kind: 'place',
                  type: 'market',
                  clientOrderId: 'e2e-out',
                  side: 'sell',
                  qtyUsd: 5000,
                  reduceOnly: true,
                } as ActorCommand,
              ];
            }
            return [];
          },
        };
      },
    }) as unknown as StrategyModule;
  return { make, seen, created };
}

const request = (): BacktestRunRequest =>
  ({
    runId: 'actor-e2e',
    mode: 'research',
    moduleRef: { id: BASE_MANIFEST.id, version: BASE_MANIFEST.version },
    datasetRef: DATASET_REF,
    symbols: ['BTCUSDT'],
    timeframe: '1m',
    period: {
      from: new Date(T0).toISOString(),
      to: new Date(T0 + BAR_COUNT * MINUTE_MS).toISOString(),
    },
    riskProfileRef: { id: RISK.id, version: RISK.version },
    executionProfileRef: { id: NO_COST.id, version: NO_COST.version },
    seed: 11,
    metrics: ['pnl'],
  }) as unknown as BacktestRunRequest;

async function runE2E(
  opts: { candleVenue?: string; enabled?: boolean; withoutStore?: boolean } = {},
): Promise<{
  outcome: RunOutcome;
  seen: ReturnType<typeof eventDrivenProbe>['seen'];
  created: readonly ActorInit[];
  executor: InProcessTrustedModuleExecutor;
  artifactStore: InMemoryArtifactStore;
}> {
  const probe = eventDrivenProbe();
  const dir = writeFixture('candleVenue' in opts ? opts.candleVenue : 'bybit');
  // НАСТОЯЩИЙ загрузчик и настоящий файл: происхождение свечей приезжает с диска, а не из теста.
  const dataset = loadCandleDataset(DATASET_REF, dir);
  const executor = new InProcessTrustedModuleExecutor();
  // ХРАНИЛИЩЕ ОБЯЗАТЕЛЬНО (ADR-0014). До него actor-путь молча не сохранял бы поток
  // диспетчеризации, и прогон, который нельзя объяснить постфактум, выглядел бы здоровым.
  const artifactStore = new InMemoryArtifactStore();
  const outcome = await runBacktest(request(), {
    registry: createModuleRegistry({
      strategies: [Object.assign(probe.make(), { moduleFactory: probe.make })],
      riskProfiles: [RISK],
      executionProfiles: [NO_COST],
    }),
    dataset,
    router: createTrustedRouter(executor),
    eventDrivenEnabled: opts.enabled ?? true,
    ...(opts.withoutStore === true ? {} : { artifactStore }),
  } as never);
  return { outcome, seen: probe.seen, created: probe.created, executor, artifactStore };
}

const refusalOf = (outcome: RunOutcome): { code?: string; message?: string } => {
  const issues = (outcome as { validation?: { issues?: { code: string; message: string }[] } }).validation?.issues;
  return issues?.[0] ?? {};
};

describe('поток диспетчеризации доезжает до результата отдельным артефактом (ADR-0014)', () => {
  it('результат несёт ССЫЛКУ, а не сам поток, и ссылка разрешается в хранилище', async () => {
    const { outcome, artifactStore } = await runE2E();
    if (outcome.status !== 'completed') throw new Error(refusalOf(outcome).message ?? 'отказ');

    // Ссылка одна — актор один. Content-hash, а не путь и не имя: адресуется СОДЕРЖИМОЕ.
    expect(outcome.baseline.artifactRefs).toHaveLength(1);
    const ref = outcome.baseline.artifactRefs[0]!;
    expect(ref).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await artifactStore.has(ref as never)).toBe(true);
  });

  it('содержимое читается и его хеш СВЕРЯЕТСЯ со ссылкой', async () => {
    const { outcome, artifactStore } = await runE2E();
    if (outcome.status !== 'completed') throw new Error(refusalOf(outcome).message ?? 'отказ');

    const ref = outcome.baseline.artifactRefs[0]!;
    const doc = (await artifactStore.read(ref as never)) as ActorTimelineDocument;
    // Три половины гейта целостности по отдельности: разрешилась, прочиталась, СОШЛАСЬ.
    expect(contentRef(doc)).toBe(ref);
    expect(doc.actorId).toBe('actor-btcusdt');
    expect(doc.rows.length).toBeGreaterThan(0);
    // Дескрипторы пережили сериализацию — включая канонический хостовый источник.
    expect(doc.subscriptions.map((s) => s.kind)).toEqual(['host', 'candles']);
  });

  it('САМ поток в результат не попал: платит только тот, кому он нужен', async () => {
    const { outcome } = await runE2E();
    if (outcome.status !== 'completed') throw new Error(refusalOf(outcome).message ?? 'отказ');
    // Проба против соблазна «положить поток в evidence — так удобнее». resultHash считается по
    // всему payload'у, а поток растёт линейно по числу событий: на длинном прогоне ответ /result
    // стал бы непригоден для чтения. В результате обязана быть ССЫЛКА и ничего больше.
    const serialized = JSON.stringify(outcome.baseline);
    expect(serialized).not.toContain('"rows"');
    expect(serialized).not.toContain('causedBySeq');
  });

  it('без хранилища actor-прогон ОТКАЗЫВАЕТ, а не молчит', async () => {
    // Fail-closed. Прогон без возможности сохранить поток неотличим от здорового по результату:
    // метрики, сделки и equity на месте. Поэтому отказ, а не пропуск записи.
    await expect(runE2E({ withoutStore: true })).rejects.toThrow(/artifact store/);
  });
});

describe('сквозной actor-прогон на прямом исполнителе', () => {
  it('фикстура с объявленным venue доходит до результата с ордерами, филлами и сделкой', async () => {
    const { outcome, seen, created, executor } = await runE2E();
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') throw new Error(refusalOf(outcome).message ?? 'отказ');

    const result = outcome.baseline!;
    // Прогон ПОСЧИТАН, а не пропущен: бары обработаны все, кривая equity полна.
    expect(result.summary.barsProcessed).toBe(BAR_COUNT);
    expect(result.evidence.equityCurve).toHaveLength(BAR_COUNT);
    // Обе заявки доехали до артефактов, обе исполнились, вышла ровно одна закрытая сделка.
    expect(result.evidence.simulatedOrders.map((o) => o.id)).toEqual(['e2e-in', 'e2e-out']);
    expect(result.evidence.simulatedFills).toHaveLength(2);
    expect(result.trades).toHaveLength(1);
    expect(result.summary.closedTradesCount).toBe(1);

    // Стратегия ДЕЙСТВИТЕЛЬНО исполнялась: события пришли с той стороны границы.
    expect(created).toHaveLength(1);
    expect(created[0]!.symbol).toBe('BTCUSDT');
    expect(created[0]!.seed).toBe(11);
    // Подписки уехали автору те самые, что разрешил допуск.
    // Источники: хостовый КАНОНИЧЕСКИЙ плюс разрешённые рыночные. Правило автора одно и без
    // исключений — идентификатор конверта всегда есть в этом списке.
    expect(created[0]!.subscriptions.map((s) => s.kind)).toEqual(['host', 'candles']);
    expect(
      created[0]!.subscriptions.filter((s) => s.kind !== 'host').map((s) => s.requirementId),
    ).toEqual(['req-candles']);
    expect(seen.filter((s) => s.kind === 'market.candle.closed')).toHaveLength(BAR_COUNT);
    // lookback=0 → торговые права с первого события, прогрева нет.
    expect(seen.every((s) => s.readiness === 'ready')).toBe(true);
    // Позицию автор видел — то есть контекст был не пустой формой.
    expect(seen.some((s) => s.hasPosition)).toBe(true);
    // Актор освобождён: исполнитель не держит сессий после прогона.
    expect(executor.activeActorSessions()).toBe(0);
  }, 60_000);

  it('НЕГАТИВНАЯ ПРОБА: фикстура без candleVenue закрывает путь', async () => {
    // Доказывает, что происхождение свечей приезжает ИЗ ФАЙЛА, а не подставляется по дороге: тот же
    // прогон отличается ровно одним отсутствующим полем в JSON.
    const { outcome, created } = await runE2E({ candleVenue: undefined });
    expect(outcome.status).toBe('rejected');
    expect(refusalOf(outcome).message).toMatch(/происхождение свечей не доказано/);
    // И актор не создавался: отказ раньше.
    expect(created).toEqual([]);
  }, 60_000);

  it('НЕГАТИВНАЯ ПРОБА: чужой venue в фикстуре закрывает путь', async () => {
    // Требование манифеста объявлено на bybit; лента, записанная с другого венью, — другой предмет.
    const { outcome, created } = await runE2E({ candleVenue: 'binance' });
    expect(outcome.status).toBe('rejected');
    expect(refusalOf(outcome).message).toMatch(/venue|венью/i);
    expect(created).toEqual([]);
  }, 60_000);

  it('НЕГАТИВНАЯ ПРОБА: при выключенном флаге прогон отвергается, стратегия не звана', async () => {
    const { outcome, created } = await runE2E({ enabled: false });
    expect(outcome.status).toBe('rejected');
    expect(refusalOf(outcome).code).toBe('unsupported_lifecycle');
    expect(created).toEqual([]);
  }, 60_000);
});

describe('атомарность владения у прямого исполнителя', () => {
  it('отвергнутое создание не оставляет сессии', async () => {
    const executor = new InProcessTrustedModuleExecutor();
    const before = executor.activeActorSessions();
    const source = { manifest: { id: 'no-actor' } as never, module: {} };
    await expect(executor.createActor(source, {} as ActorInit)).rejects.toThrow(/не предоставляет createActor/);
    // Модуль, чей createActor вернул не актора, — второй способ отвергнуться уже ПОСЛЕ вызова.
    const badSource = { manifest: { id: 'bad-actor' } as never, module: { createActor: () => ({}) } };
    await expect(executor.createActor(badSource, {} as ActorInit)).rejects.toThrow(/вернул не актора/);
    expect(executor.activeActorSessions()).toBe(before);
  });

  it('ПРОВЕРКА ПРОВЕРКИ: успешное создание сессию заводит, а dispose снимает', async () => {
    // Иначе «ноль сессий» зеленело бы у исполнителя, который их не заводит вовсе.
    const executor = new InProcessTrustedModuleExecutor();
    const source = {
      manifest: { id: 'ok-actor' } as never,
      module: { createActor: () => ({ onEvent: () => [] }) },
    };
    const handle = await executor.createActor(source, {} as ActorInit);
    expect(executor.activeActorSessions()).toBe(1);
    await executor.disposeActor(handle);
    expect(executor.activeActorSessions()).toBe(0);
    // Повторное освобождение — no-op, а не бросок.
    await executor.disposeActor(handle);
    expect(executor.activeActorSessions()).toBe(0);
  });
});
