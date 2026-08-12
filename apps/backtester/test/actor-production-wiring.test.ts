// ГЕЙТЫ ПРОДОВОЙ ТОЧКИ ВЫЗОВА (083 S3).
//
// Проверяется, что actor-путь доезжает до НАСТОЯЩЕГО результата прогона — того же
// `RunAccumulators`, который потребляет `assembleResult`, а не собственной формы. Вторая форма
// evidence совпадала бы с первой сегодня и разошлась бы завтра, причём молча.
//
// И проверяется, что подключение НЕ ослабило fail-closed: датасет без объявленного происхождения
// свечей закрывает путь до создания актора. Ни один реальный датасет его сегодня не объявляет —
// значит поведение прода не изменилось ни на один прогон.

import { describe, expect, it } from 'vitest';
import { CONTRACT_VERSION } from '@trading/research-contracts/research';
import type { ActorCommand, ActorInputEvent, MarketDataRequirement } from '@trdlabs/sdk/research-contract';

import { runActorProduction, actorIdFor } from '../src/engine/actor/production.js';
import type { CandleDataset } from '../src/engine/dataset.js';
import type { ActorLifecycleExecutor, ActorExecutionHandle } from '../src/engine/actor/execution-handle.js';
import type { ResolvedStrategy } from '../src/engine/artifacts.js';

const MINUTE_MS = 60_000;
const MINUTE_US = 60_000_000;
const T0 = 1_700_000_000_000;

const strategyFor = (symbols: readonly string[]): ResolvedStrategy =>
  ({
    manifest: {
      id: 'wiring-probe',
      version: '1.0.0',
      kind: 'strategy',
      contractVersion: CONTRACT_VERSION,
      lifecycle: 'event_driven',
      marketData: symbols.map(
        (symbol, i) =>
          ({
            kind: 'candles',
            id: `req-${i}`,
            instrument: { venue: 'bybit', symbol },
            interval: MINUTE_US,
            lookback: 0,
            revisionPolicy: { mode: 'final_only' },
            priceType: 'trade',
          }) as unknown as MarketDataRequirement,
      ),
    },
    module: {},
  }) as unknown as ResolvedStrategy;

function datasetOf(symbols: readonly string[], candleVenue?: string): CandleDataset {
  const bars = (base: number) =>
    Array.from({ length: 4 }, (_, i) => ({
      ts: T0 + i * MINUTE_MS,
      open: base + i,
      high: base + 1 + i,
      low: base - 1 + i,
      close: base + 0.5 + i,
      volume: 10,
    }));
  const bySymbol = new Map(symbols.map((s, i) => [s, bars(100 + i * 50)]));
  return {
    datasetRef: 'wiring-fixture-1m',
    timeframe: '1m',
    ...(candleVenue !== undefined ? { candleVenue } : {}),
    symbols: () => [...symbols],
    candles: (s: string) => (bySymbol.get(s) ?? []) as never,
  } as unknown as CandleDataset;
}

/** Один и тот же исполнитель для обеих проб: транспорты различаются ИМ, а не путём. */
function executorPlacingOnce(): ActorLifecycleExecutor {
  const placedBy = new Set<string>();
  return {
    createActor: async (_src, init) => ({ __h: init.symbol }) as unknown as ActorExecutionHandle,
    executeActorEvent: async (handle, event: ActorInputEvent) => {
      const key = (handle as unknown as { __h: string }).__h;
      if (event.kind !== 'market.candle.closed' || placedBy.has(key)) return [];
      placedBy.add(key);
      return [
        { kind: 'place', type: 'market', clientOrderId: `${key}-o1`, side: 'buy', qtyUsd: 500 } as ActorCommand,
      ];
    },
    disposeActor: async () => {},
  };
}

const COSTS = { feeBps: 5, slippageBps: 0, initialEquity: 10_000 };

describe('actor-путь доезжает до настоящего RunAccumulators', () => {
  it('на доказанном датасете возвращает аккумуляторы, а не свою форму', async () => {
    const out = await runActorProduction({
      strategy: strategyFor(['BTCUSDT']),
      executor: executorPlacingOnce(),
      dataset: datasetOf(['BTCUSDT'], 'bybit'),
      symbols: ['BTCUSDT'],
      seed: 1,
      params: {},
      costs: COSTS,
      barIntervalUs: MINUTE_US,
    });
    expect(out.refusal).toBeNull();
    const acc = out.accumulators!;
    // Ровно те поля, которые читает `assembleResult`: своей формы здесь не заводится.
    expect(Object.keys(acc).sort()).toEqual(
      [
        'decisionRecords',
        'equityCurve',
        'fills',
        'fundingLedger',
        'orderIndex',
        'orders',
        'riskDecisions',
        'trades',
        'validationIssues',
      ].sort(),
    );
    expect(acc.orders).toHaveLength(1);
    expect(acc.fills).toHaveLength(1);
    expect(acc.equityCurve).toHaveLength(4);
    // `orderIndex` ведётся вместе с `orders` — рассинхрон сделал бы `findOrder` слепым.
    expect(acc.orderIndex.size).toBe(acc.orders.length);
    expect(out.barsProcessed).toBe(4);
  });

  it('многосимвольный прогон отвергается: правило не выбрано контрактом', async () => {
    // НЕ догадка и не заглушка. У event-driven манифеста `marketData[].instrument` называет
    // конкретный инструмент; при нескольких акторах непонятно, что он означает для каждого —
    // «применять только совпавшие» теряет требование молча, «подставлять символ актора» лишает
    // поле смысла и исполнит стратегию, написанную под BTC, на ETH. Оба чтения меняют смысл
    // публичного поля, поэтому до решения владельца — отказ.
    const symbols = ['BTCUSDT', 'ETHUSDT'];
    const out = await runActorProduction({
      strategy: strategyFor(symbols),
      executor: executorPlacingOnce(),
      dataset: datasetOf(symbols, 'bybit'),
      symbols,
      seed: 1,
      params: {},
      costs: COSTS,
      barIntervalUs: MINUTE_US,
    });
    expect(out.refusal?.code).toBe('unsupported_lifecycle');
    expect(out.refusal?.message).toMatch(/поднимает по актору на символ/);
    expect(out.accumulators).toBeUndefined();
  });

  it('ПРОВЕРКА ПРОВЕРКИ: односимвольный прогон той же формы проходит', async () => {
    // Иначе «многосимвольный отвергается» зеленело бы и у реализации, отвергающей любой прогон.
    const out = await runActorProduction({
      strategy: strategyFor(['BTCUSDT']),
      executor: executorPlacingOnce(),
      dataset: datasetOf(['BTCUSDT'], 'bybit'),
      symbols: ['BTCUSDT'],
      seed: 1,
      params: {},
      costs: COSTS,
      barIntervalUs: MINUTE_US,
    });
    expect(out.refusal).toBeNull();
    expect(out.records!.map((r) => r.actorId)).toEqual([actorIdFor('BTCUSDT')]);
  });
});

describe('подключение НЕ ослабило fail-closed', () => {
  it('датасет без объявленного происхождения свечей закрывает путь', async () => {
    // Это состояние ВСЕХ реальных датасетов сегодня: рекордер знал венью и выбросил его.
    const out = await runActorProduction({
      strategy: strategyFor(['BTCUSDT']),
      executor: executorPlacingOnce(),
      dataset: datasetOf(['BTCUSDT']), // без candleVenue
      symbols: ['BTCUSDT'],
      seed: 1,
      params: {},
      costs: COSTS,
      barIntervalUs: MINUTE_US,
    });
    expect(out.refusal?.code).toBe('unsupported_lifecycle');
    expect(out.refusal?.message).toMatch(/происхождение свечей не доказано/);
    expect(out.accumulators).toBeUndefined();
  });

  it('чужой интервал закрывает путь ДО создания актора', async () => {
    // Проба следит за порядком: исполнитель, у которого создание бросает, не должен быть позван
    // вовсе. Если бы отказ случался позже, тест упал бы с «изолят не поднялся».
    const throwingExecutor: ActorLifecycleExecutor = {
      createActor: async () => {
        throw new Error('createActor не должен вызываться');
      },
      executeActorEvent: async () => [],
      disposeActor: async () => {},
    };
    const out = await runActorProduction({
      strategy: strategyFor(['BTCUSDT']),
      executor: throwingExecutor,
      dataset: datasetOf(['BTCUSDT'], 'bybit'),
      symbols: ['BTCUSDT'],
      seed: 1,
      params: {},
      costs: COSTS,
      barIntervalUs: 5 * MINUTE_US, // лента объявлена пятиминутной, требование минутное
    });
    expect(out.refusal?.message).toMatch(/интервал/);
  });

  it('отказ ОДНОГО символа отменяет прогон целиком, а не исключает символ', async () => {
    // Частичный прогон вернул бы результат по подмножеству запрошенного и ничем бы об этом не
    // сообщил — числа получились бы правдоподобные.
    const symbols = ['BTCUSDT', 'ETHUSDT'];
    const strategy = strategyFor(['BTCUSDT']); // требование объявлено только на первый символ
    const out = await runActorProduction({
      strategy,
      executor: executorPlacingOnce(),
      dataset: datasetOf(symbols, 'bybit'),
      symbols,
      seed: 1,
      params: {},
      costs: COSTS,
      barIntervalUs: MINUTE_US,
    });
    expect(out.refusal).not.toBeNull();
    expect(out.accumulators).toBeUndefined();
  });
});
