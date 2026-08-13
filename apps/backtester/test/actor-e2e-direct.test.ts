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
import type { RunOutcome } from '../src/engine/artifacts.js';

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
  fillModel: { kind: 'same_bar_close' } as never,
  feeModel: { kind: 'fixed_bps', bps: 0 },
  slippageModel: { kind: 'fixed_bps', bps: 0 },
};

/** Профиль БЕЗ объявленных лимитов — единственный, на котором actor-путь сегодня открыт. */
const NO_LIMITS = { id: 'risk_none', version: '1.0.0', allowedSides: ['long', 'short'] };

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
    riskProfileRef: { id: NO_LIMITS.id, version: NO_LIMITS.version },
    executionProfileRef: { id: NO_COST.id, version: NO_COST.version },
    seed: 11,
    metrics: ['pnl'],
  }) as unknown as BacktestRunRequest;

async function runE2E(opts: { candleVenue?: string; enabled?: boolean } = {}): Promise<{
  outcome: RunOutcome;
  seen: ReturnType<typeof eventDrivenProbe>['seen'];
  created: readonly ActorInit[];
  executor: InProcessTrustedModuleExecutor;
}> {
  const probe = eventDrivenProbe();
  const dir = writeFixture('candleVenue' in opts ? opts.candleVenue : 'bybit');
  // НАСТОЯЩИЙ загрузчик и настоящий файл: происхождение свечей приезжает с диска, а не из теста.
  const dataset = loadCandleDataset(DATASET_REF, dir);
  const executor = new InProcessTrustedModuleExecutor();
  const outcome = await runBacktest(request(), {
    registry: createModuleRegistry({
      strategies: [Object.assign(probe.make(), { moduleFactory: probe.make })],
      riskProfiles: [NO_LIMITS as never],
      executionProfiles: [NO_COST],
    }),
    dataset,
    router: createTrustedRouter(executor),
    eventDrivenEnabled: opts.enabled ?? true,
  } as never);
  return { outcome, seen: probe.seen, created: probe.created, executor };
}

const refusalOf = (outcome: RunOutcome): { code?: string; message?: string } => {
  const issues = (outcome as { validation?: { issues?: { code: string; message: string }[] } }).validation?.issues;
  return issues?.[0] ?? {};
};

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
    expect(created[0]!.subscriptions.map((s) => s.requirementId)).toEqual(['req-candles']);
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
