// ГЕЙТ: проекция «actor execution record → артефакты» отображает и ПРОВЕРЯЕТ.
//
// Три группы утверждений, и они доказывают разное:
//
//   1. ОТОБРАЖЕНИЕ — каждое из семи семейств артефактов получает то, что должно, поле в поле.
//      Проверяется целым выходом, а не по одному полю: сравнение полного объекта валится и на
//      забытом ключе, и на лишнем, тогда как поштучные `expect` ловят только то, что перечислено.
//   2. ПОРЯДОК — выход идёт в порядке записи, одинаковый вход даёт побайтово одинаковый выход.
//   3. ОТКАЗ — запись, которая не сходится сама с собой, отвергается ЦЕЛИКОМ. Это главная группа:
//      перекладывание полей ошибиться почти не может, а раннер, потерявший факт, — может, и делает
//      это молча.
//
// ═══ ПОЧЕМУ ЯКОРЬ ЛЕДЖЕРА ПРОВЕРЯЕТСЯ ОТРИЦАТЕЛЬНО ═══
//
// Фикстура собирает `finalLedger` тем же движковым `applyFill`, которым сворачивает проекция. Само
// по себе совпадение поэтому не пиннит НИЧЕГО про правильность свёртки — оно пиннит только
// проводку: что проекция сворачивает именно записанные филлы. Урок уже оплачен однажды: оракул,
// выведенный из реализации, согласен с ней по построению.
//
// Работу делают отрицательные пробы: выбросить филл, подменить размер, переставить два. Каждая —
// точный портрет дефекта раннера, ради обнаружения которого якорь и заведён.

import { describe, expect, it } from 'vitest';
import { EMPTY_LEDGER, applyFill, applyFunding } from '@trdlabs/engine';
import type { Ledger, OrderState, RiskDecision, Trade } from '@trdlabs/engine';
import { timestampUsFromMillis } from '@trdlabs/sdk/research-contract';

import { canonicalJson } from '../src/determinism/canonical-json.js';
import { ledgerFillOf } from '../src/engine/actor/execution-record.js';
import type {
  ActorExecutionRecord,
  ActorFillRecord,
  ActorFrontierRecord,
} from '../src/engine/actor/execution-record.js';
import {
  ActorProjectionError,
  ORDER_STATUS_BY_STATE,
  projectActorRun,
} from '../src/engine/actor/projection.js';
import type { ActorRunArtifacts } from '../src/engine/actor/projection.js';
import type { MergedAccumulators } from '../src/engine/runner.js';

const SYMBOL = 'BTCUSDT';
const T0 = 1_700_000_000_000; // мс, минутная сетка
const MINUTE = 60_000;

const frontier = (index: number, lastCommittedSeq: number): ActorFrontierRecord => ({
  index,
  tsUs: timestampUsFromMillis(T0 + index * MINUTE),
  lastCommittedSeq,
});

/** Свернуть филлы и funding ровно тем порядком, который фиксирует проекция: филлы, затем funding. */
function foldAnchor(record: Omit<ActorExecutionRecord, 'finalLedger'>): Ledger {
  let ledger: Ledger = EMPTY_LEDGER;
  for (const f of record.frontiers) {
    for (const fill of record.fills) {
      if (fill.frontier === f.index) ledger = applyFill(ledger, ledgerFillOf(fill));
    }
    for (const fund of record.funding) {
      if (fund.frontier === f.index) {
        ledger = applyFunding(ledger, { tsUs: fund.tsUs, cost: fund.cost });
      }
    }
  }
  return ledger;
}

const TRADE: Trade = {
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
  realizedPnl: 18,
  closeReason: 'strategy_exit',
};

const RISK: RiskDecision = {
  barIndex: 0,
  decisionKind: 'open_long',
  action: 'accept',
  reason: 'within limits',
};

/**
 * Базовая запись: вход 2 @ 100 на баре 0, выход 2 @ 110 на баре 2, один funding-расчёт на баре 1.
 *
 * Числа подобраны так, чтобы бухгалтерию можно было посчитать в уме и записать РУКАМИ (см. тест
 * ниже), а не списать с прогона: 20 валового минус две комиссии по 1 минус funding 0.5.
 */
function baseRecord(): ActorExecutionRecord {
  const frontiers = [frontier(0, 3), frontier(1, 5), frontier(2, 9)];
  const fills: ActorFillRecord[] = [
    {
      fillId: 'f1',
      orderId: 'o1',
      frontier: 0,
      tsUs: frontiers[0]!.tsUs,
      price: 100,
      baseOpen: 99.9,
      slippageBps: 10,
      qty: 2,
      fee: 1,
      side: 'buy',
      kind: 'open',
    },
    {
      fillId: 'f2',
      orderId: 'o2',
      frontier: 2,
      tsUs: frontiers[2]!.tsUs,
      price: 110,
      baseOpen: 110.11,
      slippageBps: 10,
      qty: 2,
      fee: 1,
      side: 'sell',
      kind: 'close',
    },
  ];
  const withoutAnchor = {
    symbol: SYMBOL,
    frontiers,
    orders: [
      { orderId: 'o1', placedAtFrontier: 0, side: 'long' as const, intent: 'open' as const, terminalState: 'filled' as OrderState },
      { orderId: 'o2', placedAtFrontier: 2, side: 'long' as const, intent: 'close' as const, terminalState: 'filled' as OrderState },
    ],
    fills,
    funding: [
      { frontier: 1, tsUs: frontiers[1]!.tsUs, rate: 0.0001, covered: true, cost: 0.5 },
    ],
    equity: [
      { frontier: 0, equity: 999 },
      { frontier: 1, equity: 1005 },
      { frontier: 2, equity: 1017.5 },
    ],
    riskDecisions: [RISK],
    trades: [TRADE],
  };
  return { ...withoutAnchor, finalLedger: foldAnchor(withoutAnchor) };
}

/** Спроецировать запись, собранную из базовой правкой одного места. */
const project = (patch: Partial<ActorExecutionRecord> = {}): ActorRunArtifacts =>
  projectActorRun({ ...baseRecord(), ...patch });

describe('отображение: семь семейств артефактов', () => {
  it('весь выход целиком — поле в поле', () => {
    // Сравнение ПОЛНЫМ объектом: забытый ключ обвалит его так же, как лишний. Поштучные проверки
    // ловили бы только перечисленное, а перечислять забывают ровно то, что потом и ломается.
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
      trades: [TRADE],
      equityCurve: [
        { barIndex: 0, barTs: T0, equity: 999 },
        { barIndex: 1, barTs: T0 + MINUTE, equity: 1005 },
        { barIndex: 2, barTs: T0 + 2 * MINUTE, equity: 1017.5 },
      ],
      fundingLedger: [
        { barIndex: 1, ts: T0 + MINUTE, rate: 0.0001, covered: true, cost: 0.5 },
      ],
      validationIssues: [],
    } satisfies ActorRunArtifacts);
  });

  it('бухгалтерия сходится с посчитанной РУКАМИ, а не списанной с прогона', () => {
    // 2 × (110 − 100) = 20 валового; минус комиссия входа 1, комиссия выхода 1 и funding 0.5.
    // Величина выписана здесь, а не взята у свёртки: оракул, выведенный из реализации, согласен
    // с ней по построению и не пиннит ничего.
    const anchor = baseRecord().finalLedger;
    expect(anchor.realizedPnl).toBe(17.5);
    expect(anchor.qty).toBe(0);
    expect(anchor.openedAtUs).toBeNull();
  });

  it('необязательные ключи ОТСУТСТВУЮТ, а не равны undefined', () => {
    // Идиома байт-идентичности: `canonicalJson` отбрасывает `undefined`, но только если ключа нет.
    // Ключ со значением `undefined` в объекте — это уже другой объект для `toEqual`, и на пути
    // сериализации разница проявляется не всегда, то есть тем опаснее.
    const base = baseRecord();
    const [order] = project({
      orders: [{ ...base.orders[0]!, mode: undefined, closeFraction: undefined, origin: undefined }, base.orders[1]!],
    }).orders;
    expect('mode' in order!).toBe(false);
    expect('closeFraction' in order!).toBe(false);
    expect('origin' in order!).toBe(false);

    const fillWithoutKind = { ...base.fills[0]! };
    delete (fillWithoutKind as { kind?: unknown }).kind;
    const [fill] = project({ fills: [fillWithoutKind, base.fills[1]!] }).fills;
    expect('kind' in fill!).toBe(false);
  });

  it('необязательные ключи ДОЕЗЖАЮТ, когда они есть', () => {
    // Проверка проверки к предыдущему тесту: без неё «ключа нет» зеленело бы и у проекции, которая
    // теряет эти ключи всегда.
    const base = baseRecord();
    const [order] = project({
      orders: [
        { ...base.orders[0]!, intent: 'add', mode: 'scale_in', origin: 'protection' },
        base.orders[1]!,
      ],
    }).orders;
    expect(order).toMatchObject({ intent: 'add', mode: 'scale_in', origin: 'protection' });
  });
});

describe('сужение состояний ордера до статуса артефакта', () => {
  // Таблица выписана СПИСКОМ, а не выведена из `ORDER_STATUS_BY_STATE`: сверять таблицу с самой
  // собой бессмысленно. Здесь зафиксировано ожидаемое сужение, включая лосси-часть. Третий столбец
  // — ждёт ли состояние исполнений: без него половина строк упёрлась бы в соседний гейт
  // (`accepted` с филлом отвергается) и проверяла бы не сужение, а его.
  const EXPECTED: readonly (readonly [OrderState, string, boolean])[] = [
    ['pending_new', 'pending', false],
    ['accepted', 'pending', false],
    ['partially_filled', 'pending', true],
    ['cancel_pending', 'pending', true],
    ['filled', 'filled', true],
    ['canceled', 'expired', true],
    ['rejected', 'expired', false],
  ];

  /** Минимальная запись под одно состояние: один ордер, филл — только если состояние его ждёт. */
  function oneOrder(state: OrderState, withFill: boolean): ActorExecutionRecord {
    const frontiers = [frontier(0, 1)];
    const fills: ActorFillRecord[] = withFill
      ? [
          {
            fillId: 'f1',
            orderId: 'o1',
            frontier: 0,
            tsUs: frontiers[0]!.tsUs,
            price: 100,
            baseOpen: 100,
            slippageBps: 0,
            qty: 1,
            fee: 0,
            side: 'buy',
          },
        ]
      : [];
    const withoutAnchor = {
      symbol: SYMBOL,
      frontiers,
      orders: [
        { orderId: 'o1', placedAtFrontier: 0, side: 'long' as const, intent: 'open' as const, terminalState: state },
      ],
      fills,
      funding: [],
      equity: [{ frontier: 0, equity: 1000 }],
      riskDecisions: [],
      trades: [],
    };
    return { ...withoutAnchor, finalLedger: foldAnchor(withoutAnchor) };
  }

  it.each(EXPECTED)('%s → %s', (state, status, withFill) => {
    expect(projectActorRun(oneOrder(state, withFill)).orders[0]!.status).toBe(status);
  });

  it('таблица покрывает ровно те состояния, что есть у автомата', () => {
    expect(Object.keys(ORDER_STATUS_BY_STATE).sort()).toEqual([...EXPECTED.map(([s]) => s)].sort());
  });

  it('«отменена» и «отвергнута» СХЛОПЫВАЮТСЯ — потеря названа, а не скрыта', () => {
    // Артефакт различает только «не исполнилась»; исходное состояние остаётся в записи, и когда
    // различие понадобится, расширять придётся артефакт.
    expect(ORDER_STATUS_BY_STATE.canceled).toBe(ORDER_STATUS_BY_STATE.rejected);
  });
});

describe('порядок артефактов стабилен по построению', () => {
  it('выход идёт в порядке записи, а не отсортирован проекцией', () => {
    // Существенно: пересортировка скрыла бы раннер, пишущий не в том порядке. Здесь два филла
    // одного frontier'а записаны в обратном алфавитном порядке id — проекция обязана их сохранить.
    const base = baseRecord();
    const twoAtOnce: ActorFillRecord[] = [
      { ...base.fills[0]!, fillId: 'zz', qty: 1 },
      { ...base.fills[0]!, fillId: 'aa', qty: 1 },
      base.fills[1]!,
    ];
    const record = { ...base, fills: twoAtOnce };
    const projected = projectActorRun({ ...record, finalLedger: foldAnchor(record) });
    expect(projected.fills.map((f) => f.orderId)).toEqual(['o1', 'o1', 'o2']);
    expect(projected.fills.map((f) => f.size)).toEqual([1, 1, 2]);
  });

  it('одинаковый вход → побайтово одинаковый выход', () => {
    expect(canonicalJson(project())).toBe(canonicalJson(project()));
  });

  it('проекция не мутирует запись', () => {
    // Чистота — заявленное свойство слоя, и стоит она ровно одного сравнения.
    const record = baseRecord();
    const before = canonicalJson(record);
    projectActorRun(record);
    expect(canonicalJson(record)).toBe(before);
  });
});

describe('отказ: запись, не сходящаяся сама с собой, отвергается целиком', () => {
  const rejects = (patch: Partial<ActorExecutionRecord>, match: RegExp): void => {
    expect(() => project(patch)).toThrow(ActorProjectionError);
    expect(() => project(patch)).toThrow(match);
  };

  it('нет ни одного frontier’а', () => {
    rejects({ frontiers: [], equity: [] }, /нет ни одного business-момента/);
  });

  it('номер frontier’а не совпадает с позицией', () => {
    const f = baseRecord().frontiers;
    rejects({ frontiers: [f[0]!, { ...f[1]!, index: 5 }, f[2]!] }, /не совпадает с позицией/);
  });

  it('business-время не возрастает', () => {
    const f = baseRecord().frontiers;
    rejects({ frontiers: [f[0]!, { ...f[1]!, tsUs: f[0]!.tsUs }, f[2]!] }, /не возрастает/);
  });

  it('lastCommittedSeq убывает — раннер переиграл или потерял события', () => {
    const f = baseRecord().frontiers;
    rejects({ frontiers: [f[0]!, { ...f[1]!, lastCommittedSeq: 1 }, f[2]!] }, /lastCommittedSeq/);
  });

  it('метка не кратна миллисекунде — перевод был бы с потерей', () => {
    const f = baseRecord().frontiers;
    const odd = { ...f[1]!, tsUs: ((Number(f[1]!.tsUs) + 1) as unknown) as typeof f[1]['tsUs'] };
    rejects({ frontiers: [f[0]!, odd, f[2]!] }, /не кратна миллисекунде/);
  });

  it('ордер записан дважды', () => {
    const o = baseRecord().orders;
    rejects({ orders: [o[0]!, { ...o[1]!, orderId: 'o1' }] }, /записан дважды/);
  });

  it('филл ссылается на незаписанный ордер', () => {
    const base = baseRecord();
    rejects({ orders: [base.orders[0]!] }, /незаписанный ордер o2/);
  });

  it('метка филла не равна business-времени своего frontier’а', () => {
    const base = baseRecord();
    rejects(
      { fills: [base.fills[0]!, { ...base.fills[1]!, tsUs: base.frontiers[1]!.tsUs }] },
      /не равна business-времени/,
    );
  });

  it('точек equity меньше, чем баров', () => {
    const base = baseRecord();
    rejects({ equity: base.equity.slice(0, 2) }, /завышает cagr\/calmar/);
  });

  it('точка equity относится к чужому бару', () => {
    const base = baseRecord();
    rejects(
      { equity: [base.equity[0]!, { frontier: 2, equity: 1 }, base.equity[2]!] },
      /относится к frontier 2/,
    );
  });

  it('вердикт риска адресован несуществующему бару', () => {
    rejects({ riskDecisions: [{ ...RISK, barIndex: 7 }] }, /которого нет/);
  });

  it('сделка чужого символа', () => {
    rejects({ trades: [{ ...TRADE, symbol: 'ETHUSDT' }] }, /не совпадает с символом прогона/);
  });

  it('выход сделки раньше входа', () => {
    rejects({ trades: [{ ...TRADE, entryBarIndex: 2, exitBarIndex: 0 }] }, /раньше входа/);
  });

  it('филлы записаны не в порядке исполнения', () => {
    const base = baseRecord();
    // Тот же набор, переставленный: каждый филл по отдельности валиден, и валится ТОЛЬКО порядок.
    rejects({ fills: [base.fills[1]!, base.fills[0]!] }, /порядок записи нарушен/);
  });

  it('метки сделки не совпадают с её барами', () => {
    // Сделка — единственный артефакт, приходящий собранным: у неё есть И номер бара, И метка,
    // то есть два способа сказать одно. Кривая equity берёт метку у оси и разойтись не может.
    rejects({ trades: [{ ...TRADE, exitTs: TRADE.exitTs + 1 }] }, /не совпадают с барами/);
  });
});

describe('состояние автомата обязано соответствовать наличию исполнений', () => {
  // Рассинхрон двух половин записи. Раннер, записавший филл и не продвинувший FSM, отдаёт заявку,
  // которую артефакт объявит неисполненной, — при уже поехавшей позиции.
  const base = baseRecord();

  it('исполненный ордер без единого филла', () => {
    // `o2` остаётся `filled`, но его филл выброшен. Проверка обязана сработать РАНЬШЕ якоря
    // леджера — она называет причину адресно («у этой заявки нет исполнений»), тогда как якорь
    // скажет лишь «позиция не сходится», и чинить придётся с начала.
    expect(() => projectActorRun({ ...base, fills: [base.fills[0]!] })).toThrow(
      /исполнений у него нет/,
    );
  });

  it('отвергнутый ордер с исполнением', () => {
    const orders = [base.orders[0]!, { ...base.orders[1]!, terminalState: 'rejected' as OrderState }];
    expect(() => projectActorRun({ ...base, orders })).toThrow(/но у него 1 исполнений/);
  });

  it('отмена ПОСЛЕ частичного исполнения — законный сценарий, не отказ', () => {
    // Проверка проверки: без неё правило зеленело бы и в виде «у любого нетерминального состояния
    // филлов быть не должно», запретив штатную отмену остатка.
    const orders = [base.orders[0]!, { ...base.orders[1]!, terminalState: 'canceled' as OrderState }];
    expect(() => projectActorRun({ ...base, orders })).not.toThrow();
  });
});

describe('якорь леджера ловит потерянный факт — то, ради чего он и заведён', () => {
  it('потерянный филл: списки остаются непротиворечивыми, позиция расходится', () => {
    // Точный портрет дефекта раннера: отмену заявки записал, а её исполнение потерял. Ордера на
    // месте, кривая equity непрерывна, сделка закрыта — всё выглядит целым, и соседние гейты молчат
    // (`canceled` вправе не иметь филлов). Не сходится только бухгалтерия: позиция осталась
    // открытой. Поймать это больше негде.
    const base = baseRecord();
    const orders = [base.orders[0]!, { ...base.orders[1]!, terminalState: 'canceled' as OrderState }];
    expect(() => projectActorRun({ ...base, orders, fills: [base.fills[0]!] })).toThrow(
      /не сходится с finalLedger/,
    );
  });

  it('подменённый размер филла', () => {
    const base = baseRecord();
    const fills = [base.fills[0]!, { ...base.fills[1]!, qty: 1 }];
    expect(() => projectActorRun({ ...base, fills })).toThrow(/не сходится с finalLedger/);
  });

  it('пропущенный funding-расчёт', () => {
    const base = baseRecord();
    expect(() => projectActorRun({ ...base, funding: [] })).toThrow(/realizedPnl/);
  });

  it('ПРОВЕРКА ПРОВЕРКИ: нетронутая запись проходит', () => {
    // Без неё все три пробы выше зеленели бы и у якоря, который отвергает что угодно.
    expect(() => projectActorRun(baseRecord())).not.toThrow();
  });
});

describe('форма выхода совпадает с той, что собирает раннер', () => {
  it('поля ActorRunArtifacts и MergedAccumulators — один в один', () => {
    // Проверка на уровне ТИПОВ: конечную сборку (`summary`, метрики, evidence) обязан выполнять тот
    // же `assembleResult`, что и на legacy-пути, иначе у actor-пути заведётся второй владелец формы
    // результата. Забытое поле здесь — ошибка компиляции, а не пропуск на проводке.
    type ArtifactKeys = keyof ActorRunArtifacts;
    type AccumulatorKeys = keyof MergedAccumulators;
    const _sameKeys: [ArtifactKeys] extends [AccumulatorKeys]
      ? [AccumulatorKeys] extends [ArtifactKeys]
        ? true
        : never
      : never = true;
    expect(_sameKeys).toBe(true);

    // И на уровне значений: набор ключей выхода совпадает с объявленным.
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
      ].sort(),
    );
  });
});
