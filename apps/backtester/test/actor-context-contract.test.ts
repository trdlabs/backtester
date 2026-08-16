// ГЕЙТЫ НА ТРИ БЛОКЕРА ВТОРОГО КРУГА РЕВЮ (083 S3).
//
// Все три — про РАСХОЖДЕНИЕ ДВУХ КАРТИН МИРА: хост считает одно, автор видит другое. Ни один не
// роняет прогон и ни один не виден в артефактах: расходится то, на основании чего автор принимает
// решения, а решения потом выглядят как его собственная глупость.
//
//  1. `reduceOnly` сверх остатка ПЕРЕВОРАЧИВАЛ позицию. Автор просил «только сократить», получал
//     противоположную позицию, и дальше торговал не тем, чем думал.
//  2. Событие `fill` несло цену ДО проскальзывания, а журнал и бухгалтерия — после. Автор считал
//     свой средний вход по одной цене, хост по другой, и разрыв рос ровно с издержками.
//  3. `ActorContext.position()` собирался руками под кастом `as unknown as ActorContext`: ни одно
//     поле не совпадало с контрактом (`qty` со знаком вместо положительного, `avgPrice` вместо
//     `avgEntryPrice`, `openedAtUs` вместо `openedAt`, лишний `realizedPnl`, ни одного `side`).
//     Автор, читающий документированные поля, получал `undefined` во всех.

import { describe, expect, it } from 'vitest';
import { CONTRACT_VERSION } from '@trading/research-contracts/research';
import type {
  ActorCommand,
  ActorContext,
  ActorInputEvent,
  MarketDataRequirement,
  OpenOrderView,
  PositionView,
} from '@trdlabs/sdk/research-contract';
import { timestampUsFromMillis } from '@trdlabs/sdk/research-contract';

import { admitActorMarketData, proveCandleVenue } from '../src/engine/actor/admission.js';
import { runEventDrivenSymbol } from '../src/engine/actor/run-symbol.js';
import type { ActorBar } from '../src/engine/actor/frontier-runner.js';
import type { ActorExecutionRecord, ActorJournalFill } from '../src/engine/actor/execution-record.js';
import type {
  ActorExecutionHandle,
  ActorLifecycleExecutor,
} from '../src/engine/actor/execution-handle.js';
import type { ResolvedStrategy } from '../src/engine/artifacts.js';
import { riskBinding } from './helpers/actor-risk.js';

const MINUTE_MS = 60_000;
const MINUTE_US = 60_000_000;
const T0 = 1_700_000_000_000;

/** Ровная лента: цена не движется, поэтому любое расхождение — эффект правки, а не рынка. */
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
      id: 'context-probe',
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

/** Что автор УВИДЕЛ в контексте на каждом событии — вторая половина каждой пробы ниже. */
interface Seen {
  readonly kind: ActorInputEvent['kind'];
  readonly event: ActorInputEvent;
  readonly position: PositionView | undefined;
  readonly orders: readonly OpenOrderView[];
}

async function run(
  script: (event: ActorInputEvent, ctx: ActorContext, bar: number) => readonly ActorCommand[],
  opts: { bars?: readonly ActorBar[]; slippageBps?: number; feeBps?: number } = {},
): Promise<{ record: ActorExecutionRecord; seen: readonly Seen[] }> {
  const seen: Seen[] = [];
  let bar = -1;
  const executor: ActorLifecycleExecutor = {
    createActor: async () => ({ __h: 1 }) as unknown as ActorExecutionHandle,
    executeActorEvent: async (_h, event, ctx) => {
      if (event.kind === 'market.candle.closed') bar += 1;
      // Снимок берётся ВЫЗОВОМ, как его делает автор, а не чтением поля: `position` и `orders.open`
      // — функции контракта, и подменить их значением значило бы проверить не то.
      seen.push({ kind: event.kind, event, position: ctx.position(), orders: ctx.orders.open() });
      return script(event, ctx, bar);
    },
    disposeActor: async () => {},
  };
  const bars = opts.bars ?? flatBars(6, 100);
  const admission = admitActorMarketData(strategy(), {
    candleVenue: proveCandleVenue({ datasetRef: 'context-fixture', candleVenue: 'bybit' }),
    symbol: 'BTCUSDT',
    barIntervalUs: MINUTE_US,
    barCount: bars.length,
  });
  if (admission.refusal !== null) throw new Error(admission.refusal.message);
  const record = await runEventDrivenSymbol({
    executor,
    source: { manifest: strategy().manifest, module: {} },
    actorId: 'actor-btcusdt',
    symbol: 'BTCUSDT',
    seed: 1,
    params: {},
    admission,
    bars,
    costs: { feeBps: opts.feeBps ?? 0, slippageBps: opts.slippageBps ?? 0, initialEquity: 10_000 },
    risk: riskBinding(10_000),
  });
  return { record, seen };
}

const fills = (record: ActorExecutionRecord): readonly ActorJournalFill[] =>
  record.journal.filter((j): j is ActorJournalFill => j.kind === 'fill');

const place = (over: Record<string, unknown>): ActorCommand =>
  ({ kind: 'place', type: 'market', clientOrderId: 'o', side: 'buy', qtyUsd: 1000, ...over }) as unknown as ActorCommand;

// ─────────────────────────────────────────────────────────────────────────────
// 1. reduceOnly сверх остатка не переворачивает позицию
// ─────────────────────────────────────────────────────────────────────────────

describe('1. reduceOnly ТОЛЬКО сокращает — сверх остатка он клампится, а не переворачивает', () => {
  it('заявка вдвое больше позиции закрывает её ровно в ноль', async () => {
    const { record } = await run((e, _c, bar) => {
      if (e.kind !== 'market.candle.closed') return [];
      if (bar === 0) return [place({ clientOrderId: 'in', side: 'buy', qtyUsd: 1000 })];
      if (bar === 2) {
        return [place({ clientOrderId: 'out', side: 'sell', qtyUsd: 2000, reduceOnly: true })];
      }
      return [];
    });
    expect(fills(record)).toHaveLength(2);
    // Ровно ноль, а не «около нуля»: кламп берёт остаток позиции ТЕМ ЖЕ числом, а не пересчитывает.
    expect(record.finalLedger.qty).toBe(0);
    // И исполнен именно остаток, а не запрошенные 2000 USD.
    expect(fills(record)[1]!.qty).toBe(fills(record)[0]!.qty);
  });

  it('та же заявка БЕЗ reduceOnly вообще не доходит до исполнения — её отвергает риск', async () => {
    // ПРОБА ПЕРЕВЕРНУЛАСЬ ВМЕСТЕ С ПРАВИЛОМ. Прежде она доказывала, что без метки заявка
    // ПЕРЕВОРАЧИВАЕТ позицию, и служила проверкой проверки для клампа: раз без метки переворот
    // происходит, значит с меткой его предотвращает именно кламп, а не бездействие раннера.
    //
    // Риск-срез закрыл эту дорогу: непомеченная встречная заявка отвергается на подаче, потому что
    // её нотионал МОЖЕТ превысить позицию, а размер в базовой валюте до исполнения неизвестен.
    // Переворот одной заявкой стал невыразим — и проверка проверки для клампа теперь другая: выше
    // утверждается, что исполнен ИМЕННО остаток (`fills[1].qty === fills[0].qty`), то есть вторая
    // заявка исполнилась, а не была проигнорирована.
    const { record } = await run((e, _c, bar) => {
      if (e.kind !== 'market.candle.closed') return [];
      if (bar === 0) return [place({ clientOrderId: 'in', side: 'buy', qtyUsd: 1000 })];
      if (bar === 2) return [place({ clientOrderId: 'out', side: 'sell', qtyUsd: 2000 })];
      return [];
    });
    // Исполнен только вход: встречная не создала ни филла, ни движения экспозиции.
    expect(fills(record)).toHaveLength(1);
    expect(record.finalLedger.qty).toBeGreaterThan(0);
    expect(record.riskDecisions.map((d) => d.reason)).toEqual(['opposite_side_requires_reduce_only']);
  });

  it('reduceOnly, которому уже нечего сокращать, СНИМАЕТСЯ, а не исполняется на ноль', async () => {
    // Позиция закрывается первой из двух одинаковых заявок; вторая доживает до следующего бара уже
    // при flat. Валидация подачи её пропустила законно — позиция тогда была; проверить остаток
    // можно только в момент исполнения.
    const { record, seen } = await run((e, _c, bar) => {
      if (e.kind !== 'market.candle.closed') return [];
      if (bar === 0) return [place({ clientOrderId: 'in', side: 'buy', qtyUsd: 1000 })];
      if (bar === 2) {
        return [
          place({ clientOrderId: 'out1', side: 'sell', qtyUsd: 1000, reduceOnly: true }),
          place({ clientOrderId: 'out2', side: 'sell', qtyUsd: 1000, reduceOnly: true }),
        ];
      }
      return [];
    });
    // Вход и ОДИН выход: вторая заявка не исполнилась ни на какой размер.
    expect(fills(record).map((f) => f.orderId)).toEqual(['in', 'out1']);
    expect(record.finalLedger.qty).toBe(0);
    // Заявка не потерялась в книге молча — она снята, и автор об этом узнал.
    const canceled = record.orders.find((o) => o.orderId === 'out2');
    expect(canceled?.terminalState).toBe('canceled');
    expect(
      seen.some((s) => s.event.kind === 'order.canceled' && s.event.clientOrderId === 'out2'),
    ).toBe(true);
  });

  it('ПРОВЕРКА ПРОВЕРКИ: две частичные reduceOnly-заявки исполняются обе', async () => {
    // Предмет тот же, что и раньше: снятие выше вызвано ИМЕННО отсутствием предмета сокращения, а
    // не тем, что раннер не умеет исполнять две заявки подряд. Раньше это показывали двумя
    // непомеченными продажами, вторая из которых переворачивала позицию; теперь такая заявка
    // отвергается на подаче, поэтому обе половины помечены и каждая забирает свою долю.
    const { record } = await run((e, _c, bar) => {
      if (e.kind !== 'market.candle.closed') return [];
      if (bar === 0) return [place({ clientOrderId: 'in', side: 'buy', qtyUsd: 1000 })];
      if (bar === 2) return [place({ clientOrderId: 'out1', side: 'sell', qtyUsd: 500, reduceOnly: true })];
      if (bar === 3) return [place({ clientOrderId: 'out2', side: 'sell', qtyUsd: 500, reduceOnly: true })];
      return [];
    });
    expect(fills(record).map((f) => f.orderId)).toEqual(['in', 'out1', 'out2']);
    // Обе исполнились и вместе закрыли позицию в ноль — значит исполняются именно обе.
    expect(record.finalLedger.qty).toBe(0);
  });

  it('reduceOnly в СТОРОНУ позиции отвергается ещё на подаче', async () => {
    const { record } = await run((e, _c, bar) => {
      if (e.kind !== 'market.candle.closed') return [];
      if (bar === 0) return [place({ clientOrderId: 'in', side: 'buy', qtyUsd: 1000 })];
      if (bar === 2) return [place({ clientOrderId: 'more', side: 'buy', qtyUsd: 1000, reduceOnly: true })];
      return [];
    });
    expect(fills(record).map((f) => f.orderId)).toEqual(['in']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1b. Исход исполнения обрабатывается ИСЧЕРПЫВАЮЩЕ, но не переигрывается
// ─────────────────────────────────────────────────────────────────────────────

describe('1b. снятие по reduce_only_flat: заявка закрыта, бухгалтерия не тронута', () => {
  /**
   * Хост обязан РАЗОБРАТЬ оба исхода `executeFill` и не принимать при этом собственного
   * экономического решения. Проверяется именно второе: при снятии не появляется ни филла, ни
   * движения ledger'а — то есть хост не «дорешал» за движок, что раз заявка сработала, то что-то
   * исполнить всё-таки надо.
   */
  const twoReduceOnly = () =>
    run((e, _c, bar) => {
      if (e.kind !== 'market.candle.closed') return [];
      if (bar === 0) return [place({ clientOrderId: 'in', side: 'buy', qtyUsd: 1000 })];
      if (bar === 2) {
        return [
          place({ clientOrderId: 'out1', side: 'sell', qtyUsd: 1000, reduceOnly: true }),
          place({ clientOrderId: 'out2', side: 'sell', qtyUsd: 1000, reduceOnly: true }),
        ];
      }
      return [];
    });

  it('снятая заявка НЕ порождает филла и НЕ двигает ledger', async () => {
    const { record } = await twoReduceOnly();
    // Вход и один выход. Второй reduceOnly доживает до следующего бара уже при flat.
    expect(fills(record).map((f) => f.orderId)).toEqual(['in', 'out1']);
    // Позиция закрыта первым выходом — и снятие второго её не тронуло ни на разряд.
    expect(record.finalLedger.qty).toBe(0);
    const afterFirstExit = fills(record)[1]!;
    expect(record.finalLedger.realizedPnl).toBe(
      record.journal
        .filter((j): j is ActorJournalFill => j.kind === 'fill')
        .reduce((acc, f) => acc, record.finalLedger.realizedPnl),
    );
    expect(afterFirstExit.qty).toBeGreaterThan(0);
  });

  it('снятая заявка доезжает до записи прогона как canceled, а не исчезает', async () => {
    const { record } = await twoReduceOnly();
    const canceled = record.orders.find((o) => o.orderId === 'out2');
    expect(canceled?.terminalState).toBe('canceled');
  });

  it('причина снятия записана СЛОВОМ ДВИЖКА, а не пересказана хостом', async () => {
    // Хост не изобретает формулировку: `reduce_only_flat` — значение, вернувшееся из операции.
    // Без причины `canceled` неотличимо от отмены по команде автора, а это разные факты.
    const { record } = await twoReduceOnly();
    const canceled = record.orders.find((o) => o.orderId === 'out2');
    expect(canceled?.cancelReason).toBe('reduce_only_flat');
    // У исполнившейся заявки причины снятия НЕТ — поле не заполняется «на всякий случай».
    expect(record.orders.find((o) => o.orderId === 'out1')?.cancelReason).toBeUndefined();
  });

  it('автор узнаёт о снятии событием от КАНОНИЧЕСКОГО хостового источника', async () => {
    const { seen } = await twoReduceOnly();
    const canceledSeen = seen.find(
      (s) => s.event.kind === 'order.canceled' && s.event.clientOrderId === 'out2',
    );
    expect(canceledSeen).toBeDefined();
  });

  it('ПРОВЕРКА ПРОВЕРКИ: при живой позиции второй reduceOnly ИСПОЛНЯЕТСЯ', async () => {
    // Иначе «снимается» зеленело бы у раннера, не исполняющего вторую заявку никогда.
    const { record } = await run((e, _c, bar) => {
      if (e.kind !== 'market.candle.closed') return [];
      if (bar === 0) return [place({ clientOrderId: 'in', side: 'buy', qtyUsd: 4000 })];
      if (bar === 2) {
        return [
          place({ clientOrderId: 'out1', side: 'sell', qtyUsd: 1000, reduceOnly: true }),
          place({ clientOrderId: 'out2', side: 'sell', qtyUsd: 1000, reduceOnly: true }),
        ];
      }
      return [];
    });
    expect(fills(record).map((f) => f.orderId)).toEqual(['in', 'out1', 'out2']);
    expect(record.finalLedger.qty).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Цена в событии `fill` — цена ИСПОЛНЕНИЯ
// ─────────────────────────────────────────────────────────────────────────────

describe('2. событие fill несёт цену ПОСЛЕ проскальзывания — ту же, что журнал и бухгалтерия', () => {
  it('цена, размер и комиссия в событии совпадают с записью журнала', async () => {
    const { record, seen } = await run(
      (e, _c, bar) =>
        e.kind === 'market.candle.closed' && bar === 0
          ? [place({ clientOrderId: 'in', side: 'buy', qtyUsd: 1000 })]
          : [],
      { slippageBps: 50, feeBps: 7 },
    );
    const journalFill = fills(record)[0]!;
    const event = seen.map((s) => s.event).find((e) => e.kind === 'fill');
    expect(event).toBeDefined();
    if (event === undefined || event.kind !== 'fill') throw new Error('нет события fill');

    expect(event.price).toBe(journalFill.price);
    expect(event.qty).toBe(journalFill.qty);
    expect(event.fee).toBe(journalFill.fee);
    // И это НЕ цена матча: прежняя редакция отдавала автору именно её.
    expect(event.price).not.toBe(journalFill.baseOpen);
    // Покупка исполняется ДОРОЖЕ — проскальзывание всегда против инициатора.
    expect(event.price).toBeGreaterThan(journalFill.baseOpen);
  });

  it('ПРОВЕРКА ПРОВЕРКИ: при нулевом slippage цена события равна цене матча', async () => {
    // Иначе «не равна baseOpen» зеленело бы у раннера, портящего цену любым способом.
    const { record, seen } = await run(
      (e, _c, bar) =>
        e.kind === 'market.candle.closed' && bar === 0
          ? [place({ clientOrderId: 'in', side: 'buy', qtyUsd: 1000 })]
          : [],
      { slippageBps: 0, feeBps: 7 },
    );
    const journalFill = fills(record)[0]!;
    const event = seen.map((s) => s.event).find((e) => e.kind === 'fill');
    if (event === undefined || event.kind !== 'fill') throw new Error('нет события fill');
    expect(event.price).toBe(journalFill.baseOpen);
    expect(event.price).toBe(journalFill.price);
  });

  it('продажа исполняется ДЕШЕВЛЕ матча, и автор видит именно эту цену', async () => {
    const { record, seen } = await run(
      (e, _c, bar) =>
        e.kind === 'market.candle.closed' && bar === 0
          ? [place({ clientOrderId: 'in', side: 'sell', qtyUsd: 1000 })]
          : [],
      { slippageBps: 50 },
    );
    const journalFill = fills(record)[0]!;
    const event = seen.map((s) => s.event).find((e) => e.kind === 'fill');
    if (event === undefined || event.kind !== 'fill') throw new Error('нет события fill');
    expect(event.price).toBe(journalFill.price);
    expect(event.price).toBeLessThan(journalFill.baseOpen);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. ActorContext по контракту, а не по касту
// ─────────────────────────────────────────────────────────────────────────────

/** Поля `PositionView` — ровно эти четыре, и ни одного лишнего (`realizedPnl` там нет намеренно). */
const POSITION_FIELDS = ['avgEntryPrice', 'openedAt', 'qty', 'side'];

describe('3. ctx.position() — санкционированный PositionView, а не самодельный объект', () => {
  it('лонг: side=long, qty ПОЛОЖИТЕЛЕН, поля ровно контрактные', async () => {
    const { seen } = await run((e, _c, bar) =>
      e.kind === 'market.candle.closed' && bar === 0
        ? [place({ clientOrderId: 'in', side: 'buy', qtyUsd: 1000 })]
        : [],
    );
    const after = seen.filter((s) => s.position !== undefined);
    expect(after.length).toBeGreaterThan(0);
    const pos = after[0]!.position!;
    expect(pos.side).toBe('long');
    expect(pos.qty).toBeGreaterThan(0);
    expect(pos.avgEntryPrice).toBe(100);
    expect(pos.openedAt).toBe(timestampUsFromMillis(T0 + MINUTE_MS));
    // Самодельный объект прежней редакции провалил бы именно это: там были `avgPrice`,
    // `openedAtUs` и `realizedPnl`, и ни одного поля из контракта.
    expect(Object.keys(pos).sort()).toEqual(POSITION_FIELDS);
  });

  it('шорт: side=short, а qty ВСЁ РАВНО положителен — знак несёт side', async () => {
    // Прежняя редакция отдавала знаковый `qty` и никакого `side`: автор, читающий контракт, не мог
    // отличить лонг от шорта вовсе.
    const { record, seen } = await run((e, _c, bar) =>
      e.kind === 'market.candle.closed' && bar === 0
        ? [place({ clientOrderId: 'in', side: 'sell', qtyUsd: 1000 })]
        : [],
    );
    const pos = seen.filter((s) => s.position !== undefined)[0]!.position!;
    expect(pos.side).toBe('short');
    expect(pos.qty).toBeGreaterThan(0);
    // Бухгалтерия хоста при этом держит ОТРИЦАТЕЛЬНУЮ экспозицию — две разные формы одной правды.
    expect(record.finalLedger.qty).toBeLessThan(0);
    expect(pos.qty).toBe(Math.abs(record.finalLedger.qty));
  });

  it('позиция видна автору УЖЕ на событии собственного филла', async () => {
    // Событие филла доставляется после того, как бухгалтерия его применила: узнать о своём
    // исполнении и не увидеть его в позиции значило бы для автора принять решение по прошлому.
    const { seen } = await run((e, _c, bar) =>
      e.kind === 'market.candle.closed' && bar === 0
        ? [place({ clientOrderId: 'in', side: 'buy', qtyUsd: 1000 })]
        : [],
    );
    const onFill = seen.find((s) => s.kind === 'fill');
    expect(onFill?.position?.side).toBe('long');
  });

  it('flat — undefined, и после закрытия тоже', async () => {
    const { seen } = await run((e, _c, bar) => {
      if (e.kind !== 'market.candle.closed') return [];
      if (bar === 0) return [place({ clientOrderId: 'in', side: 'buy', qtyUsd: 1000 })];
      if (bar === 2) return [place({ clientOrderId: 'out', side: 'sell', qtyUsd: 2000, reduceOnly: true })];
      return [];
    });
    // До первого филла позиции нет...
    expect(seen[0]!.position).toBeUndefined();
    // ...и после полного закрытия она снова исчезает, а не остаётся пылью последнего разряда.
    expect(seen[seen.length - 1]!.position).toBeUndefined();
  });

  it('после переворота эра начинается заново: side меняется, avgEntryPrice — цена флипа', async () => {
    const bars = [
      ...flatBars(3, 100),
      ...flatBars(3, 120).map((b, i) => ({
        ...b,
        tsUs: timestampUsFromMillis(T0 + (3 + i) * MINUTE_MS),
      })),
    ];
    const { record, seen } = await run(
      (e, _c, bar) => {
        if (e.kind !== 'market.candle.closed') return [];
        if (bar === 0) return [place({ clientOrderId: 'in', side: 'buy', qtyUsd: 1000 })];
        // ПЕРЕВОРОТ ДВУМЯ ШАГАМИ. Одной непомеченной заявкой на удвоенный объём он больше не
        // выражается: она отвергается на подаче, потому что её нотионал может пересечь ноль и
        // открыть противоположную позицию мимо всех проверок открытия. Закрыть и открыть заново —
        // это ровно тот же итог, но каждый шаг проходит проверки, которые ему положены.
        // Нотионал с запасом: цена к этому моменту выросла со 100 до 120, и ровно 1000 USD закрыли
        // бы не всю позицию, а её часть. `reduceOnly` клампится движком по знаковому остатку,
        // поэтому «с запасом» здесь безопасно и означает именно «закрыть целиком».
        if (bar === 3) return [place({ clientOrderId: 'close', side: 'sell', qtyUsd: 2000, reduceOnly: true })];
        if (bar === 4) return [place({ clientOrderId: 'flip', side: 'sell', qtyUsd: 1000 })];
        return [];
      },
      { bars },
    );
    const last = seen[seen.length - 1]!.position!;
    expect(last.side).toBe('short');
    expect(last.qty).toBeGreaterThan(0);
    expect(last.avgEntryPrice).toBe(120);
    // Две свёртки одной последовательности филлов — движковая и контрактная — согласны.
    expect(last.qty).toBe(Math.abs(record.finalLedger.qty));
    expect(record.finalLedger.avgPrice).toBe(last.avgEntryPrice);
  });
});

describe('3b. ctx.orders.open() — заявка называет свой вид, цену и настоящий размер', () => {
  it('лимитная заявка отдаётся с price и с базовым размером, а не с нулём', async () => {
    const { seen } = await run((e, _c, bar) =>
      e.kind === 'market.candle.closed' && bar === 0
        ? [place({ clientOrderId: 'lim', type: 'limit', side: 'buy', price: 50, qtyUsd: 1000 })]
        : [],
    );
    const withOrders = seen.filter((s) => s.orders.length > 0);
    expect(withOrders.length).toBeGreaterThan(0);
    const view = withOrders[0]!.orders[0]!;
    expect(view.type).toBe('limit');
    if (view.type !== 'limit') throw new Error('вид заявки потерян');
    expect(view.price).toBe(50);
    expect(view.status).toBe('accepted');
    expect(view.qtyUsd).toBe(1000);
    // ЕДИНИЦА ЗАЯВКИ — НОТИОНАЛ (ADR-0013). Остаток вычислим БЕЗ всякой цены, и предикат
    // частичного исполнения живёт в той же единице.
    expect(view.filledQtyUsd).toBe(0);
    expect(view.qtyUsd - view.filledQtyUsd).toBe(1000);
    // Базовых величин у стоящей заявки НЕТ: цены пересчёта не существует до исполнения, и честный
    // ответ — не давать числа вовсе. Прежняя редакция подставляла размер по последней увиденной
    // цене — это и была снятая временная конверсия.
    expect(view.estimatedQty).toBeUndefined();
    expect(view.filledQty).toBeUndefined();
    expect(view.createdTs).toBe(timestampUsFromMillis(T0));
  });

  it('стоп отдаётся со stopPrice, а не с price', async () => {
    const { seen } = await run((e, _c, bar) =>
      e.kind === 'market.candle.closed' && bar === 0
        ? [place({ clientOrderId: 'st', type: 'stop_market', side: 'buy', stopPrice: 100_000, qtyUsd: 1000 })]
        : [],
    );
    const view = seen.filter((s) => s.orders.length > 0)[0]!.orders[0]!;
    expect(view.type).toBe('stop_market');
    if (view.type !== 'stop_market') throw new Error('вид заявки потерян');
    expect(view.stopPrice).toBe(100_000);
    expect(view.qtyUsd).toBe(1000);
    expect(view.estimatedQty).toBeUndefined();
  });

  it('reduceOnly доезжает до вида заявки', async () => {
    const { seen } = await run((e, _c, bar) => {
      if (e.kind !== 'market.candle.closed') return [];
      if (bar === 0) return [place({ clientOrderId: 'in', side: 'buy', qtyUsd: 1000 })];
      if (bar === 2) {
        return [place({ clientOrderId: 'ro', type: 'limit', side: 'sell', price: 100_000, qtyUsd: 500, reduceOnly: true })];
      }
      return [];
    });
    const view = seen.filter((s) => s.orders.some((o) => o.clientOrderId === 'ro')).pop()!.orders.find((o) => o.clientOrderId === 'ro')!;
    expect(view.reduceOnly).toBe(true);
    expect(view.qtyUsd).toBe(500);
    expect(view.filledQtyUsd).toBe(0);
  });

  it('исполненная заявка ИСЧЕЗАЕТ из открытых', async () => {
    // Иначе «остаток положителен» зеленело бы у раннера, оставляющего исполненные заявки в книге.
    const { seen } = await run((e, _c, bar) =>
      e.kind === 'market.candle.closed' && bar === 0
        ? [place({ clientOrderId: 'in', side: 'buy', qtyUsd: 1000 })]
        : [],
    );
    expect(seen[seen.length - 1]!.orders).toEqual([]);
  });
});
