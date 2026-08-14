// 083 S3 — reduce-only заявка, чья ПОЗИЦИЯ ИЗМЕНИЛАСЬ между подачей и срабатыванием.
//
// ЧЕМ ЭТОТ ФАЙЛ ОТЛИЧАЕТСЯ ОТ `actor-execution-defects.test.ts` (блок 5). Там reduce-only
// проверяется В МОМЕНТ ПОДАЧИ: `validate` отвергает заявку, если позиции нет вовсе или если
// заявка смотрит в сторону позиции. Обе те пробы законны, но обе закрывают ОДИН момент времени —
// тот, в котором автор нажимает «подать».
//
// Здесь закрывается ДРУГОЙ момент. Заявка подана законно: позиция есть, заявка её сокращает,
// `validate` пропускает. Заявка ВСТАЁТ В КНИГУ и ждёт свою цену. Пока она ждёт, позиция живёт
// своей жизнью — её может закрыть другая заявка, а может и перевернуть. Когда цена наконец
// доходит, заявка исполняется против позиции, КОТОРОЙ УЖЕ НЕТ ИЛИ КОТОРАЯ СТАЛА ДРУГОЙ.
//
// Проверка на подаче про этот момент не знает ничего, и знать не может: в момент подачи будущего
// состояния не существует. Поэтому решение принимает движок — в момент исполнения, по знаковому
// остатку позиции (`executeFill`, engine 0.17.0).
//
// ДВА СОСТОЯНИЯ, ДВА СЛОВА, И РАЗЛИЧАТЬ ИХ ОБЯЗАТЕЛЬНО:
//
//   • позицию ЗАКРЫЛИ           → `reduce_only_flat`           — сокращать нечего;
//   • позицию ПЕРЕВЕРНУЛИ       → `reduce_only_would_increase`  — сокращать есть что, но не этой
//                                                                заявкой: она бы НАРАСТИЛА.
//
// Пока хост считал ограничение сам (`sizeCap`), оба случая приходили в движок нулём и получали
// одно слово — `flat`. Автор, разбирающий причину, во втором случае закрывал бы своё ожидание
// неверным фактом: «позиции нет» там, где позиция есть и она противоположна ожидаемой.

import { describe, expect, it } from 'vitest';
import { CONTRACT_VERSION } from '@trading/research-contracts/research';
import type { ActorCommand, ActorInputEvent, MarketDataRequirement } from '@trdlabs/sdk/research-contract';
import { timestampUsFromMillis } from '@trdlabs/sdk/research-contract';

import { admitActorMarketData, proveCandleVenue } from '../src/engine/actor/admission.js';
import { runEventDrivenSymbol } from '../src/engine/actor/run-symbol.js';
import type { ActorBar } from '../src/engine/actor/frontier-runner.js';
import type { ActorExecutionRecord, ActorOrderRecord } from '../src/engine/actor/execution-record.js';
import type {
  ActorExecutionHandle,
  ActorLifecycleExecutor,
} from '../src/engine/actor/execution-handle.js';
import type { ResolvedStrategy } from '../src/engine/artifacts.js';

const MINUTE_MS = 60_000;
const MINUTE_US = 60_000_000;
const T0 = 1_700_000_000_000;

/**
 * Лента с УСТУПОМ: первые `flat` баров стоят на 100, остальные — на 200.
 *
 * Уступ и есть механизм сценария. Ждущая заявка стоит с триггером 150: на нижней полке он
 * недостижим (high = 105), на верхней — достигается (high = 205). Это даёт то, чего не даёт ровная
 * лента: интервал времени, в течение которого заявка ГАРАНТИРОВАННО стоит в книге и не может
 * исполниться, — а позиция в это время меняется.
 */
const steppedBars = (flat: number, total: number): readonly ActorBar[] =>
  Array.from({ length: total }, (_, i) => {
    const price = i < flat ? 100 : 200;
    return {
      tsUs: timestampUsFromMillis(T0 + i * MINUTE_MS),
      open: price,
      high: price + 5,
      low: price - 5,
      close: price,
    };
  });

const strategy = (): ResolvedStrategy =>
  ({
    manifest: {
      id: 'reduce-only-temporal',
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
  const bars = steppedBars(4, 6);
  const admission = admitActorMarketData(strategy(), {
    candleVenue: proveCandleVenue({ datasetRef: 'reduce-only-temporal', candleVenue: 'bybit' }),
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
    costs: { feeBps: 0, slippageBps: 0, initialEquity: 10_000 },
  });
}

const place = (over: Record<string, unknown>): ActorCommand =>
  ({ kind: 'place', side: 'buy', qtyUsd: 1000, ...over }) as unknown as ActorCommand;

/**
 * Общий сценарий обеих проб: разница ровно в ОДНОМ числе — объёме встречной заявки.
 *
 * Заявки в этом симуляторе матчатся в начале frontier'а, поэтому поданная на баре N исполняется
 * не раньше N+1. Отсюда раскладка:
 *
 *   бар 1 — исполняется `in` (лонг на 10), подаётся `ro`: sell limit 150, reduce-only. Позиция
 *           есть, заявка её сокращает — `validate` пропускает, заявка встаёт в книгу;
 *   бар 2 — подаётся `shift`: обычная рыночная продажа. Не reduce-only, проверок сокращения к ней
 *           не применяется;
 *   бар 3 — `ro` по-прежнему недостижима (high = 105 < 150), исполняется `shift` и меняет позицию;
 *   бар 4 — полка 200, high = 205 ≥ 150: `ro` наконец срабатывает — и встречает ДРУГУЮ позицию.
 */
const runWithShift = (shiftUsd: number): Promise<ActorExecutionRecord> => {
  let step = 0;
  return run((e) => {
    if (e.kind !== 'market.candle.closed') return [];
    step += 1;
    if (step === 1) return [place({ clientOrderId: 'in', side: 'buy', type: 'market' })];
    if (step === 2) {
      return [place({ clientOrderId: 'ro', side: 'sell', type: 'limit', price: 150, reduceOnly: true })];
    }
    if (step === 3) {
      return [place({ clientOrderId: 'shift', side: 'sell', type: 'market', qtyUsd: shiftUsd })];
    }
    return [];
  });
};

const orderOf = (record: ActorExecutionRecord, id: string): ActorOrderRecord => {
  const found = record.orders.find((o) => o.orderId === id);
  if (found === undefined) {
    throw new Error(`заявки '${id}' нет в записи прогона: ${record.orders.map((o) => o.orderId).join(', ')}`);
  }
  return found;
};

describe('reduce-only: позицию ЗАКРЫЛИ, пока заявка ждала', () => {
  // Встречная продажа ровно на 1000 при цене 100 закрывает лонг из 10 в ТОЧНЫЙ ноль: 1000/100 = 10
  // без остатка. Точность здесь существенна — «почти ноль» был бы уже другим состоянием, и движок
  // честно ответил бы на него клампом, а не снятием.
  const scenario = () => runWithShift(1000);

  it('заявка снимается со словом reduce_only_flat', async () => {
    const record = await scenario();
    expect(orderOf(record, 'ro').cancelReason).toBe('reduce_only_flat');
  });

  it('заявка доходит до canceled через автомат, а не исчезает', async () => {
    const record = await scenario();
    expect(orderOf(record, 'ro').terminalState).toBe('canceled');
  });

  it('филла нет: снятие НЕ материализуется в бухгалтерии', async () => {
    const record = await scenario();
    // Исполнились ровно две заявки — вход и встречная. Третьего филла быть не может: заявка снята.
    const fills = record.journal.filter((j) => j.kind === 'fill');
    expect(fills.map((f) => (f.kind === 'fill' ? f.orderId : ''))).toEqual(['in', 'shift']);
  });

  it('позиция осталась закрытой — ledger не сдвинулся снятием', async () => {
    const record = await scenario();
    expect(record.finalLedger.qty).toBe(0);
  });
});

describe('reduce-only: позицию ПЕРЕВЕРНУЛИ, пока заявка ждала', () => {
  // Встречная продажа на 2000 при цене 100 — это 20 к продаже против лонга в 10: позиция не просто
  // закрывается, а становится ШОРТОМ в 10. Теперь `ro` (продажа) смотрит в СТОРОНУ позиции.
  const scenario = () => runWithShift(2000);

  it('заявка снимается со словом reduce_only_would_increase, а НЕ flat', async () => {
    const record = await scenario();
    // Главное утверждение файла. Схлопывание в `flat` сообщило бы автору «позиции нет» там, где
    // позиция есть — просто перевёрнутая. Ровно это и делал прежний `sizeCap`.
    expect(orderOf(record, 'ro').cancelReason).toBe('reduce_only_would_increase');
  });

  it('позиция ДЕЙСТВИТЕЛЬНО перевёрнута — иначе проба выше проверяла бы не тот случай', async () => {
    const record = await scenario();
    // Проверка проверки. Без неё утверждение о слове прошло бы и на flat-позиции, то есть
    // доказывало бы совсем другой сценарий.
    expect(record.finalLedger.qty).toBeLessThan(0);
  });

  it('филла нет и здесь: наращивать позицию reduce-only заявка не вправе', async () => {
    const record = await scenario();
    const fills = record.journal.filter((j) => j.kind === 'fill');
    expect(fills.map((f) => (f.kind === 'fill' ? f.orderId : ''))).toEqual(['in', 'shift']);
  });
});

describe('два состояния РАЗЛИЧИМЫ, а не совпадают', () => {
  it('один и тот же сценарий с разным объёмом встречной заявки даёт РАЗНЫЕ слова', async () => {
    // Прямое опровержение схлопывания. Если бы движок отвечал одним словом на оба состояния, эта
    // проба была бы единственной, которая это заметит: обе причины по отдельности выглядят
    // правдоподобно, и только их РАЗЛИЧИЕ доказывает, что состояние действительно различается.
    const [closed, flipped] = await Promise.all([runWithShift(1000), runWithShift(2000)]);
    const a = orderOf(closed, 'ro').cancelReason;
    const b = orderOf(flipped, 'ro').cancelReason;

    // ОБА исхода обязаны быть снятиями, и только потом — разными. Первая редакция сравнивала лишь
    // на неравенство, и это оказалось слабее, чем выглядело: под мутацией знака перевёрнутый
    // случай переставал сниматься вовсе, `cancelReason` становился `undefined` — и «не равно»
    // проходило. Проба «различаются» обязана сперва потребовать, чтобы было ЧЕМУ различаться.
    expect([a, b].every((r) => r !== undefined)).toBe(true);
    expect(new Set([a, b]).size).toBe(2);
  });
});

describe('cancelReason типизирован движковым union, а не string', () => {
  it('чужое слово не проходит проверку типов', () => {
    const record: Pick<ActorOrderRecord, 'cancelReason'> = { cancelReason: 'reduce_only_flat' };
    expect(record.cancelReason).toBe('reduce_only_flat');

    // @ts-expect-error — пересказ хоста не является причиной снятия: тип выведен из `canceled`-члена
    // движкового `FillOutcome`, и поле принимает ТОЛЬКО слова движка. Если тип разъедется обратно
    // в `string`, ошибки здесь не будет — и `@ts-expect-error` уронит сборку сам.
    const paraphrase: Pick<ActorOrderRecord, 'cancelReason'> = { cancelReason: 'нечего сокращать' };
    expect(paraphrase).toBeDefined();
  });
});
