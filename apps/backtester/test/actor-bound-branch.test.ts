// 083 S3 СТУПЕНЬ 1 — СВЯЗАННАЯ ВЕТВЬ ПРИВЯЗКИ (§6 плана cc#395, контракт 017.6).
//
// Требование теперь бывает двух форм:
//
//   фиксированная: { instrument: { venue, symbol } }               — «этот и только этот»
//   связанная:     { instrument: { venue }, symbolFrom: 'actor' }  — символ приносит прогон
//
// ═══ ГЛАВНОЕ УТВЕРЖДЕНИЕ ФАЙЛА ═══
//
// «Связанное требование при ОДНОМ акторе ведёт себя ровно как фиксированное на его символе» —
// требование §6, и оно доказывается РАВЕНСТВОМ РЕЗУЛЬТАТОВ, а не комментарием в коде. Иначе
// правка, которая касается только новой ветви, изменила бы поведение односимвольного прогона —
// то есть прогона, которого она не касается вовсе.

import { describe, expect, it } from 'vitest';
import { CONTRACT_VERSION } from '@trading/research-contracts/research';
import type { MarketDataRequirement } from '@trdlabs/sdk/research-contract';

import { runActorProduction } from '../src/engine/actor/production.js';
import type { ActorExecutionHandle, ActorLifecycleExecutor } from '../src/engine/actor/execution-handle.js';
import type { ResolvedStrategy } from '../src/engine/artifacts.js';
import type { CandleDataset } from '../src/engine/dataset.js';
import { InMemoryArtifactStore } from '../src/artifacts/store.js';
import { contentRef } from '../src/determinism/hash.js';
import type { RiskProfileShape } from '../src/engine/actor/production.js';

const MINUTE_US = 60_000_000;
const MINUTE_MS = 60_000;
const T0 = 1_700_000_000_000;
const VENUE = 'bybit';

/** Обратно-алфавитный порядок — та же дисциплина против совпадения порядков. */
const SYMBOLS = ['ETHUSDT', 'BTCUSDT'] as const;
const BASE_OF: Readonly<Record<string, number>> = { ETHUSDT: 100, BTCUSDT: 150 };

const datasetOf = (symbols: readonly string[]): CandleDataset =>
  ({
    datasetRef: 'bound-branch-probe-1m',
    timeframe: '1m',
    candleVenue: VENUE,
    symbols: () => symbols,
    candles: (symbol: string) => {
      const base = BASE_OF[symbol];
      if (base === undefined) throw new Error(`нет символа ${symbol}`);
      return Array.from({ length: 5 }, (_, i) => ({
        ts: T0 + i * MINUTE_MS,
        open: base + i,
        high: base + 1 + i,
        low: base - 1 + i,
        close: base + 0.5 + i,
        volume: 10,
      }));
    },
  }) as unknown as CandleDataset;

const fixed = (symbol: string, id: string): MarketDataRequirement =>
  ({
    kind: 'candles',
    id,
    instrument: { venue: VENUE, symbol },
    interval: MINUTE_US,
    lookback: 0,
    revisionPolicy: { mode: 'final_only' },
    priceType: 'trade',
  }) as MarketDataRequirement;

/** Связанная ветвь: символа НЕТ, различитель — отдельное поле. */
const bound = (id: string): MarketDataRequirement =>
  ({
    kind: 'candles',
    id,
    instrument: { venue: VENUE },
    symbolFrom: 'actor',
    interval: MINUTE_US,
    lookback: 0,
    revisionPolicy: { mode: 'final_only' },
    priceType: 'trade',
  }) as unknown as MarketDataRequirement;

const strategyFor = (reqs: readonly MarketDataRequirement[]): ResolvedStrategy =>
  ({
    manifest: {
      id: 'bound-branch-probe',
      version: '1.0.0',
      kind: 'strategy',
      contractVersion: CONTRACT_VERSION,
      lifecycle: 'event_driven',
      marketData: reqs,
    },
    module: {},
  }) as unknown as ResolvedStrategy;

/** Кладёт по одной заявке на актора — иначе сравнивать было бы нечего. */
function executorPlacingOnce(): ActorLifecycleExecutor {
  const placed = new Set<string>();
  return {
    createActor: async (_src, init) => ({ __h: (init as { symbol: string }).symbol }) as unknown as ActorExecutionHandle,
    executeActorEvent: async (handle, event) => {
      const key = (handle as unknown as { __h: string }).__h;
      if (event.kind !== 'market.candle.closed' || placed.has(key)) return [];
      placed.add(key);
      return [{ kind: 'place', type: 'market', clientOrderId: `${key}-o1`, side: 'buy', qtyUsd: 500 } as never];
    },
    disposeActor: async () => {},
  };
}

/**
 * Профиль БЕЗ `maxConcurrentPositions` — и объявлен он ЗДЕСЬ вынужденно, а не для удобства.
 *
 * ПОСТАВИТЬ ТАКОЙ ПРОФИЛЬ СЕГОДНЯ НЕЛЬЗЯ. Контракт объявляет `RiskProfile.maxConcurrentPositions`
 * ОБЯЗАТЕЛЬНЫМ полем, а `portfolioLimitUnsupported` отвергает многосимвольный прогон при ЛЮБОМ
 * конечном значении — потому что правило относится к ПОРТФЕЛЮ, а координатора над акторами в этом
 * срезе нет. Обойти это значением не выходит: `Infinity` не проходит проверку целочисленности в
 * `unsupportedRiskRules`.
 *
 * Отсюда вывод, зафиксированный пробой ниже: сегодня НИ ОДИН профиль, удовлетворяющий контракту,
 * не допускает многосимвольный actor-прогон. Это вынесено владельцу как упирающееся в контракт, а
 * не в код: поставляемый профиль потребует сделать поле необязательным, то есть ещё одного звена
 * релизной цепочки.
 */
async function run(symbols: readonly string[], reqs: readonly MarketDataRequirement[]) {
  return runActorProduction({
    executor: executorPlacingOnce(),
    strategy: strategyFor(reqs),
    symbols,
    dataset: datasetOf(symbols),
    barIntervalUs: MINUTE_US,
    seed: 1,
    params: {},
    costs: { feeBps: 0, slippageBps: 0, initialEquity: 10_000 },
    // Форма допуска (`RiskProfileShape`) отсутствие поля допускает — запрещает его КОНТРАКТ.
    riskProfile: {
      id: 'multi_symbol_probe_risk',
      version: '1.0.0',
      exposureLimits: { maxPositionNotionalPct: 1.0 },
      allowedSides: ['long', 'short'],
    } satisfies RiskProfileShape,
    artifactStore: new InMemoryArtifactStore(),
  } as never);
}

describe('связанная ветвь при ОДНОМ акторе тождественна фиксированной', () => {
  it('обе формы дают ПОБАЙТОВО один результат', async () => {
    // Требование §6 плана, проверенное равенством, а не заявленное. Сравниваются аккумуляторы
    // ЦЕЛИКОМ через content-hash: выборочное сравнение полей пропустило бы ровно то расхождение,
    // которого автор проверки не предвидел.
    const asFixed = await run(['BTCUSDT'], [fixed('BTCUSDT', 'r1')]);
    const asBound = await run(['BTCUSDT'], [bound('r1')]);

    expect(asFixed.refusal).toBeNull();
    expect(asBound.refusal).toBeNull();
    expect(contentRef(asBound.accumulators!)).toBe(contentRef(asFixed.accumulators!));
  });

  it('ПРОВЕРКА ПРОВЕРКИ: прогон действительно торговал, а не совпал на пустоте', async () => {
    // Два пустых прогона совпадают побайтово и не доказывают ничего.
    const out = await run(['BTCUSDT'], [bound('r1')]);
    expect(out.accumulators!.orders).toHaveLength(1);
    expect(out.accumulators!.fills).toHaveLength(1);
  });
});

describe('связанная ветвь обслуживает КАЖДЫЙ символ прогона', () => {
  it('ОДНО связанное требование поднимает акторов на всех символах', async () => {
    // Это и есть то, ради чего ветвь заведена: манифест, не знающий заранее набора символов,
    // объявляет вход один раз. У фиксированной ветви пришлось бы перечислять их поимённо, а
    // символ, забытый в перечне, дал бы отказ уровня прогона.
    const out = await run([...SYMBOLS], [bound('r1')]);
    expect(out.refusal).toBeNull();
    expect(out.records!.map((r) => r.symbol)).toEqual([...SYMBOLS]);
  });

  it('каждый актор торгует по СВОЕЙ ленте, а не по чужой', async () => {
    // Ловится ценой, а не именем: имя заявки берётся из символа актора и при спутанных лентах
    // осталось бы прежним. Уровни разведены (ETH от 100, BTC от 150), налив — по открытию
    // следующего бара.
    const out = await run([...SYMBOLS], [bound('r1')]);
    const fills = out.accumulators!.fills;
    expect(fills.map((f) => `${f.orderId}@${f.fillPrice}`).sort()).toEqual([
      `BTCUSDT-o1@${BASE_OF.BTCUSDT! + 1}`,
      `ETHUSDT-o1@${BASE_OF.ETHUSDT! + 1}`,
    ]);
  });
});


/**
 * Подписки, порождённые ТРЕБОВАНИЯМИ манифеста, — без канонического хостового источника.
 *
 * Хостовый в списке есть всегда и никакому требованию не принадлежит; отличается он отсутствием
 * `requirementId`, а не именем — по имени это была бы догадка о чужой строке.
 */
const requirementSubscriptions = (admission: {
  readonly subscriptions: readonly unknown[];
}): readonly string[] =>
  admission.subscriptions
    // Сужение через `in`, а не расширение типа: у хостового дескриптора поля НЕТ ВОВСЕ, а не
    // «оно необязательно». Объявить его опциональным значило бы описать чужой union своей,
    // более слабой формой — и разойтись с ним на первой же правке контракта.
    .filter((s): s is { readonly requirementId: string } =>
      typeof s === 'object' && s !== null && 'requirementId' in s,
    )
    .map((s) => s.requirementId);

describe('ФИКСИРОВАННАЯ ветвь обслуживает ТОЛЬКО свой символ', () => {
  it('требование чужого символа не попадает в подписки актора', async () => {
    // ДЫРА, НАЙДЕННАЯ МУТАЦИЕЙ. Отбор чужого требования — исходное поведение фиксированной ветви,
    // и на уровне ДОПУСКА его не пиннил никто: мутация «фиксированная ветвь обслуживает любую
    // ленту» проходила зелёной. Отказы уровня прогона её не ловят — они срабатывают раньше и
    // говорят о другом (символ вне прогона / символ без требований).
    //
    // Незамеченной ценой было бы вот что: актор получал бы события ЧУЖОГО инструмента под своим
    // `subscriptionId`, и стратегия торговала бы по смешанным лентам, не имея способа заметить.
    const { admitActorMarketData, proveCandleVenue } = await import('../src/engine/actor/admission.js');

    const admission = admitActorMarketData(
      strategyFor([fixed('BTCUSDT', 'r-btc'), fixed('ETHUSDT', 'r-eth')]),
      {
        candleVenue: proveCandleVenue({ datasetRef: 'probe', candleVenue: VENUE }),
        symbol: 'BTCUSDT',
        barIntervalUs: MINUTE_US,
        barCount: 5,
        carries: () => false,
      },
    );

    // Сужение union'а, а не только проверка: у отказной ветви подписок НЕТ ВОВСЕ, и тип это
    // знает. Бросок здесь заодно печатает причину — `toBeNull()` сообщил бы лишь «не null».
    if (admission.refusal !== null) throw new Error(admission.refusal.message);
    // РОВНО ОДНА подписка требования, и именно своя. Проверяется идентификатор, а не число:
    // совпадение по количеству прошло бы и при подмене одной подписки другой.
    //
    // Хостовый источник отбирается намеренно: он есть в списке ВСЕГДА и требованию не принадлежит
    // (`requirementId` у него отсутствует). Считать его наравне значило бы мерить не тот предмет.
    expect(requirementSubscriptions(admission)).toEqual(['r-btc']);
  });

  it('ПРОВЕРКА ПРОВЕРКИ: связанное требование в тех же условиях подписку ДАЁТ', async () => {
    // Иначе проба выше зеленела бы у реализации, отбрасывающей вообще всё, — и «чужого нет»
    // означало бы «нет ничего».
    const { admitActorMarketData, proveCandleVenue } = await import('../src/engine/actor/admission.js');

    const admission = admitActorMarketData(strategyFor([bound('r-any')]), {
      candleVenue: proveCandleVenue({ datasetRef: 'probe', candleVenue: VENUE }),
      symbol: 'BTCUSDT',
      barIntervalUs: MINUTE_US,
      barCount: 5,
      carries: () => false,
    });

    if (admission.refusal !== null) throw new Error(admission.refusal.message);
    expect(requirementSubscriptions(admission)).toEqual(['r-any']);
  });
});

describe('НИ ОДИН ПОСТАВЛЯЕМЫЙ ПРОФИЛЬ РИСКА НЕ ДОПУСКАЕТ MULTI-SYMBOL', () => {
  it('каждый профиль доверенного реестра объявляет maxConcurrentPositions — и потому отвергает', async () => {
    // ЭТА ПРОБА ФИКСИРУЕТ НЕ ПОВЕДЕНИЕ, А ТУПИК, и стоит здесь именно поэтому.
    //
    // Ступень 1 multi-symbol влита, но воспользоваться ею из коробки нечем: контракт объявляет
    // `RiskProfile.maxConcurrentPositions` ОБЯЗАТЕЛЬНЫМ, а правило портфеля отвергает прогон при
    // любом конечном значении — координатора над акторами в этом срезе нет, и применить лимит к
    // каждому актору отдельно запрещено решением владельца 2026-08-14.
    //
    // Проба покраснеет ровно тогда, когда тупик разомкнут: появится поставляемый профиль без
    // поля (после того как контракт сделает его необязательным). Красный здесь — это ХОРОШАЯ
    // новость, и текст отказа обязан об этом сказать, иначе следующий читатель «починит» пробу.
    const { TRUSTED_REGISTRY_DEFINITION } = await import('../src/engine/registry-definition.js');
    const shipped = TRUSTED_REGISTRY_DEFINITION.riskProfiles;

    expect(shipped.length).toBeGreaterThan(0);
    for (const profile of shipped) {
      expect(
        (profile as { maxConcurrentPositions?: number }).maxConcurrentPositions,
        `профиль ${profile.id} больше не объявляет maxConcurrentPositions — если это осознанный ` +
          'шаг под multi-symbol, тупик разомкнут и эту пробу надо ЗАМЕНИТЬ проверкой того, что ' +
          'прогон под ним действительно идёт, а не просто удалить',
      ).toBeTypeOf('number');
    }
  });

  it('ПРОВЕРКА ПРОВЕРКИ: под поставляемым профилем многосимвольный прогон действительно отвергается', async () => {
    // Без этого утверждение выше было бы про форму данных, а не про последствие.
    const { DEFAULT_RISK } = await import('../src/engine/profiles.js');
    const out = await runActorProduction({
      executor: executorPlacingOnce(),
      strategy: strategyFor([bound('r1')]),
      symbols: [...SYMBOLS],
      dataset: datasetOf([...SYMBOLS]),
      barIntervalUs: MINUTE_US,
      seed: 1,
      params: {},
      costs: { feeBps: 0, slippageBps: 0, initialEquity: 10_000 },
      riskProfile: DEFAULT_RISK,
      artifactStore: new InMemoryArtifactStore(),
    } as never);
    expect(out.refusal?.message).toMatch(/для ПОРТФЕЛЯ/);
  });
});

describe('СМЕШЕНИЕ ветвей в одном манифесте допускается', () => {
  it('фиксированное на один символ рядом со связанным — законный манифест', async () => {
    // Запрет здесь был бы правилом без причины: часть рядов законно общая, часть — своя.
    // Проверяется на прогоне, а не на валидаторе: контракт такой манифест принимает, и вопрос
    // в том, доедет ли он до акторов.
    const out = await run([...SYMBOLS], [fixed('BTCUSDT', 'r-btc'), bound('r-any')]);
    expect(out.refusal).toBeNull();
    expect(out.records).toHaveLength(SYMBOLS.length);
  });

  it('ПРОВЕРКА ПРОВЕРКИ: связанное требование СНИМАЕТ отказ «символ без требований»', async () => {
    // Без связанного требования тот же прогон отвергается — значит проба выше проверяет именно
    // вклад новой ветви, а не то, что отказ вообще не срабатывает.
    const out = await run([...SYMBOLS], [fixed('BTCUSDT', 'r-btc')]);
    expect(out.refusal?.message).toMatch(/не объявил ни одного требования \(ETHUSDT\)/);
  });
});
