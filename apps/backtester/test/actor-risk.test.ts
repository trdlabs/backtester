// 083 S3 — риск-контур actor-пути под НАСТОЯЩИМ `default_risk@1.0.0`.
//
// Профиль здесь не сконструирован тестом: это тот же объект, что стоит в
// `TRUSTED_REGISTRY_DEFINITION`. Проба на самодельном профиле доказывала бы семантику на
// конфигурации, недостижимой в проде, — ровно тот долг, который срез закрывает.
//
// ЧТО ЗНАЧИТ `DEFAULT_RISK` НА ЯЗЫКЕ ЗАЯВОК. Профиль объявляет `maxConcurrentPositions: 1`,
// `maxPositionNotionalPct: 1.0`, обе стороны и границы защиты. У актора это разворачивается так:
// открыть позицию можно, сокращать и закрывать можно, УВЕЛИЧИВАТЬ открытую — нельзя (add-лимитов
// профиль не объявляет), а размер открытия урезается потолком экспозиции.
//
// Границы защиты (`stopBounds`/`takeBounds`) не применяются: у сырой заявки защитных хинтов нет
// вовсе. Это записано applicability matrix'ей дизайна и проверяется в `actor-execution-defects`
// (блок 3), а не подразумевается здесь.

import { describe, expect, it } from 'vitest';
import { CONTRACT_VERSION } from '@trading/research-contracts/research';
import type { ActorCommand, ActorInputEvent, MarketDataRequirement } from '@trdlabs/sdk/research-contract';
import { timestampUsFromMillis } from '@trdlabs/sdk/research-contract';

import { admitActorMarketData, proveCandleVenue } from '../src/engine/actor/admission.js';
import { runEventDrivenSymbol } from '../src/engine/actor/run-symbol.js';
import type { ActorBar } from '../src/engine/actor/frontier-runner.js';
import type { ActorExecutionRecord } from '../src/engine/actor/execution-record.js';
import type {
  ActorExecutionHandle,
  ActorLifecycleExecutor,
} from '../src/engine/actor/execution-handle.js';
import type { ResolvedStrategy } from '../src/engine/artifacts.js';
import { evaluateActorPlace, formatRiskRefusal, parseRiskRefusal } from '../src/engine/actor/risk.js';
import { ACTOR_DEFAULT_RISK } from './helpers/actor-risk.js';

const MINUTE_MS = 60_000;
const MINUTE_US = 60_000_000;
const T0 = 1_700_000_000_000;
const EQUITY = 10_000;

const bars = (n: number): readonly ActorBar[] =>
  Array.from({ length: n }, (_, i) => ({
    tsUs: timestampUsFromMillis(T0 + i * MINUTE_MS),
    open: 100,
    high: 105,
    low: 95,
    close: 100,
  }));

const strategy = (): ResolvedStrategy =>
  ({
    manifest: {
      id: 'actor-risk-probe',
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

/** Прогон под ПРОИЗВОЛЬНЫМ профилем — по умолчанию под настоящим `DEFAULT_RISK`. */
async function run(
  script: (event: ActorInputEvent, barSeen: number) => readonly ActorCommand[],
  profile = ACTOR_DEFAULT_RISK,
  barCount = 6,
  feeBps = 0,
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
  const tape = bars(barCount);
  const admission = admitActorMarketData(strategy(), {
    candleVenue: proveCandleVenue({ datasetRef: 'actor-risk', candleVenue: 'bybit' }),
    symbol: 'BTCUSDT',
    barIntervalUs: MINUTE_US,
    barCount: tape.length,
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
    bars: tape,
    costs: { feeBps, slippageBps: 0, initialEquity: EQUITY },
    risk: { profile, initialEquity: EQUITY },
  });
}

const place = (over: Record<string, unknown>): ActorCommand =>
  ({ kind: 'place', type: 'market', side: 'buy', qtyUsd: 1000, ...over }) as unknown as ActorCommand;

/** Все исходы команд `place` по всему прогону, в причинном порядке. */
const placeOutcomes = (record: ActorExecutionRecord): readonly string[] =>
  record.timeline
    .flatMap((e) => e.commands)
    .filter((c) => c.command.kind === 'place')
    .map((c) => c.outcome.status);

describe('увеличение открытой позиции запрещено профилем', () => {
  it('вторая заявка в ту же сторону отклоняется риском', async () => {
    // Главное содержательное правило `DEFAULT_RISK` на actor-языке. Первая заявка открывает
    // позицию (bar 1 → филл на bar 2), вторая приходит уже при открытой и НАРАЩИВАЕТ её.
    const record = await run((event, bar) =>
      event.kind === 'market.candle.closed' && (bar === 1 || bar === 3)
        ? [place({ clientOrderId: `o${bar}` })]
        : [],
    );

    expect(placeOutcomes(record)).toEqual(['applied', 'rejected']);
    expect(record.riskDecisions).toEqual([
      { barIndex: 2, decisionKind: 'place', action: 'reject', reason: 'add_not_permitted' },
    ]);
  });

  it('РАЗЛИЧАЮЩИЙ СЛУЧАЙ: та же заявка при flat — это открытие, и она проходит', async () => {
    // Без этой пробы утверждение выше зеленело бы и у контура, отвергающего любую вторую заявку
    // независимо от позиции, — то есть доказывало бы другое и неверное правило.
    const record = await run((event, bar) =>
      event.kind === 'market.candle.closed' && (bar === 1 || bar === 3)
        ? [place({ clientOrderId: `o${bar}`, side: bar === 1 ? 'buy' : 'sell', reduceOnly: bar === 3 })]
        : [],
    );

    expect(placeOutcomes(record)).toEqual(['applied', 'applied']);
    expect(record.riskDecisions).toEqual([]);
  });

  it('ОТКАЗ НЕ ОСТАВЛЯЕТ ЧАСТИЧНЫХ ЭФФЕКТОВ: ни заявки, ни филла, ни записи ордера', async () => {
    // Отклонённая заявка не должна оставить следа НИГДЕ, кроме журнала отказов. Проба смотрит на
    // все три носителя сразу: книгу (через записи ордеров), бухгалтерию и поток.
    const record = await run((event, bar) =>
      event.kind === 'market.candle.closed' && (bar === 1 || bar === 3)
        ? [place({ clientOrderId: `o${bar}` })]
        : [],
    );

    expect(record.orders.map((o) => o.orderId)).toEqual(['o1']);
    expect(record.journal.filter((j) => j.kind === 'fill')).toHaveLength(1);
    // Автор узнаёт об отказе, и узнаёт адресно — по номеру ИМЕННО своей заявки.
    const denied = record.timeline.flatMap((e) =>
      e.envelope.event.kind === 'order.denied' ? [e.envelope.event] : [],
    );
    expect(denied.map((d) => (d as { clientOrderId: string }).clientOrderId)).toEqual(['o3']);
  });
});

describe('противоположная сторона НЕ равна закрытию', () => {
  it('non-reduceOnly против позиции отвергается — она могла бы пересечь ноль', async () => {
    // Заявка классифицируется как «против позиции» по ЗНАКУ, и размера в этой классификации нет.
    // Нотионал больше позиции пересёк бы ноль и открыл ПРОТИВОПОЛОЖНУЮ — то есть открыл бы позицию
    // мимо `allowedSides`, счётчика и потолка, потому что все три проверяются только на открытии.
    const record = await run((event, bar) => {
      if (event.kind !== 'market.candle.closed') return [];
      if (bar === 1) return [place({ clientOrderId: 'in', qtyUsd: 1000 })];
      // Втрое больше позиции и БЕЗ reduceOnly.
      if (bar === 3) return [place({ clientOrderId: 'flip', side: 'sell', qtyUsd: 3000 })];
      return [];
    });

    expect(placeOutcomes(record)).toEqual(['applied', 'rejected']);
    expect(record.riskDecisions.map((d) => d.reason)).toEqual(['opposite_side_requires_reduce_only']);
  });

  it('ОТКАЗ АТОМАРЕН: ни заявки, ни филла, ни движения ledger', async () => {
    // Позиция обязана остаться ровно такой, какой была: одна открывающая сделка и ничего сверх.
    const record = await run((event, bar) => {
      if (event.kind !== 'market.candle.closed') return [];
      if (bar === 1) return [place({ clientOrderId: 'in', qtyUsd: 1000 })];
      if (bar === 3) return [place({ clientOrderId: 'flip', side: 'sell', qtyUsd: 3000 })];
      return [];
    });

    expect(record.orders.map((o) => o.orderId)).toEqual(['in']);
    expect(record.journal.filter((j) => j.kind === 'fill')).toHaveLength(1);
    // Знак и величина экспозиции не тронуты: флипа не случилось.
    expect(record.finalLedger.qty).toBeGreaterThan(0);
    expect(record.finalLedger.qty).toBeCloseTo(10, 10);
  });

  it('РАЗЛИЧАЮЩИЙ СЛУЧАЙ: та же заявка с reduceOnly проходит', async () => {
    // Без неё утверждение выше зеленело бы и у контура, запрещающего выход вообще. У reduceOnly
    // пересечение нуля невозможно по построению: движок клампит её знаковым остатком позиции.
    const record = await run((event, bar) => {
      if (event.kind !== 'market.candle.closed') return [];
      if (bar === 1) return [place({ clientOrderId: 'in', qtyUsd: 1000 })];
      if (bar === 3) return [place({ clientOrderId: 'out', side: 'sell', qtyUsd: 3000, reduceOnly: true })];
      return [];
    });

    expect(placeOutcomes(record)).toEqual(['applied', 'applied']);
    // И позиция ДЕЙСТВИТЕЛЬНО закрыта, а не перевёрнута избыточным размером.
    expect(record.finalLedger.qty).toBe(0);
  });

});

describe('RE-ВАЛИДАЦИЯ В МОМЕНТ ИСПОЛНЕНИЯ: обход правила через время', () => {
  // Проверка на подаче закрывает только момент подачи. Заявка, законно принятая при flat, стоит в
  // книге; пока она ждёт цену, позицию открывает другая заявка — и к срабатыванию та же самая
  // заявка означает уже другое. Без второй проверки правило обходится ЧЕРЕЗ ВРЕМЯ.
  //
  // Первая редакция этих проб была ВАКУУМНОЙ: ждущая заявка имела триггер 150 при барах с
  // high = 105, то есть не срабатывала никогда. «Ничего не произошло» читалось как «правило
  // соблюдено», хотя проверять было нечего. Здесь триггер ДОСТИЖИМ, и каждая проба смотрит на
  // ledger и на филлы, а не только на исходы подачи.

  /** Лента с уступом: первые `flat` баров на 100, дальше на 200 — ждущая заявка дожидается цены. */
  const stepped = (flat: number, total: number): readonly ActorBar[] =>
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

  async function runStepped(
    script: (event: ActorInputEvent, barSeen: number) => readonly ActorCommand[],
    feeBps = 0,
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
    const tape = stepped(4, 7);
    const admission = admitActorMarketData(strategy(), {
      candleVenue: proveCandleVenue({ datasetRef: 'actor-risk', candleVenue: 'bybit' }),
      symbol: 'BTCUSDT',
      barIntervalUs: MINUTE_US,
      barCount: tape.length,
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
      bars: tape,
      costs: { feeBps, slippageBps: 0, initialEquity: EQUITY },
      risk: { profile: ACTOR_DEFAULT_RISK, initialEquity: EQUITY },
    });
  }

  it('pending → ADD: ждущая заявка, ставшая наращиванием, снимается ДО исполнения', async () => {
    // `buy stop 150` подан при flat — законное открытие. Пока он ждёт, позиция открывается лонгом,
    // и к срабатыванию заявка НАРАЩИВАЕТ её — то, что профиль запрещает.
    const record = await runStepped((event, bar) => {
      if (event.kind !== 'market.candle.closed') return [];
      if (bar === 1) return [place({ clientOrderId: 'pending', side: 'buy', type: 'stop_market', stopPrice: 150, qtyUsd: 1000 })];
      if (bar === 2) return [place({ clientOrderId: 'opener', side: 'buy', qtyUsd: 1000 })];
      return [];
    });

    // Обе приняты на подаче: в свой момент каждая была законна.
    expect(placeOutcomes(record)).toEqual(['applied', 'applied']);
    // Исполнился ТОЛЬКО опенер: ждущая снята до `executeFill`.
    expect(record.journal.filter((j) => j.kind === 'fill').map((f) => (f.kind === 'fill' ? f.orderId : ''))).toEqual([
      'opener',
    ]);
    // Причина доехала — и это причина RESTING-проверки, а не подачи.
    expect(record.riskDecisions).toEqual([
      { barIndex: 4, decisionKind: 'resting', action: 'reject', reason: 'resting_add_not_permitted' },
    ]);
    // Экспозиция — ровно от одного филла: 1000/100 = 10.
    expect(record.finalLedger.qty).toBeCloseTo(10, 10);
    // Заявка доехала до canceled через автомат, а не исчезла.
    expect(record.orders.find((o) => o.orderId === 'pending')!.terminalState).toBe('canceled');
  });

  it('pending → FLIP: ждущая встречная без reduceOnly снимается, ноль не пересекается', async () => {
    // `sell limit 150` подан при flat — законное открытие шорта. Позиция открывается лонгом
    // раньше, чем цена дойдёт до лимита; к срабатыванию заявка на 3000 при позиции в 1000
    // пересекла бы ноль и открыла шорт — мимо проверок открытия.
    //
    // ЛИМИТ, А НЕ СТОП, И ЭТО НЕ СТИЛЬ: sell-стоп срабатывает на ПАДЕНИИ, а лента растёт со 100 до
    // 200 — такой триггер недостижим, и проба молча ничего бы не проверяла. Ровно этот дефект был
    // в первой редакции временного случая.
    const record = await runStepped((event, bar) => {
      if (event.kind !== 'market.candle.closed') return [];
      if (bar === 1) return [place({ clientOrderId: 'pending', side: 'sell', type: 'limit', price: 150, qtyUsd: 3000 })];
      if (bar === 2) return [place({ clientOrderId: 'opener', side: 'buy', qtyUsd: 1000 })];
      return [];
    });

    expect(placeOutcomes(record)).toEqual(['applied', 'applied']);
    expect(record.journal.filter((j) => j.kind === 'fill').map((f) => (f.kind === 'fill' ? f.orderId : ''))).toEqual([
      'opener',
    ]);
    expect(record.riskDecisions).toEqual([
      { barIndex: 4, decisionKind: 'resting', action: 'reject', reason: 'resting_opposite_requires_reduce_only' },
    ]);
    // ГЛАВНОЕ: позиция осталась ЛОНГОМ. Знак не перевернулся — значит ноль не пересекали.
    expect(record.finalLedger.qty).toBeGreaterThan(0);
    expect(record.finalLedger.qty).toBeCloseTo(10, 10);
  });

  it('ОТМЕНА СВЯЗАНА С ПРИЧИНОЙ: обе половины факта лежат в ОДНОЙ записи', async () => {
    // Прежде идентификатор был у ордера, причина — у вердикта, и ни одна запись не содержала
    // обоих. Связать их можно было только сопоставлением двух списков по номеру frontier'а, то
    // есть догадкой «наверное, отменили именно эту» — она ломается на первом же frontier'е, где
    // снято больше одной заявки.
    const record = await runStepped((event, bar) => {
      if (event.kind !== 'market.candle.closed') return [];
      if (bar === 1) return [place({ clientOrderId: 'pending', side: 'buy', type: 'stop_market', stopPrice: 150, qtyUsd: 1000 })];
      if (bar === 2) return [place({ clientOrderId: 'opener', side: 'buy', qtyUsd: 1000 })];
      return [];
    });

    const cancelled = record.orders.find((o) => o.orderId === 'pending')!;
    expect(cancelled.terminalState).toBe('canceled');
    expect(cancelled.cancelReason).toBe('resting_add_not_permitted');
    // Опенер отменён не был — иначе причина выше «прилипала» бы ко всем заявкам подряд.
    expect(record.orders.find((o) => o.orderId === 'opener')!.cancelReason).toBeUndefined();

    // И событие отмены адресовано ИМЕННО этой заявке: автор закрывает своё ожидание по номеру.
    const canceledIds = record.timeline
      .map((e) => e.envelope.event)
      .filter((ev): ev is typeof ev & { clientOrderId: string } => ev.kind === 'order.canceled')
      .map((ev) => ev.clientOrderId);
    expect(canceledIds).toEqual(['pending']);
  });

  it('FLAT, НО EQUITY УПАЛА: ждущая заявка клампится по ТЕКУЩЕМУ потолку', async () => {
    // Позиции нет — ни наращивания, ни пересечения нуля быть не может, и на этом соблазн
    // остановиться велик. Но потолок считается ОТ EQUITY: убыточная сделка её уменьшила, а заявка
    // несёт СТАРЫЙ нотионал, принятый при прежнем капитале. Без пересчёта она открыла бы позицию
    // больше, чем профиль разрешает СЕЙЧАС.
    const record = await runStepped((event, bar) => {
      if (event.kind !== 'market.candle.closed') return [];
      // Ждущая заявка на весь капитал, принята при equity 10 000.
      if (bar === 1) return [place({ clientOrderId: 'pending', side: 'buy', type: 'stop_market', stopPrice: 150, qtyUsd: 10_000 })];
      // Сделка в убыток: вход и выход по одной цене, но с комиссией — equity уменьшается.
      if (bar === 2) return [place({ clientOrderId: 'in', side: 'buy', qtyUsd: 1000 })];
      if (bar === 3) return [place({ clientOrderId: 'out', side: 'sell', qtyUsd: 5000, reduceOnly: true })];
      return [];
    }, 50);

    // К моменту срабатывания позиция закрыта (flat), но equity уже НЕ 10 000.
    const clamp = record.riskDecisions.find((d) => d.action === 'clamp');
    expect(clamp?.decisionKind).toBe('resting');
    expect(clamp?.reason).toBe('resting_notional_clamped');
    // Клампнуто СТРОГО ниже запрошенного — то есть потолок пересчитан, а не взят стартовым.
    expect(clamp!.clamped![0]!.to).toBeLessThan(10_000);
    // Заявка не снята: профиль разрешает открыть, но меньше.
    expect(record.orders.find((o) => o.orderId === 'pending')!.cancelReason).toBeUndefined();
    // ГЛАВНОЕ: исполнен ИМЕННО клампнутый размер, а не запрошенный.
    //
    // Мутация «кламп не применяется к книге» сперва не красила ничего: проба смотрела только на
    // наличие вердикта, и заявка, вставшая исходными 10 000, проходила её с записью «клампнуто».
    // Вердикт без применения — это отчёт о том, чего не произошло.
    const pendingFill = record.journal.find((j) => j.kind === 'fill' && j.orderId === 'pending');
    expect(pendingFill).toBeDefined();
    if (pendingFill?.kind !== 'fill') throw new Error('ожидался филл ждущей заявки');
    expect(pendingFill.qty * pendingFill.price).toBeCloseTo(clamp!.clamped![0]!.to, 6);
  });

  it('ИСЧЕРПАННЫЙ ПОТОЛОК: при нулевой equity ждущая заявка снимается, а не клампится в ноль', async () => {
    // Третья ветка re-валидации при flat, и единственная, которой не было пробы. Кламп до нуля дал
    // бы заявку нулевого размера — её отвергла бы уже проверка размера, но с ДРУГОЙ причиной,
    // потерявшей риск как виновника. Отказ обязан называть исчерпанный потолок.
    //
    // Комиссия 100% съедает капитал: вход и выход по 5000 при equity 10 000 обнуляют её.
    const record = await runStepped((event, bar) => {
      if (event.kind !== 'market.candle.closed') return [];
      if (bar === 1) return [place({ clientOrderId: 'pending', side: 'buy', type: 'stop_market', stopPrice: 150, qtyUsd: 1000 })];
      if (bar === 2) return [place({ clientOrderId: 'in', side: 'buy', qtyUsd: 5000 })];
      if (bar === 3) return [place({ clientOrderId: 'out', side: 'sell', qtyUsd: 9000, reduceOnly: true })];
      return [];
    }, 10_000);

    const cancelled = record.orders.find((o) => o.orderId === 'pending')!;
    expect(cancelled.terminalState).toBe('canceled');
    expect(cancelled.cancelReason).toBe('resting_exposure_ceiling_exhausted');
    expect(record.riskDecisions.at(-1)).toEqual({
      barIndex: 4,
      decisionKind: 'resting',
      action: 'reject',
      reason: 'resting_exposure_ceiling_exhausted',
    });
    // Филла ждущей нет: снятие не материализуется в бухгалтерии.
    expect(record.journal.filter((j) => j.kind === 'fill').map((f) => (f.kind === 'fill' ? f.orderId : ''))).not.toContain(
      'pending',
    );
  });

  it('ПОЛОЖИТЕЛЬНЫЙ: ждущая reduceOnly-заявка исполняется и закрывает позицию', async () => {
    // Без этой пробы обе выше зеленели бы и у раннера, снимающего ЛЮБУЮ ждущую заявку при открытой
    // позиции, — то есть доказывали бы «выход из позиции невозможен», а это другое и неверное
    // правило. reduceOnly сюда не попадает намеренно: её состояния разбирает движок.
    const record = await runStepped((event, bar) => {
      if (event.kind !== 'market.candle.closed') return [];
      if (bar === 1) return [place({ clientOrderId: 'opener', side: 'buy', qtyUsd: 1000 })];
      if (bar === 2) {
        return [place({ clientOrderId: 'exit', side: 'sell', type: 'stop_market', stopPrice: 150, qtyUsd: 3000, reduceOnly: true })];
      }
      return [];
    });

    expect(record.journal.filter((j) => j.kind === 'fill').map((f) => (f.kind === 'fill' ? f.orderId : ''))).toEqual([
      'opener',
      'exit',
    ]);
    // Позиция закрыта, а не перевёрнута: reduceOnly клампится движком по знаковому остатку.
    expect(record.finalLedger.qty).toBe(0);
    expect(record.riskDecisions).toEqual([]);
  });
});

describe('размер урезается потолком экспозиции', () => {
  it('заявка выше потолка встаёт КЛАМПНУТОЙ, и это видно в вердикте', async () => {
    // `maxPositionNotionalPct: 1.0` при equity 10 000 даёт потолок 10 000. Запрошено 25 000.
    const record = await run((event, bar) =>
      event.kind === 'market.candle.closed' && bar === 1
        ? [place({ clientOrderId: 'big', qtyUsd: 25_000 })]
        : [],
    );

    expect(record.riskDecisions).toEqual([
      {
        barIndex: 0,
        decisionKind: 'place',
        action: 'clamp',
        reason: 'notional_clamped',
        clamped: [{ field: 'qtyUsd', from: 25_000, to: EQUITY }],
      },
    ]);

    // ГЛАВНОЕ: в книгу встал клампнутый размер, а не запрошенный. Проба, сверяющая только наличие
    // вердикта, прошла бы и на заявке, вставшей на 25 000 с записью «клампнуто».
    const fill = record.journal.find((j) => j.kind === 'fill')!;
    expect(fill.qty).toBeCloseTo(EQUITY / 100, 10);
  });

  it('заявка в пределах потолка не трогается', async () => {
    // Проверка проверки: без неё «кламп работает» зеленело бы и у контура, клампящего всё подряд.
    const record = await run((event, bar) =>
      event.kind === 'market.candle.closed' && bar === 1 ? [place({ clientOrderId: 'ok' })] : [],
    );
    expect(record.riskDecisions).toEqual([]);
    expect(record.journal.find((j) => j.kind === 'fill')!.qty).toBeCloseTo(10, 10);
  });

  it('ПОТОЛОК СЧИТАЕТСЯ ОТ ТЕКУЩЕЙ EQUITY, а не от стартовой', async () => {
    // Издержки предыдущей сделки уменьшают потолок следующего входа. Без этого лимит был бы
    // константой, и профиль разрешал бы набирать прежний объём на проигранном счёте.
    //
    // КОМИССИЯ ЗДЕСЬ НЕНУЛЕВАЯ, И ЭТО НЕ ДЕТАЛЬ. Первая редакция пробы гоняла её при feeBps=0 на
    // ровной ленте: сделка закрывалась ровно в ноль, `realizedPnl` не двигался, потолок второго
    // входа совпадал со стартовым — и утверждение «база не константа» было НЕОТЛИЧИМО от своего
    // отрицания. Проба зеленела бы и у контура, считающего лимит от стартового капитала навсегда.
    const profile = { ...ACTOR_DEFAULT_RISK, exposureLimits: { maxPositionNotionalPct: 0.5 } };
    const record = await run(
      (event, bar) => {
        if (event.kind !== 'market.candle.closed') return [];
        if (bar === 1) return [place({ clientOrderId: 'e1', qtyUsd: 5000 })];
        if (bar === 3) return [place({ clientOrderId: 'x1', side: 'sell', reduceOnly: true, qtyUsd: 5000 })];
        if (bar === 5) return [place({ clientOrderId: 'e2', qtyUsd: 9000 })];
        return [];
      },
      profile,
      6,
      10,
    );

    const clamp = record.riskDecisions.find((d) => d.action === 'clamp')!;
    expect(clamp.reason).toBe('notional_clamped');

    // Потолок второго входа = 0.5 × equity НА МОМЕНТ ПОДАЧИ, а позиция к тому моменту закрыта,
    // значит equity этого frontier'а и есть база. Стартовые 5000 из неё не получаются.
    const to = clamp.clamped![0]!.to;
    expect(to).toBeLessThan(5000);
    expect(to).toBeCloseTo(0.5 * record.equity[3]!.equity, 6);
  });
});

describe('сторона проверяется по РЕЗУЛЬТИРУЮЩЕЙ позиции, а не по стороне заявки', () => {
  it('long-only: продажа при длинной позиции — это выход, и она разрешена', async () => {
    // Самая тонкая проба файла. Наивная реализация сравнила бы `side: 'sell'` со списком
    // `['long']` и запретила бы ВЫХОД из позиции, которую сама же разрешила открыть, — заперев
    // капитал в активе, из которого нет выхода. Отказ при этом выглядел бы «строгим риском».
    const longOnly = { ...ACTOR_DEFAULT_RISK, allowedSides: ['long'] };
    const record = await run(
      (event, bar) => {
        if (event.kind !== 'market.candle.closed') return [];
        if (bar === 1) return [place({ clientOrderId: 'in' })];
        if (bar === 3) return [place({ clientOrderId: 'out', side: 'sell', reduceOnly: true })];
        return [];
      },
      longOnly,
    );

    expect(placeOutcomes(record)).toEqual(['applied', 'applied']);
    expect(record.riskDecisions).toEqual([]);
  });

  it('long-only: ОТКРЫТИЕ шорта отвергается', async () => {
    // Различающий случай к предыдущему: та же сторона заявки (`sell`), другое намерение.
    const longOnly = { ...ACTOR_DEFAULT_RISK, allowedSides: ['long'] };
    const record = await run(
      (event, bar) =>
        event.kind === 'market.candle.closed' && bar === 1
          ? [place({ clientOrderId: 'short', side: 'sell' })]
          : [],
      longOnly,
    );

    expect(placeOutcomes(record)).toEqual(['rejected']);
    expect(record.riskDecisions.map((d) => d.reason)).toEqual(['side_not_allowed']);
  });
});

describe('риск-отказ ведёт себя как всякий rejection §3.8.4', () => {
  it('префикс закоммичен, суффикс оборван, инстанс жив', async () => {
    // Отдельного пути у риска нет: он обязан получить те же гарантии, что нехватка средств или
    // неизвестная заявка. Батч [annotate, риск-reject, annotate] — различающий именно это.
    const record = await run((event, bar) => {
      if (event.kind !== 'market.candle.closed') return [];
      if (bar === 1) return [place({ clientOrderId: 'in' })];
      if (bar === 3) {
        return [
          { kind: 'annotate', note: 'до' } as unknown as ActorCommand,
          place({ clientOrderId: 'add' }),
          { kind: 'annotate', note: 'после' } as unknown as ActorCommand,
        ];
      }
      return [];
    });

    const batch = record.timeline.find((e) => e.commands.length === 3)!;
    expect(batch.commands.map((c) => c.outcome.status)).toEqual(['applied', 'rejected', 'skipped']);
  });

  it('отказ доезжает автору В ТОМ ЖЕ frontier, а не на следующем баре', async () => {
    const record = await run((event, bar) =>
      event.kind === 'market.candle.closed' && (bar === 1 || bar === 3)
        ? [place({ clientOrderId: `o${bar}` })]
        : [],
    );

    const rejectedAt = record.timeline.find((e) =>
      e.commands.some((c) => c.outcome.status === 'rejected'),
    )!.frontier;
    const deniedAt = record.timeline.find((e) => e.envelope.event.kind === 'order.denied')!.frontier;
    expect(deniedAt).toBe(rejectedAt);
  });
});

describe('негодное значение профиля громко бросает, а не тихо выключает лимит', () => {
  // Эти пробы существуют потому, что мутация ИХ ОТСУТСТВИЯ ничего не красила: снятый бросок
  // проходил мимо всех гейтов. Причина — гейт совместимости отвергает такой профиль раньше, и до
  // `evaluateActorPlace` он в прод-сценарии не доходит. Защита инварианта, которую ничто не
  // проверяет, — это не защита, а комментарий: она молча исчезнет при первом же рефакторинге.
  const flat = {
    frontierIndex: 0,
    frontierUs: timestampUsFromMillis(T0),
    readiness: 'ready',
    tradingState: 'normal',
    ledger: { qty: 0, avgPrice: 0, realizedPnl: 0, openedAtUs: null, fills: [] },
    openOrders: [],
    timers: [],
    notes: [],
    riskDecisions: [],
  } as unknown as Parameters<typeof evaluateActorPlace>[1];

  const cmd = { kind: 'place', type: 'market', side: 'buy', qtyUsd: 100, clientOrderId: 'x' } as never;

  it('NaN в потолке: бросок, а не молчаливый пропуск блока размера', () => {
    // Раньше здесь стояло `if (… && Number.isFinite(pct))` — и профиль с NaN пропускал проверку
    // размера ЦЕЛИКОМ. Прогон шёл без потолка, а профиль выглядел строгим.
    expect(() =>
      evaluateActorPlace(cmd, flat, { id: 'r', version: '1', exposureLimits: { maxPositionNotionalPct: Number.NaN } }, 10_000),
    ).toThrow(/миновал гейт совместимости/);
  });

  it('отрицательный потолок: тоже бросок', () => {
    expect(() =>
      evaluateActorPlace(cmd, flat, { id: 'r', version: '1', exposureLimits: { maxPositionNotionalPct: -1 } }, 10_000),
    ).toThrow(/миновал гейт совместимости/);
  });

  it('дробный maxConcurrentPositions: бросок — сравнение с ним не отвергло бы ничего', () => {
    expect(() =>
      evaluateActorPlace(cmd, flat, { id: 'r', version: '1', maxConcurrentPositions: Number.NaN }, 10_000),
    ).toThrow(/миновал гейт совместимости/);
  });

  it('ПРОВЕРКА ПРОВЕРКИ: годный профиль не бросает', () => {
    expect(() => evaluateActorPlace(cmd, flat, ACTOR_DEFAULT_RISK, 10_000)).not.toThrow();
  });
});

describe('причина риска несёт машинный код, а не только прозу', () => {
  it('round-trip: код извлекается из отформатированной причины', () => {
    expect(parseRiskRefusal(formatRiskRefusal('some_code', 'человеческий текст'))).toBe('some_code');
  });

  it('ЧУЖАЯ причина риску не принадлежит', () => {
    // Иначе структурные отказы (прогрев, занятый номер) попадали бы в `riskDecisions` и приписывали
    // риску решения, которых он не принимал.
    expect(parseRiskRefusal('place отклонена: актор ещё прогревается')).toBeNull();
    expect(parseRiskRefusal('risk-подобное начало без разделителя')).toBeNull();
  });

  it('структурный отказ НЕ попадает в riskDecisions', async () => {
    // Сквозная проба того же: заявка с занятым номером отвергается `validate`, но это не вердикт
    // риска, и в его журнале ей места нет.
    const record = await run((event, bar) =>
      event.kind === 'market.candle.closed' && bar === 1
        ? [place({ clientOrderId: 'dup', type: 'limit', price: 1 }), place({ clientOrderId: 'dup', type: 'limit', price: 1 })]
        : [],
    );

    expect(placeOutcomes(record)).toEqual(['applied', 'rejected']);
    expect(record.riskDecisions).toEqual([]);
  });
});
