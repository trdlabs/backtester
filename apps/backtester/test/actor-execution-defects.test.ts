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
import { portfolioLimitUnsupported, unsupportedRiskRules } from '../src/engine/actor/production.js';
import { DCA_RISK, DEFAULT_RISK } from '../src/engine/profiles.js';
import { runEventDrivenSymbol } from '../src/engine/actor/run-symbol.js';
import type { ActorBar } from '../src/engine/actor/frontier-runner.js';
import type { ActorExecutionRecord } from '../src/engine/actor/execution-record.js';
import type {
  ActorExecutionHandle,
  ActorLifecycleExecutor,
} from '../src/engine/actor/execution-handle.js';
import type { ResolvedStrategy } from '../src/engine/artifacts.js';
import { riskBinding } from './helpers/actor-risk.js';

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
    // Лента этих проб — только свечи: агрегатов она не несёт, и допуск обязан это
    // увидеть, а не додумать. Значение явное, потому что дефолта у поля нет.
    carries: () => false,
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
    risk: riskBinding(10_000),
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
        // `reduceOnly` — потому что это ВЫХОД, и с риск-среза выходом считается только он:
        // непомеченная встречная заявка могла бы пересечь ноль и открыть противоположную позицию.
        // Предмет пробы — направление сдвига цены, и метка его не меняет.
        if (step === 3) return [place({ type: 'market', clientOrderId: 'out', side: 'sell', reduceOnly: true })];
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

describe('3. совместимость профиля с возможностями актора — whitelist, а не список запретов', () => {
  it('ПОДДЕРЖАННЫЙ профиль проходит: DEFAULT_RISK исполним в объявленной части', () => {
    // Главное утверждение среза. Раньше здесь проверялось обратное — что не проходит НИ ОДИН
    // профиль, — и это было верное описание системы без риск-контура.
    //
    // «В объявленной части», а не «целиком»: `stopBounds`/`takeBounds` профиль объявляет, а
    // actor-путь их не применяет — у сырой заявки защитных хинтов нет. Прогон это не блокирует
    // (ослаблять нечего), но и полной поддержки профиля путь не заявляет — см. applicability
    // matrix дизайна.
    expect(unsupportedRiskRules(DEFAULT_RISK as never)).toEqual([]);
  });

  it('РАЗРЕШЁННЫЙ ПРОФИЛЕМ ДОЛИВ не исполним и потому отвергается', () => {
    // Предмет у правила ЕСТЬ (`intentOf` отличает наращивание), а исполнения нет: режим `dca`
    // против `scale_in` командой не сообщается. Исполнить молча значило бы разрешить долив под
    // профилем, который его лимитирует.
    expect(unsupportedRiskRules(DCA_RISK as never)).toEqual(['dcaLimits', 'scaleInLimits']);
  });

  it('НЕЗНАКОМОЕ правило останавливает прогон — профиль не только DEFAULT_RISK навсегда', () => {
    // Whitelist ловит то, чего этот код никогда не видел. Blacklist пропустил бы каждое правило,
    // которого мы сегодня не предвидели, — то есть ровно те, что придут с пользовательскими
    // профилями.
    expect(
      unsupportedRiskRules({ id: 'r', version: '1', maxDailyLossPct: 5 } as never),
    ).toEqual(['maxDailyLossPct']);
  });

  it('stopBounds/takeBounds НЕ блокируют: у них нет предмета, а не «мы их игнорируем»', () => {
    // Разница существенна и записана applicability matrix'ей: у сырой заявки актора защитных
    // хинтов нет вовсе, поэтому их неклампирование ничего не ослабляет. Выводить protection из
    // `stop_market` или `avgPrice` запрещено решением владельца.
    expect(unsupportedRiskRules({ id: 'r', version: '1', stopBounds: {}, takeBounds: {} })).toEqual([]);
  });

  it('объявленный exposureLimits без своего числа — это лимит, который не с чем сравнить', () => {
    // Трактовать его как «потолка нет» значило бы исполнить прогон свободнее, чем просил профиль.
    expect(unsupportedRiskRules({ id: 'r', version: '1', exposureLimits: {} })).toEqual([
      'exposureLimits.maxPositionNotionalPct=undefined',
    ]);
  });

  it('NaN/Infinity в потолке НЕ проходят: сравнение с ними ложно, и лимит выключается молча', () => {
    // Самый тихий из всех отказов контроля. `typeof NaN === 'number'`, профиль выглядит строгим, а
    // каждое сравнение с ним ложно — прогон идёт БЕЗ потолка и отдаёт числа, выглядящие как
    // результат стратегии под лимитом. Проверка имён такое не ловит по построению: имя-то знакомое.
    expect(unsupportedRiskRules({ id: 'r', version: '1', exposureLimits: { maxPositionNotionalPct: Number.NaN } })).toEqual([
      'exposureLimits.maxPositionNotionalPct=NaN',
    ]);
    expect(
      unsupportedRiskRules({ id: 'r', version: '1', exposureLimits: { maxPositionNotionalPct: Number.POSITIVE_INFINITY } }),
    ).toEqual(['exposureLimits.maxPositionNotionalPct=Infinity']);
  });

  it('нулевой и отрицательный потолок отвергаются на входе, а не отказом каждой заявке', () => {
    expect(unsupportedRiskRules({ id: 'r', version: '1', exposureLimits: { maxPositionNotionalPct: 0 } })).toEqual([
      'exposureLimits.maxPositionNotionalPct=0 (должен быть > 0)',
    ]);
  });

  it('ВЛОЖЕННОЕ незнакомое правило отвергается так же, как верхнеуровневое', () => {
    // Whitelist, проверяющий только верхний уровень, пропустил бы объявленное плечо: ключ
    // `exposureLimits` знаком, а что внутри — никто не смотрел.
    expect(
      unsupportedRiskRules({
        id: 'r',
        version: '1',
        exposureLimits: { maxPositionNotionalPct: 1, maxLeverage: 10 } as never,
      }),
    ).toEqual(['exposureLimits.maxLeverage']);
  });

  it('maxConcurrentPositions обязан быть целым неотрицательным', () => {
    expect(unsupportedRiskRules({ id: 'r', version: '1', maxConcurrentPositions: 1.5 })).toEqual([
      'maxConcurrentPositions=1.5',
    ]);
    expect(unsupportedRiskRules({ id: 'r', version: '1', maxConcurrentPositions: -1 })).toEqual([
      'maxConcurrentPositions=-1',
    ]);
    expect(unsupportedRiskRules({ id: 'r', version: '1', maxConcurrentPositions: Number.NaN })).toEqual([
      'maxConcurrentPositions=NaN',
    ]);
  });

  it('allowedSides — ENUM, а не произвольные строки', () => {
    // `['both']` не совпало бы ни с одной результирующей стороной и отвергало бы КАЖДОЕ открытие —
    // поведение, неотличимое от «профиль запрещает торговать», хотя автор имел в виду обратное.
    expect(unsupportedRiskRules({ id: 'r', version: '1', allowedSides: ['both'] })).toEqual([
      'allowedSides[]=both',
    ]);
    expect(unsupportedRiskRules({ id: 'r', version: '1', allowedSides: [] })).toEqual(['allowedSides=[]']);
  });

  it('ПРОВЕРКА ПРОВЕРКИ: годные значения проходят', () => {
    // Иначе набор выше зеленел бы и у функции, отвергающей вообще всё.
    expect(
      unsupportedRiskRules({
        id: 'r',
        version: '1',
        maxConcurrentPositions: 0,
        exposureLimits: { maxPositionNotionalPct: 0.25 },
        allowedSides: ['long', 'short'],
      }),
    ).toEqual([]);
  });

  it('portfolio-wide лимит против нескольких акторов не применяется per-actor', () => {
    // Per-actor трактовка тихо превратила бы «1 позиция на портфель» в «до N позиций».
    expect(portfolioLimitUnsupported(DEFAULT_RISK as never, 1)).toBe(false);
    expect(portfolioLimitUnsupported(DEFAULT_RISK as never, 2)).toBe(true);
    // Проверка проверки: дело в ЛИМИТЕ, а не в числе акторов самом по себе.
    expect(portfolioLimitUnsupported({ id: 'r', version: '1' }, 2)).toBe(false);
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
