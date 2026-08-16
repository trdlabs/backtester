// ГЕЙТ: проекция «actor execution record → артефакты» отображает и ПРОВЕРЯЕТ.
//
// Четыре группы утверждений, и они доказывают разное:
//
//   1. ОТОБРАЖЕНИЕ — каждое из семи семейств артефактов получает то, что должно, поле в поле.
//      Проверяется целым выходом, а не по одному полю: сравнение полного объекта валится и на
//      забытом ключе, и на лишнем, тогда как поштучные `expect` ловят только перечисленное.
//   2. ПОРЯДОК — выход идёт в порядке записи, одинаковый вход даёт побайтово одинаковый выход.
//   3. ОТКАЗ — запись, которая не сходится сама с собой, отвергается ЦЕЛИКОМ. Главная группа:
//      перекладывание полей ошибиться почти не может, а раннер, потерявший факт, — может.
//   4. СДЕЛКИ — их считает ДВИЖОК из журнала, а хост приносит только причины закрытия. Здесь
//      проверяется шов: что причина доезжает, что имя строится по правилу legacy и что синтетика
//      конца данных не порождает лишнего артефактного филла.
//
// ═══ ПОЧЕМУ ЯКОРЬ ЛЕДЖЕРА ПРОВЕРЯЕТСЯ ОТРИЦАТЕЛЬНО ═══
//
// Фикстура собирает `finalLedger` теми же движковыми функциями, которыми сворачивает проекция. Само
// по себе совпадение поэтому не пиннит НИЧЕГО про правильность свёртки — оно пиннит только
// проводку. Урок оплачен однажды: оракул, выведенный из реализации, согласен с ней по построению.
//
// Работу делают отрицательные пробы: выбросить филл, подменить causedBy, переставить две записи.

import { describe, expect, it } from 'vitest';
import { EMPTY_LEDGER, applyFill, applyFunding } from '@trdlabs/engine';
import type { Fill, Ledger, OrderState, RiskDecision } from '@trdlabs/engine';
import { timestampUsFromMillis } from '@trdlabs/sdk/research-contract';

import { canonicalJson } from '../src/determinism/canonical-json.js';
import { ledgerFillOf } from '../src/engine/actor/execution-record.js';
import type {
  ActorExecutionRecord,
  ActorFrontierRecord,
  ActorJournalEntry,
} from '../src/engine/actor/execution-record.js';
import type { ActorTimeline, ActorTimelineArtifact } from '../src/engine/actor/timeline.js';
import type { ActorCommand, ActorInputEvent } from '@trdlabs/sdk/research-contract';
import { ActorTimelineError } from '../src/engine/actor/timeline.js';
import {
  ActorProjectionError,
  ORDER_STATUS_BY_STATE,
  assertTradesReconcile,
  projectActorRun,
} from '../src/engine/actor/projection.js';
import type { ActorRunArtifacts } from '../src/engine/actor/projection.js';
import type { MergedAccumulators } from '../src/engine/runner.js';

const SYMBOL = 'BTCUSDT';
const ACTOR_ID = 'actor-btcusdt-0';
const SUBSCRIPTIONS = Object.freeze([
  Object.freeze({ subscriptionId: 'sub-req-candles', kind: 'candles', requirementId: 'req-candles' }),
]) as ActorExecutionRecord['subscriptions'];
const T0 = 1_700_000_000_000; // мс, минутная сетка
const MINUTE = 60_000;

const frontier = (index: number, lastCommittedSeq: number): ActorFrontierRecord => ({
  index,
  tsUs: timestampUsFromMillis(T0 + index * MINUTE),
  lastCommittedSeq,
});

// `lastCommittedSeq` согласованы с потоком ниже: гейт timeline сверяет их с максимальным
// доставленным `seq` каждого frontier'а, и произвольные числа здесь означали бы, что зафиксировано
// то, чего не доставлялось.
const FRONTIERS = [frontier(0, 0), frontier(1, 1), frontier(2, 2)];

const fillEntry = (
  fillId: string,
  orderId: string,
  frontierIndex: number,
  side: 'buy' | 'sell',
  qty: number,
  price: number,
  fee: number,
  extra: { baseOpen?: number; slippageBps?: number; fillKind?: 'open' | 'add' | 'close' | 'protection' } = {},
): ActorJournalEntry => ({
  kind: 'fill',
  frontier: frontierIndex,
  fillId,
  orderId,
  tsUs: FRONTIERS[frontierIndex]!.tsUs,
  price,
  baseOpen: extra.baseOpen ?? price,
  slippageBps: extra.slippageBps ?? 0,
  qty,
  fee,
  side,
  ...(extra.fillKind !== undefined ? { fillKind: extra.fillKind } : {}),
});

const fundingEntry = (frontierIndex: number, cost: number, rate = 0.0001): ActorJournalEntry => ({
  kind: 'funding',
  frontier: frontierIndex,
  tsUs: FRONTIERS[frontierIndex]!.tsUs,
  rate,
  covered: true,
  cost,
});

/** Свернуть журнал теми же функциями, что применяет проекция. */
function foldAnchor(journal: readonly ActorJournalEntry[]): Ledger {
  let ledger: Ledger = EMPTY_LEDGER;
  for (const entry of journal) {
    ledger =
      entry.kind === 'fill'
        ? applyFill(ledger, ledgerFillOf(entry))
        : applyFunding(ledger, { tsUs: entry.tsUs, cost: entry.cost });
  }
  return ledger;
}

/**
 * Минимальный связный поток на три frontier'а базовой записи.
 *
 * Своя форма и свои гарды живут в `actor-timeline.test.ts`; здесь он нужен потому, что успешный
 * прогон без потока проекция не принимает — и это проверяется отдельным тестом ниже.
 */
const PLACE: ActorCommand = {
  kind: 'place',
  type: 'market',
  clientOrderId: 'o1',
  side: 'buy',
  qtyUsd: 100,
};

// Настоящее контрактное значение, без приведений: `as never` обходил бы ровно ту типовую
// гарантию, ради которой таксономия закрыта типами SDK.
const candleEvent = (i: number): ActorInputEvent => ({
  kind: 'market.candle.closed',
  candle: {
    effectiveTsUs: FRONTIERS[i]!.tsUs,
    value: { open: 100, high: 101, low: 99, close: 100.5, volume: 10 },
    finality: 'final',
    revision: 0,
  },
});

const SUB = 'sub-btc-1m';

const timelineEntry = (i: number, commands: ActorTimeline[number]['commands'] = []) => ({
  envelope: { seq: i, eventTsUs: FRONTIERS[i]!.tsUs, subscriptionId: SUB, event: candleEvent(i) },
  frontier: i,
  commands,
});

const TIMELINE: ActorTimeline = [
  timelineEntry(0, [{ command: PLACE, outcome: { status: 'applied' } }]),
  timelineEntry(1),
  timelineEntry(2),
];

/** Ожидаемая артефактная форма того же потока — он обязан ДОЖИТЬ до результата, а не только пройти проверку. */
const TIMELINE_ROWS: ActorTimelineArtifact = [
  {
    seq: 0,
    barIndex: 0,
    ts: T0,
    subscriptionId: SUB,
    event: candleEvent(0),
    commands: [{ command: PLACE, status: 'applied' }],
  },
  { seq: 1, barIndex: 1, ts: T0 + MINUTE, subscriptionId: SUB, event: candleEvent(1), commands: [] },
  { seq: 2, barIndex: 2, ts: T0 + 2 * MINUTE, subscriptionId: SUB, event: candleEvent(2), commands: [] },
];

const RISK: RiskDecision = {
  barIndex: 0,
  decisionKind: 'open_long',
  action: 'accept',
  reason: 'within limits',
};

/**
 * Базовая запись: вход 2 @ 100 на баре 0, funding 0.5 на баре 1, выход 2 @ 110 на баре 2.
 *
 * Числа подобраны так, чтобы бухгалтерию можно было посчитать в уме и выписать РУКАМИ:
 * 2 × (110 − 100) = 20 валового минус две комиссии по 1 и funding 0.5 ⇒ 17.5.
 */
function baseRecord(overrides: Partial<ActorExecutionRecord> = {}): ActorExecutionRecord {
  const journal: ActorJournalEntry[] = [
    fillEntry('f1', 'o1', 0, 'buy', 2, 100, 1, { baseOpen: 99.9, slippageBps: 10, fillKind: 'open' }),
    fundingEntry(1, 0.5),
    fillEntry('f2', 'o2', 2, 'sell', 2, 110, 1, { baseOpen: 110.11, slippageBps: 10, fillKind: 'close' }),
  ];
  const record: ActorExecutionRecord = {
    actorId: ACTOR_ID,
    symbol: SYMBOL,
    subscriptions: SUBSCRIPTIONS,
    frontiers: FRONTIERS,
    orders: [
      { orderId: 'o1', placedAtFrontier: 0, side: 'long', intent: 'open', terminalState: 'filled' },
      { orderId: 'o2', placedAtFrontier: 2, side: 'long', intent: 'close', terminalState: 'filled' },
    ],
    journal,
    closes: [{ exitFillId: 'f2', closeReason: 'strategy_exit' }],
    equity: [
      { frontier: 0, equity: 999 },
      { frontier: 1, equity: 1005 },
      { frontier: 2, equity: 1017.5 },
    ],
    riskDecisions: [RISK],
    timeline: TIMELINE,
    finalLedger: foldAnchor(journal),
    ...overrides,
  };
  // Якорь пересчитывается ПОСЛЕ подстановок: проба, правящая журнал, иначе сверялась бы со старым
  // якорем и падала бы по неверной причине.
  return overrides.finalLedger !== undefined
    ? record
    : { ...record, finalLedger: foldAnchor(record.journal) };
}

const project = (overrides: Partial<ActorExecutionRecord> = {}): ActorRunArtifacts =>
  projectActorRun(baseRecord(overrides));

describe('отображение: семь семейств артефактов', () => {
  it('весь выход целиком — поле в поле', () => {
    expect(project()).toEqual({
      decisionRecords: [],
      orders: [
        { id: 'o1', decisionBarIndex: 0, side: 'long', intent: 'open', status: 'filled' },
        { id: 'o2', decisionBarIndex: 2, side: 'long', intent: 'close', status: 'filled' },
      ],
      fills: [
        {
          orderId: 'o1',
          fillBarIndex: 0,
          fillTs: T0,
          fillPrice: 100,
          baseOpen: 99.9,
          slippageBps: 10,
          feePaid: 1,
          size: 2,
          kind: 'open',
        },
        {
          orderId: 'o2',
          fillBarIndex: 2,
          fillTs: T0 + 2 * MINUTE,
          fillPrice: 110,
          baseOpen: 110.11,
          slippageBps: 10,
          feePaid: 1,
          size: 2,
          kind: 'close',
        },
      ],
      riskDecisions: [RISK],
      trades: [
        {
          // Имя по правилу legacy: не частичное, не защита, первое закрытие ⇒ «бедная» форма.
          id: 'trade-BTCUSDT-0-2',
          symbol: SYMBOL,
          side: 'long',
          entryBarIndex: 0,
          entryTs: T0,
          entryFillPrice: 100,
          exitBarIndex: 2,
          exitTs: T0 + 2 * MINUTE,
          exitFillPrice: 110,
          size: 2,
          feePaid: 2,
          fundingPaid: 0.5,
          realizedPnl: 17.5,
          closeReason: 'strategy_exit',
        },
      ],
      equityCurve: [
        { barIndex: 0, barTs: T0, equity: 999 },
        { barIndex: 1, barTs: T0 + MINUTE, equity: 1005 },
        { barIndex: 2, barTs: T0 + 2 * MINUTE, equity: 1017.5 },
      ],
      fundingLedger: [{ barIndex: 1, ts: T0 + MINUTE, rate: 0.0001, covered: true, cost: 0.5 }],
      validationIssues: [],
      timeline: TIMELINE_ROWS,
    } satisfies ActorRunArtifacts);
  });

  it('бухгалтерия сходится с посчитанной РУКАМИ, а не списанной с прогона', () => {
    // 2 × (110 − 100) = 20 валового; минус комиссия входа 1, комиссия выхода 1 и funding 0.5.
    expect(baseRecord().finalLedger.realizedPnl).toBe(17.5);
    expect(project().trades[0]!.realizedPnl).toBe(17.5);
  });

  it('необязательные ключи ОТСУТСТВУЮТ, а не равны undefined', () => {
    const journal: ActorJournalEntry[] = [
      fillEntry('f1', 'o1', 0, 'buy', 2, 100, 1),
      fillEntry('f2', 'o2', 2, 'sell', 2, 110, 1),
    ];
    const out = project({ journal, closes: [{ exitFillId: 'f2', closeReason: 'strategy_exit' }] });
    expect('kind' in out.fills[0]!).toBe(false);
    expect('mode' in out.orders[0]!).toBe(false);
    // funding не было ⇒ ключа нет; сделка не частичная и не защитная ⇒ closeSeq тоже нет.
    expect('fundingPaid' in out.trades[0]!).toBe(false);
    expect('closeSeq' in out.trades[0]!).toBe(false);
    expect('closeKind' in out.trades[0]!).toBe(false);
  });

  it('необязательные ключи ДОЕЗЖАЮТ, когда они есть', () => {
    // Проверка проверки: без неё «ключа нет» зеленело бы и у проекции, теряющей их всегда.
    const out = project({
      orders: [
        { orderId: 'o1', placedAtFrontier: 0, side: 'long', intent: 'add', terminalState: 'filled', mode: 'scale_in', origin: 'protection' },
        { orderId: 'o2', placedAtFrontier: 2, side: 'long', intent: 'close', terminalState: 'filled', closeFraction: 0.5 },
      ],
    });
    expect(out.orders[0]).toMatchObject({ intent: 'add', mode: 'scale_in', origin: 'protection' });
    expect(out.orders[1]).toMatchObject({ closeFraction: 0.5 });
  });
});

describe('сделки: считает движок, хост приносит только причину', () => {
  it('причина закрытия доезжает и включает «богатую» форму имени', () => {
    // Защитное закрытие — «богатое» по правилу legacy, поэтому имя получает суффикс закрытия.
    const out = project({ closes: [{ exitFillId: 'f2', closeReason: 'stop_hit' }] });
    expect(out.trades[0]).toMatchObject({
      id: 'trade-BTCUSDT-0-2-c0',
      closeReason: 'stop_hit',
      closeSeq: 0,
    });
  });

  it('частичный выход помечен и апорционирован', () => {
    // Вход 4, выход 1 ⇒ доля 0.25: комиссия входа 2 × 0.25 = 0.5, funding 0.8 × 0.25 = 0.2.
    // gross = 1 × (110 − 100) = 10 ⇒ 10 − 0.5 − 0.5 − 0.2 = 8.8.
    const journal: ActorJournalEntry[] = [
      fillEntry('f1', 'o1', 0, 'buy', 4, 100, 2),
      fundingEntry(1, 0.8),
      fillEntry('f2', 'o2', 2, 'sell', 1, 110, 0.5),
    ];
    const out = project({ journal, closes: [{ exitFillId: 'f2', closeReason: 'strategy_exit' }] });
    expect(out.trades[0]).toMatchObject({
      size: 1,
      feePaid: 1,
      fundingPaid: 0.2,
      realizedPnl: 8.8,
      closeKind: 'partial',
      closeSeq: 0,
    });
  });

  it('forced end-of-data: сделка синтетическая, а лишнего филла НЕ появляется', () => {
    // Legacy на forced EOD добавляет только сделку и не порождает ни заявки, ни исполнения
    // (`runner.ts`: acc.trades.push(forced)). Расхождение здесь означало бы, что один и тот же
    // прогон даёт разное число филлов в зависимости от lifecycle.
    const journal: ActorJournalEntry[] = [fillEntry('f1', 'o1', 0, 'buy', 2, 100, 1), fundingEntry(1, 0.5)];
    const out = project({
      journal,
      closes: [],
      orders: [{ orderId: 'o1', placedAtFrontier: 0, side: 'long', intent: 'open', terminalState: 'filled' }],
      forcedExit: { frontier: 2, price: 110 },
    });
    expect(out.fills).toHaveLength(1);
    expect(out.trades).toHaveLength(1);
    expect(out.trades[0]).toMatchObject({
      synthetic: 'end_of_data',
      closeReason: 'end_of_data',
      exitBarIndex: 2,
      exitTs: T0 + 2 * MINUTE,
      // 20 валового − 1 комиссии входа − 0 выхода (валюация без комиссии) − 0.5 funding.
      realizedPnl: 18.5,
    });
  });

  it('без forcedExit открытая позиция сделкой не становится', () => {
    const journal: ActorJournalEntry[] = [fillEntry('f1', 'o1', 0, 'buy', 2, 100, 1), fundingEntry(1, 0.5)];
    const out = project({
      journal,
      closes: [],
      orders: [{ orderId: 'o1', placedAtFrontier: 0, side: 'long', intent: 'open', terminalState: 'filled' }],
    });
    expect(out.trades).toEqual([]);
  });

  it('две последовательные эры: closeSeq у каждой свой, имена не расходятся с legacy', () => {
    // Полный выход, затем новый вход и снова полный выход. Глобальный счётчик закрытий дал бы
    // второй сделке `closeSeq: 1`, а с ним и суффикс `-c1` в имени — то есть переименовал бы
    // половину сделок прогона, не тронув ни одного числа.
    const journal: ActorJournalEntry[] = [
      fillEntry('f1', 'o1', 0, 'buy', 2, 100, 1),
      fillEntry('f2', 'o2', 1, 'sell', 2, 110, 1),
      fillEntry('f3', 'o3', 1, 'buy', 2, 100, 1),
      fillEntry('f4', 'o4', 2, 'sell', 2, 105, 1),
    ];
    const out = project({
      journal,
      orders: [
        { orderId: 'o1', placedAtFrontier: 0, side: 'long', intent: 'open', terminalState: 'filled' },
        { orderId: 'o2', placedAtFrontier: 1, side: 'long', intent: 'close', terminalState: 'filled' },
        { orderId: 'o3', placedAtFrontier: 1, side: 'long', intent: 'open', terminalState: 'filled' },
        { orderId: 'o4', placedAtFrontier: 2, side: 'long', intent: 'close', terminalState: 'filled' },
      ],
      closes: [
        { exitFillId: 'f2', closeReason: 'strategy_exit' },
        { exitFillId: 'f4', closeReason: 'strategy_exit' },
      ],
    });
    expect(out.trades.map((t) => t.id)).toEqual(['trade-BTCUSDT-0-1', 'trade-BTCUSDT-1-2']);
    expect(out.trades.every((t) => !('closeSeq' in t))).toBe(true);
  });

  it('две эры через ФЛИП — счётчик обнуляется и там', () => {
    const journal: ActorJournalEntry[] = [
      fillEntry('f1', 'o1', 0, 'buy', 2, 100, 1),
      fillEntry('f2', 'o2', 1, 'sell', 5, 110, 2),
      fillEntry('f3', 'o3', 2, 'buy', 3, 105, 1),
    ];
    const out = project({
      journal,
      orders: [
        { orderId: 'o1', placedAtFrontier: 0, side: 'long', intent: 'open', terminalState: 'filled' },
        { orderId: 'o2', placedAtFrontier: 1, side: 'short', intent: 'open', terminalState: 'filled' },
        { orderId: 'o3', placedAtFrontier: 2, side: 'short', intent: 'close', terminalState: 'filled' },
      ],
      closes: [
        { exitFillId: 'f2', closeReason: 'strategy_exit' },
        { exitFillId: 'f3', closeReason: 'strategy_exit' },
      ],
    });
    expect(out.trades.map((t) => [t.side, t.id])).toEqual([
      ['long', 'trade-BTCUSDT-0-1'],
      ['short', 'trade-BTCUSDT-1-2'],
    ]);
  });

  it('запрошенная доля доезжает до движка и меняет апорционирование', () => {
    // Пара СОГЛАСОВАННАЯ: `mul(2, 1/6)` = 0.3333333333333333 ровно, поэтому движок её принимает.
    // При накоплении 3 запрошенный путь даёт 0.5, восстановленный — 0.49999999999999994.
    // Доказательство проводки, а не арифметики: те же данные с долей и без дают разное число.
    const journal: ActorJournalEntry[] = [
      fillEntry('f1', 'o1', 0, 'buy', 2, 100, 3),
      fundingEntry(1, 3),
      fillEntry('f2', 'o2', 2, 'sell', 0.3333333333333333, 110, 1),
    ];
    const orders = baseRecord().orders;
    const withFraction = project({
      journal,
      orders,
      closes: [{ exitFillId: 'f2', closeReason: 'strategy_exit', closeFraction: 1 / 6 }],
    });
    const withoutFraction = project({
      journal,
      orders,
      closes: [{ exitFillId: 'f2', closeReason: 'strategy_exit' }],
    });
    expect(withFraction.trades[0]!.fundingPaid).toBe(0.5);
    expect(withoutFraction.trades[0]!.fundingPaid).toBe(0.49999999999999994);
  });

  it('противоречивая пара «доля против исполненного» отвергается через проекцию', () => {
    // Эра 4, исполнено 1, заявлено 0.5. Тождество сходимости этого НЕ ловит: сделка вычитает
    // `entryFeeClosed`, остаток эры ровно на него уменьшается, и в сумме члены сокращаются.
    // Числа прогона были бы верны в сумме и неверны в каждой своей части.
    const journal: ActorJournalEntry[] = [
      fillEntry('f1', 'o1', 0, 'buy', 4, 100, 2),
      fillEntry('f2', 'o2', 2, 'sell', 1, 110, 0.5),
    ];
    expect(() =>
      project({
        journal,
        orders: baseRecord().orders,
        closes: [{ exitFillId: 'f2', closeReason: 'strategy_exit', closeFraction: 0.5 }],
      }),
    ).toThrow(/что даёт 2, а исполнено 1/);
  });

  it('дубликат аннотации отвергается', () => {
    expect(() =>
      project({
        closes: [
          { exitFillId: 'f2', closeReason: 'stop_hit' },
          { exitFillId: 'f2', closeReason: 'take_hit' },
        ],
      }),
    ).toThrow(/задана дважды/);
  });

  it('аннотация на филл ВХОДА отвергается', () => {
    expect(() =>
      project({
        closes: [
          { exitFillId: 'f2', closeReason: 'strategy_exit' },
          { exitFillId: 'f1', closeReason: 'stop_hit' },
        ],
      }),
    ).toThrow(/не сработали ни разу: f1/);
  });

  it('отказ движка доезжает целиком, а не превращается в «проекция упала»', () => {
    // Причину закрытия знает только хост; движок отвергает закрывающий филл без аннотации.
    expect(() => project({ closes: [] })).toThrow(/нет аннотации причины/);
  });

  it('аннотация на несуществующий филл отвергается ЗДЕСЬ, а не превращается в чужой отказ', () => {
    // Иначе движок сообщил бы «нет аннотации у f2» — верно по факту и неверно по причине: аннотация
    // есть, она просто указывает в пустоту, и чинить надо её, а не добавлять вторую.
    expect(() => project({ closes: [{ exitFillId: 'нет-такого', closeReason: 'stop_hit' }] })).toThrow(
      /ссылается на незаписанный филл/,
    );
  });
});

describe('сужение состояний ордера до статуса артефакта', () => {
  const EXPECTED: readonly (readonly [OrderState, string, boolean])[] = [
    ['pending_new', 'pending', false],
    ['accepted', 'pending', false],
    ['partially_filled', 'pending', true],
    ['cancel_pending', 'pending', true],
    ['filled', 'filled', true],
    ['canceled', 'expired', true],
    ['rejected', 'expired', false],
  ];

  /** Одна заявка; филл — только если состояние его ждёт (иначе упрётся в соседний гейт). */
  function oneOrder(state: OrderState, withFill: boolean): ActorExecutionRecord {
    const journal: ActorJournalEntry[] = withFill ? [fillEntry('f1', 'o1', 0, 'buy', 1, 100, 0)] : [];
    return {
      actorId: ACTOR_ID,
      symbol: SYMBOL,
      subscriptions: SUBSCRIPTIONS,
      frontiers: [FRONTIERS[0]!],
      orders: [{ orderId: 'o1', placedAtFrontier: 0, side: 'long', intent: 'open', terminalState: state }],
      journal,
      closes: [],
      equity: [{ frontier: 0, equity: 1000 }],
      riskDecisions: [],
      timeline: [TIMELINE[0]!],
      finalLedger: foldAnchor(journal),
    };
  }

  it.each(EXPECTED)('%s → %s', (state, status, withFill) => {
    expect(projectActorRun(oneOrder(state, withFill)).orders[0]!.status).toBe(status);
  });

  it('таблица покрывает ровно те состояния, что есть у автомата', () => {
    expect(Object.keys(ORDER_STATUS_BY_STATE).sort()).toEqual([...EXPECTED.map(([s]) => s)].sort());
  });

  it('«отменена» и «отвергнута» СХЛОПЫВАЮТСЯ — потеря названа, а не скрыта', () => {
    expect(ORDER_STATUS_BY_STATE.canceled).toBe(ORDER_STATUS_BY_STATE.rejected);
  });
});

describe('порядок артефактов стабилен по построению', () => {
  it('выход идёт в порядке записи, а не отсортирован проекцией', () => {
    const journal: ActorJournalEntry[] = [
      fillEntry('zz', 'o1', 0, 'buy', 1, 100, 0),
      fillEntry('aa', 'o1', 0, 'buy', 1, 100, 0),
      fillEntry('f2', 'o2', 2, 'sell', 2, 110, 1),
    ];
    const out = project({ journal, closes: [{ exitFillId: 'f2', closeReason: 'strategy_exit' }] });
    expect(out.fills.map((f) => f.size)).toEqual([1, 1, 2]);
  });

  it('одинаковый вход → побайтово одинаковый выход', () => {
    expect(canonicalJson(project())).toBe(canonicalJson(project()));
  });

  it('проекция не мутирует запись', () => {
    const record = baseRecord();
    const before = canonicalJson(record);
    projectActorRun(record);
    expect(canonicalJson(record)).toBe(before);
  });
});

describe('отказ: запись, не сходящаяся сама с собой, отвергается целиком', () => {
  const rejects = (overrides: Partial<ActorExecutionRecord>, match: RegExp): void => {
    expect(() => project(overrides)).toThrow(ActorProjectionError);
    expect(() => project(overrides)).toThrow(match);
  };

  it('нет ни одного frontier’а', () => {
    rejects({ frontiers: [], equity: [], journal: [], orders: [], closes: [], timeline: [] }, /нет ни одного business-момента/);
  });

  it('номер frontier’а не совпадает с позицией', () => {
    rejects({ frontiers: [FRONTIERS[0]!, { ...FRONTIERS[1]!, index: 5 }, FRONTIERS[2]!] }, /не совпадает с позицией/);
  });

  it('business-время не возрастает', () => {
    rejects(
      { frontiers: [FRONTIERS[0]!, { ...FRONTIERS[1]!, tsUs: FRONTIERS[0]!.tsUs }, FRONTIERS[2]!] },
      /не возрастает/,
    );
  });

  it('lastCommittedSeq убывает — раннер переиграл события', () => {
    rejects(
      { frontiers: [FRONTIERS[0]!, { ...FRONTIERS[1]!, lastCommittedSeq: -1 }, FRONTIERS[2]!] },
      /lastCommittedSeq/,
    );
  });

  it('метка не кратна миллисекунде — перевод был бы с потерей', () => {
    const odd = { ...FRONTIERS[1]!, tsUs: (Number(FRONTIERS[1]!.tsUs) + 1) as never };
    rejects({ frontiers: [FRONTIERS[0]!, odd, FRONTIERS[2]!] }, /не кратна миллисекунде/);
  });

  it('ордер записан дважды', () => {
    rejects(
      {
        orders: [
          { orderId: 'o1', placedAtFrontier: 0, side: 'long', intent: 'open', terminalState: 'filled' },
          { orderId: 'o1', placedAtFrontier: 2, side: 'long', intent: 'close', terminalState: 'filled' },
        ],
      },
      /записан дважды/,
    );
  });

  it('филл ссылается на незаписанный ордер', () => {
    rejects(
      {
        orders: [{ orderId: 'o1', placedAtFrontier: 0, side: 'long', intent: 'open', terminalState: 'filled' }],
      },
      /незаписанный ордер o2/,
    );
  });

  it('метка записи журнала не равна business-времени своего frontier’а', () => {
    const journal = baseRecord().journal.slice();
    journal[2] = { ...(journal[2] as ActorJournalEntry), tsUs: FRONTIERS[1]!.tsUs } as ActorJournalEntry;
    rejects({ journal }, /не равна business-времени/);
  });

  it('точек equity меньше, чем баров', () => {
    rejects({ equity: baseRecord().equity.slice(0, 2) }, /завышает cagr\/calmar/);
  });

  it('точка equity относится к чужому бару', () => {
    const e = baseRecord().equity;
    rejects({ equity: [e[0]!, { frontier: 2, equity: 1 }, e[2]!] }, /относится к frontier 2/);
  });

  it('вердикт риска адресован несуществующему бару', () => {
    rejects({ riskDecisions: [{ ...RISK, barIndex: 7 }] }, /которого нет/);
  });

  it('записи журнала не в порядке исполнения', () => {
    const j = baseRecord().journal;
    rejects({ journal: [j[2]!, j[1]!, j[0]!] }, /порядок записи нарушен/);
  });
});

describe('состояние автомата обязано соответствовать наличию исполнений', () => {
  it('исполненный ордер без единого филла', () => {
    const journal = [baseRecord().journal[0]!, baseRecord().journal[1]!];
    expect(() => project({ journal, closes: [] })).toThrow(/исполнений у него нет/);
  });

  it('отвергнутый ордер с исполнением', () => {
    expect(() =>
      project({
        orders: [
          { orderId: 'o1', placedAtFrontier: 0, side: 'long', intent: 'open', terminalState: 'filled' },
          { orderId: 'o2', placedAtFrontier: 2, side: 'long', intent: 'close', terminalState: 'rejected' },
        ],
      }),
    ).toThrow(/но у него 1 исполнений/);
  });

  it('отмена ПОСЛЕ частичного исполнения — законный сценарий, не отказ', () => {
    expect(() =>
      project({
        orders: [
          { orderId: 'o1', placedAtFrontier: 0, side: 'long', intent: 'open', terminalState: 'filled' },
          { orderId: 'o2', placedAtFrontier: 2, side: 'long', intent: 'close', terminalState: 'canceled' },
        ],
      }),
    ).not.toThrow();
  });
});

describe('филлы якоря сверяются ПОЛНОСТЬЮ и ПО ПОРЯДКУ, а не по длине', () => {
  // Арифметика леджера не читает ни fillId, ни causedBy: подмена не двигает ни экспозицию, ни
  // avgPrice, ни realizedPnl — то есть проходила все скалярные проверки насквозь. При этом causedBy
  // и есть «fills by causation»: по нему `fillsCausedBy` отвечает, чем исполнена заявка.
  const withAnchorFills = (mutate: (fills: readonly Fill[]) => readonly Fill[]): ActorExecutionRecord => {
    const base = baseRecord();
    return { ...base, finalLedger: { ...base.finalLedger, fills: mutate(base.finalLedger.fills) } };
  };

  it('подменённый causedBy — бухгалтерия сходится, причинность лжёт', () => {
    const record = withAnchorFills((fills) => [fills[0]!, { ...fills[1]!, causedBy: 'o1' }]);
    // Сначала показываем, что подмена НЕ видна скалярам: позиция и PnL у якоря не тронуты.
    expect(record.finalLedger.qty).toBe(0);
    expect(record.finalLedger.realizedPnl).toBe(17.5);
    expect(() => projectActorRun(record)).toThrow(/fills\[1\]\.causedBy/);
  });

  it('подменённый fillId', () => {
    const record = withAnchorFills((fills) => [{ ...fills[0]!, fillId: 'подделка' }, fills[1]!]);
    expect(() => projectActorRun(record)).toThrow(/fills\[0\]\.fillId/);
  });

  it('переставленные филлы — та же сумма, другая история', () => {
    const record = withAnchorFills((fills) => [fills[1]!, fills[0]!]);
    expect(() => projectActorRun(record)).toThrow(/fills\[0\]\./);
  });

  it('подменённая комиссия одного филла при неизменных итогах', () => {
    const record = withAnchorFills((fills) => [{ ...fills[0]!, fee: 99 }, fills[1]!]);
    expect(() => projectActorRun(record)).toThrow(/fills\[0\]\.fee/);
  });

  it('лишний филл в якоре', () => {
    const record = withAnchorFills((fills) => [...fills, fills[1]!]);
    expect(() => projectActorRun(record)).toThrow(/филлов 2 против 3/);
  });

  it('потерянный филл: списки непротиворечивы, позиция расходится', () => {
    const base = baseRecord();
    const journal = [base.journal[0]!, base.journal[1]!];
    const record: ActorExecutionRecord = {
      ...base,
      journal,
      closes: [],
      orders: [
        { orderId: 'o1', placedAtFrontier: 0, side: 'long', intent: 'open', terminalState: 'filled' },
        { orderId: 'o2', placedAtFrontier: 2, side: 'long', intent: 'close', terminalState: 'canceled' },
      ],
    };
    expect(() => projectActorRun(record)).toThrow(/не сходится с finalLedger/);
  });

  it('ПРОВЕРКА ПРОВЕРКИ: нетронутая запись проходит', () => {
    expect(() => projectActorRun(baseRecord())).not.toThrow();
  });
});

describe('тождество «сделки ≡ леджер» — гейт репина', () => {
  // Изнутри проекции эта ветка недостижима: свёртка журнала уже сравнила realizedPnl с якорем,
  // поэтому к моменту сверки величины совпадают всегда — ЕСЛИ движок держит своё тождество.
  // Сработает она ровно тогда, когда его перестанут держать, то есть на подъёме пина. Поэтому
  // проверяется функция, а не подделанная фикстура: подделка проверяла бы ложь.
  it('расхождение отвергается и называет виновного', () => {
    expect(() => assertTradesReconcile(17.5, 17.4)).toThrow(ActorProjectionError);
    expect(() => assertTradesReconcile(17.5, 17.4)).toThrow(/деривация и его же леджер разъехались/);
  });

  it('совпадение проходит', () => {
    expect(() => assertTradesReconcile(17.5, 17.5)).not.toThrow();
  });
});

describe('успешный прогон без потока диспетчеризации невозможен', () => {
  it('пустой timeline отвергается ПРОЕКЦИЕЙ, а не отдельным вызовом', () => {
    // Гейт, который вызывающий может забыть позвать, ничего не гарантирует. Поэтому проверка стоит
    // внутри `projectActorRun`, а не рядом с ней.
    expect(() => project({ timeline: [] })).toThrow(/успешный actor-прогон без timeline/);
  });

  it('отказ приезжает СВОИМ классом — чинит его тот, кто пишет диспетчеризацию', () => {
    // `ActorProjectionError` означал бы «артефакты не сходятся» и отправил бы читателя не туда.
    expect(() => project({ timeline: [] })).toThrow(ActorTimelineError);
    expect(() => project({ timeline: [] })).not.toThrow(ActorProjectionError);
  });

  it('разрыв seq в потоке валит прогон целиком', () => {
    const gapped: ActorTimeline = [TIMELINE[0]!, TIMELINE[2]!];
    expect(() => project({ timeline: gapped })).toThrow(/разрыв seq/);
  });
});

describe('поток доживает до результата, а не только проходит проверку', () => {
  it('timeline выходит из проекции артефактной формой', () => {
    expect(project().timeline).toEqual(TIMELINE_ROWS);
  });

  it('и попадает в каноническую сериализацию результата', () => {
    // Проверка того, что раньше терялось молча: гарантия была, а данных — нет. Здесь поток обязан
    // присутствовать в тех же байтах, которыми сериализуется всё остальное.
    const bytes = canonicalJson(project());
    expect(bytes).toContain('"timeline"');
    expect(bytes).toContain('"market.candle.closed"');
    // И команда целиком, а не только её вид: `timer.set`/`annotate`/отвергнутые не восстанавливаются
    // ни из заявок, ни из журнала.
    expect(bytes).toContain('"qtyUsd"');
  });
});

describe('форма выхода совпадает с той, что собирает раннер', () => {
  it('поля ActorRunArtifacts и MergedAccumulators — один в один', () => {
    // Направления два, и они проверяют разное. Первое — что аккумуляторы ПОКРЫТЫ: забытое поле
    // здесь ошибка компиляции, а не пропуск на проводке. Второе — что «сверх» ровно `timeline`:
    // без него расхождение с аккумуляторами въехало бы сюда под видом расширения.
    type ArtifactKeys = keyof ActorRunArtifacts;
    type AccumulatorKeys = keyof MergedAccumulators;
    const _coversAccumulators: [AccumulatorKeys] extends [ArtifactKeys] ? true : never = true;
    const _onlyExtraIsTimeline: [Exclude<ArtifactKeys, AccumulatorKeys>] extends ['timeline']
      ? ['timeline'] extends [Exclude<ArtifactKeys, AccumulatorKeys>]
        ? true
        : never
      : never = true;
    expect(_coversAccumulators && _onlyExtraIsTimeline).toBe(true);

    expect(Object.keys(project()).sort()).toEqual(
      [
        'decisionRecords',
        'equityCurve',
        'fills',
        'fundingLedger',
        'orders',
        'riskDecisions',
        'trades',
        'validationIssues',
        'timeline',
      ].sort(),
    );
  });
});
