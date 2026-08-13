// НЕГАТИВНЫЕ ГЕЙТЫ НА ПЯТЬ ДЕФЕКТОВ ИСПОЛНЕНИЯ (083 S3, ревью владельца).
//
// Все пять были внесены проводкой и все пять ТИХИЕ: ни один не роняет прогон, каждый меняет числа
// так, что результат выглядит нормально. Именно поэтому каждый закрыт пробой, а не наблюдением.
//
//  1. stopPrice читался не из того поля и подменялся нулём;
//  2. slippage объявлялся в журнале, но не применялся к цене;
//  3. риск-контур отсутствовал, а прогон шёл как ни в чём не бывало;
//  4. заявка попадала в запись только при исполнении — снятая исчезала бесследно;
//  5. reduceOnly был отметкой в поле, а не проверкой сокращения экспозиции.

import { describe, expect, it } from 'vitest';
import { CONTRACT_VERSION } from '@trading/research-contracts/research';
import type { ActorCommand, ActorInputEvent, MarketDataRequirement } from '@trdlabs/sdk/research-contract';
import { timestampUsFromMillis } from '@trdlabs/sdk/research-contract';

import { admitActorMarketData, proveCandleVenue } from '../src/engine/actor/admission.js';
import { unenforcedRiskLimits } from '../src/engine/actor/production.js';
import { runEventDrivenSymbol } from '../src/engine/actor/run-symbol.js';
import type { ActorBar } from '../src/engine/actor/frontier-runner.js';
import type { ActorExecutionRecord } from '../src/engine/actor/execution-record.js';
import type {
  ActorExecutionHandle,
  ActorLifecycleExecutor,
} from '../src/engine/actor/execution-handle.js';
import type { ResolvedStrategy } from '../src/engine/artifacts.js';

const MINUTE_MS = 60_000;
const MINUTE_US = 60_000_000;
const T0 = 1_700_000_000_000;

/** Ровная лента: цена не меняется, поэтому любое расхождение — эффект правки, а не движения рынка. */
const flatBars = (n: number, price: number): readonly ActorBar[] =>
  Array.from({ length: n }, (_, i) => ({
    tsUs: timestampUsFromMillis(T0 + i * MINUTE_MS),
    open: price,
    high: price + 5,
    low: price - 5,
    close: price,
  }));

const strategy = (): ResolvedStrategy =>
  ({
    manifest: {
      id: 'defects-probe',
      version: '1.0.0',
      kind: 'strategy',
      contractVersion: CONTRACT_VERSION,
      lifecycle: 'event_driven',
      marketData: [
        {
          kind: 'candles',
          id: 'req-candles',
          instrument: { venue: 'bybit', symbol: 'BTCUSDT' },
          interval: MINUTE_US,
          lookback: 0,
          revisionPolicy: { mode: 'final_only' },
          priceType: 'trade',
        } as unknown as MarketDataRequirement,
      ],
    },
    module: {},
  }) as unknown as ResolvedStrategy;

async function run(
  script: (event: ActorInputEvent, barSeen: number) => readonly ActorCommand[],
  opts: { bars?: readonly ActorBar[]; slippageBps?: number } = {},
): Promise<ActorExecutionRecord> {
  let barSeen = 0;
  const executor: ActorLifecycleExecutor = {
    createActor: async () => ({ __h: 1 }) as unknown as ActorExecutionHandle,
    executeActorEvent: async (_h, event) => {
      if (event.kind === 'market.candle.closed') barSeen += 1;
      return script(event, barSeen);
    },
    disposeActor: async () => {},
  };
  const bars = opts.bars ?? flatBars(6, 100);
  const admission = admitActorMarketData(strategy(), {
    candleVenue: proveCandleVenue({ datasetRef: 'defects-fixture', candleVenue: 'bybit' }),
    symbol: 'BTCUSDT',
    barIntervalUs: MINUTE_US,
    barCount: bars.length,
  });
  if (admission.refusal !== null) throw new Error(admission.refusal.message);
  return runEventDrivenSymbol({
    executor,
    source: { manifest: strategy().manifest, module: {} },
    actorId: 'actor-btcusdt',
    symbol: 'BTCUSDT',
    seed: 1,
    params: {},
    admission,
    bars,
    costs: { feeBps: 0, slippageBps: opts.slippageBps ?? 0, initialEquity: 10_000 },
  });
}

const place = (over: Record<string, unknown>): ActorCommand =>
  ({ kind: 'place', clientOrderId: 'o1', side: 'buy', qtyUsd: 1000, ...over }) as unknown as ActorCommand;

describe('1. stopPrice читается из СВОЕГО поля, а не подменяется нулём', () => {
  it('стоп с недостижимым триггером НЕ исполняется', async () => {
    // Прежняя редакция читала `.price ?? .triggerPrice ?? 0`. У stop_market ни того, ни другого
    // нет — оставался ноль, и заявка на покупку срабатывала немедленно на любом баре.
    const record = await run((e) =>
      e.kind === 'market.candle.closed' ? [place({ type: 'stop_market', stopPrice: 100_000 })] : [],
    );
    expect(record.journal.filter((j) => j.kind === 'fill')).toEqual([]);
  });

  it('ПРОВЕРКА ПРОВЕРКИ: достижимый триггер исполняется', async () => {
    // Иначе «не исполняется» зеленело бы у раннера, не исполняющего стопы вовсе.
    let sent = false;
    const record = await run((e) => {
      if (e.kind !== 'market.candle.closed' || sent) return [];
      sent = true;
      return [place({ type: 'stop_market', stopPrice: 102 })];
    });
    expect(record.journal.filter((j) => j.kind === 'fill')).toHaveLength(1);
  });

  it('лимитная заявка берёт price, а не stopPrice', async () => {
    let sent = false;
    const record = await run((e) => {
      if (e.kind !== 'market.candle.closed' || sent) return [];
      sent = true;
      return [place({ type: 'limit', price: 98 })];
    });
    const fill = record.journal.find((j) => j.kind === 'fill');
    expect(fill).toBeDefined();
    // Лимит исполняется по СВОЕЙ цене, а не по цене бара.
    expect(fill!.kind === 'fill' ? fill!.baseOpen : 0).toBe(98);
  });

  it('нулевая или отрицательная цена — отказ, а не молчаливое исполнение', async () => {
    const record = await run((e) =>
      e.kind === 'market.candle.closed' ? [place({ type: 'stop_market', stopPrice: 0 })] : [],
    );
    const entry = record.timeline.find((t) => t.commands.some((c) => c.command.kind === 'place'))!;
    const outcome = entry.commands.find((c) => c.command.kind === 'place')!.outcome;
    expect(outcome.status).toBe('rejected');
    expect(outcome.status === 'rejected' ? outcome.reason : '').toMatch(/положительную цену/);
  });
});

describe('2. slippage ПРИМЕНЯЕТСЯ к цене, а не только объявляется', () => {
  it('покупка исполняется ХУЖЕ базовой цены ровно на объявленные bps', async () => {
    // Прежняя редакция клала slippageBps в журнал и считала филл по цене матча: запись утверждала
    // расход, которого не было, и прогон показывал прибыль лучше настоящей.
    let sent = false;
    const record = await run(
      (e) => {
        if (e.kind !== 'market.candle.closed' || sent) return [];
        sent = true;
        return [place({ type: 'market' })];
      },
      { slippageBps: 100 }, // 1%
    );
    const fill = record.journal.find((j) => j.kind === 'fill')!;
    if (fill.kind !== 'fill') throw new Error('ожидался филл');
    expect(fill.baseOpen).toBe(100);
    expect(fill.price).toBeCloseTo(101, 10); // покупка дороже
    expect(fill.slippageBps).toBe(100);
    // Ledger посчитан по цене ПОСЛЕ проскальзывания — иначе журнал и бухгалтерия разошлись бы.
    expect(record.finalLedger.avgPrice).toBeCloseTo(101, 10);
  });

  it('продажа исполняется ХУЖЕ в другую сторону — ниже базовой', async () => {
    // Направление сдвига обязано зависеть от стороны: единый знак дарил бы одной из сторон прибыль.
    let step = 0;
    const record = await run(
      (e) => {
        if (e.kind !== 'market.candle.closed') return [];
        step += 1;
        if (step === 1) return [place({ type: 'market', clientOrderId: 'in', side: 'buy' })];
        if (step === 3) return [place({ type: 'market', clientOrderId: 'out', side: 'sell' })];
        return [];
      },
      { slippageBps: 100 },
    );
    const fills = record.journal.filter((j) => j.kind === 'fill');
    expect(fills).toHaveLength(2);
    const sell = fills[1]!;
    if (sell.kind !== 'fill') throw new Error('ожидался филл');
    expect(sell.price).toBeCloseTo(99, 10);
  });

  it('ПРОВЕРКА ПРОВЕРКИ: при нулевом slippage цена равна базовой', async () => {
    let sent = false;
    const record = await run((e) => {
      if (e.kind !== 'market.candle.closed' || sent) return [];
      sent = true;
      return [place({ type: 'market' })];
    });
    const fill = record.journal.find((j) => j.kind === 'fill')!;
    if (fill.kind !== 'fill') throw new Error('ожидался филл');
    expect(fill.price).toBe(fill.baseOpen);
  });
});

describe('3. риск-контур: отсутствует — значит fail-closed, а не «как-нибудь»', () => {
  it('объявленные лимиты перечисляются поимённо', () => {
    expect(
      unenforcedRiskLimits({
        id: 'r',
        version: '1',
        maxConcurrentPositions: 3,
        exposureLimits: { maxPositionNotionalPct: 10 },
        allowedSides: ['long'],
        stopBounds: {},
      }),
    ).toEqual([
      'maxConcurrentPositions=3',
      'exposureLimits',
      'allowedSides=[long]',
      'stopBounds',
    ]);
  });

  it('профиль без лимитов не мешает', () => {
    // Проверка проверки: без неё «лимиты отвергаются» зеленело бы и у функции, возвращающей всё.
    expect(unenforcedRiskLimits({ id: 'r', version: '1', allowedSides: ['long', 'short'] })).toEqual([]);
  });

  it('пустой exposureLimits — это отсутствие лимита, а не лимит', () => {
    expect(unenforcedRiskLimits({ id: 'r', version: '1', exposureLimits: {} })).toEqual([]);
  });
});

describe('4. FSM заявки: снятая и отклонённая остаются в записи', () => {
  it('отменённая заявка попадает в запись с terminalState canceled', async () => {
    // Прежняя редакция заводила запись только при филле: снятая заявка исчезала бесследно, и
    // артефакты показывали ровно те ордера, что сработали.
    let step = 0;
    const record = await run((e) => {
      if (e.kind !== 'market.candle.closed') return [];
      step += 1;
      if (step === 1) return [place({ type: 'limit', price: 50 })]; // недостижимый лимит
      if (step === 2) return [{ kind: 'cancel', clientOrderId: 'o1' } as ActorCommand];
      return [];
    });
    expect(record.orders).toHaveLength(1);
    expect(record.orders[0]!.orderId).toBe('o1');
    expect(record.orders[0]!.terminalState).toBe('canceled');
    expect(record.journal.filter((j) => j.kind === 'fill')).toEqual([]);
  });

  it('заявка, не дожившая до исполнения, остаётся accepted — а не пропадает', async () => {
    const record = await run((e) =>
      e.kind === 'market.candle.closed' ? [place({ type: 'limit', price: 50, clientOrderId: 'o1' })] : [],
    );
    // Подаётся один раз (повтор id отклоняется), исполниться не может — но она БЫЛА.
    expect(record.orders).toHaveLength(1);
    expect(record.orders[0]!.terminalState).toBe('accepted');
  });

  it('исполненная заявка доходит до filled через автомат', async () => {
    let sent = false;
    const record = await run((e) => {
      if (e.kind !== 'market.candle.closed' || sent) return [];
      sent = true;
      return [place({ type: 'market' })];
    });
    expect(record.orders[0]!.terminalState).toBe('filled');
  });
});

describe('5. reduceOnly — проверка сокращения, а не отметка в поле', () => {
  it('reduceOnly при flat отклоняется: сокращать нечего', async () => {
    const record = await run((e) =>
      e.kind === 'market.candle.closed' ? [place({ type: 'market', reduceOnly: true })] : [],
    );
    const entry = record.timeline.find((t) => t.commands.some((c) => c.command.kind === 'place'))!;
    const outcome = entry.commands.find((c) => c.command.kind === 'place')!.outcome;
    expect(outcome.status).toBe('rejected');
    expect(outcome.status === 'rejected' ? outcome.reason : '').toMatch(/позиция flat/);
  });

  it('reduceOnly в ту же сторону отклоняется: он бы НАРАЩИВАЛ экспозицию', async () => {
    // Главная проба блока. Прежняя редакция такую заявку исполняла: она объявляла сокращение, а
    // делала наращивание. Биржа её не исполнит — значит прогон показывал позицию, которой не было.
    let step = 0;
    const record = await run((e) => {
      if (e.kind !== 'market.candle.closed') return [];
      step += 1;
      if (step === 1) return [place({ type: 'market', clientOrderId: 'in', side: 'buy' })];
      if (step === 3) return [place({ type: 'market', clientOrderId: 'more', side: 'buy', reduceOnly: true })];
      return [];
    });
    const entry = record.timeline.find((t) =>
      t.commands.some((c) => c.command.kind === 'place' && (c.command as { clientOrderId: string }).clientOrderId === 'more'),
    )!;
    const outcome = entry.commands.find((c) => c.command.kind === 'place')!.outcome;
    expect(outcome.status).toBe('rejected');
    expect(outcome.status === 'rejected' ? outcome.reason : '').toMatch(/наращивает экспозицию/);
    // И позиция осталась одной покупкой, а не двумя.
    expect(record.journal.filter((j) => j.kind === 'fill')).toHaveLength(1);
  });

  it('ПРОВЕРКА ПРОВЕРКИ: reduceOnly в противоположную сторону проходит', async () => {
    // Иначе три пробы выше зеленели бы и у реализации, отвергающей любой reduceOnly.
    let step = 0;
    const record = await run((e) => {
      if (e.kind !== 'market.candle.closed') return [];
      step += 1;
      if (step === 1) return [place({ type: 'market', clientOrderId: 'in', side: 'buy' })];
      if (step === 3) return [place({ type: 'market', clientOrderId: 'out', side: 'sell', reduceOnly: true })];
      return [];
    });
    expect(record.journal.filter((j) => j.kind === 'fill')).toHaveLength(2);
  });
});
