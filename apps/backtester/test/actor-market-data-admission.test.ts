// ГЕЙТ: поддерживаемый поднабор market data задан ТОЧНО, и всё остальное отвергается до актора.
//
// ПОЧЕМУ ЭТО НЕ ПРИДИРЧИВОСТЬ. Подписка — обещание. Актор, объявивший `open_interest`, ревизии или
// другой интервал, вправе на них рассчитывать; хост, который их не доставляет, но прогон запускает,
// врёт молча — и числа при этом получаются правдоподобные. Поймать такое потом нечем: расхождение
// не в отказе, а в поведении стратегии, которая приняла решение на входе, которого не получила.
//
// Отказ обязан случиться ДО `createActor` и init. Актору, которому нечего доставлять, незачем
// существовать: созданный актор — это уже ресурс, который надо закрывать, и отказ посреди прогона
// стоит дороже отказа до него.

import { describe, expect, it } from 'vitest';
import { CONTRACT_VERSION } from '@trading/research-contracts/research';
import type { MarketDataRequirement } from '@trdlabs/sdk/research-contract';

import { admitActorMarketData, subscriptionIdFor } from '../src/engine/actor/admission.js';
import type { ActorTapeCapabilities } from '../src/engine/actor/admission.js';
import type { ResolvedStrategy } from '../src/engine/artifacts.js';

const MINUTE_US = 60_000_000;
const TAPE: ActorTapeCapabilities = { symbol: 'BTCUSDT', barIntervalUs: MINUTE_US, barCount: 100 };

/** Требование ровно поддерживаемой формы — от него и отличаются все пробы ниже. */
const supported = (over: Partial<MarketDataRequirement> = {}): MarketDataRequirement =>
  ({
    kind: 'candles',
    id: 'req-candles',
    instrument: { venue: 'binance', symbol: 'BTCUSDT' },
    interval: MINUTE_US,
    lookback: 5,
    revisionPolicy: { mode: 'final_only' },
    priceType: 'trade',
    ...over,
  }) as MarketDataRequirement;

const strategyWith = (marketData: readonly MarketDataRequirement[]): ResolvedStrategy =>
  ({
    manifest: {
      id: 'probe',
      version: '1.0.0',
      kind: 'strategy',
      contractVersion: CONTRACT_VERSION,
      lifecycle: 'event_driven',
      marketData,
    },
    module: {},
  }) as unknown as ResolvedStrategy;

describe('поддерживаемая форма проходит и НАЗЫВАЕТ подписки', () => {
  it('candle-only требование допускается', () => {
    const out = admitActorMarketData(strategyWith([supported()]), TAPE);
    expect(out.refusal).toBeNull();
  });

  it('дескрипторы строит ДОПУСК, а не раннер', () => {
    // `subscriptionId` обязан быть канонической ссылкой на элемент этого же списка (контракт).
    // Назначать его в двух местах значило бы дать им разойтись: «проверено» относилось бы к одному
    // списку, «доставлено» — к другому.
    const out = admitActorMarketData(strategyWith([supported()]), TAPE);
    expect(out.subscriptions).toEqual([
      { subscriptionId: subscriptionIdFor('req-candles'), kind: 'candles', requirementId: 'req-candles' },
    ]);
  });

  it('несколько свечных требований — каждое со своим идентификатором', () => {
    const out = admitActorMarketData(
      strategyWith([supported(), supported({ id: 'req-second' })]),
      TAPE,
    );
    expect(out.refusal).toBeNull();
    expect(out.subscriptions.map((s) => s.subscriptionId)).toEqual([
      subscriptionIdFor('req-candles'),
      subscriptionIdFor('req-second'),
    ]);
  });
});

describe('всё, что не поддержано, отвергается — и отказ ничего не отдаёт', () => {
  const refuses = (marketData: readonly MarketDataRequirement[], match: RegExp): void => {
    const out = admitActorMarketData(strategyWith(marketData), TAPE);
    expect(out.refusal?.code).toBe('unsupported_lifecycle');
    // Пустой Pointer: нарушен не узел запроса, а возможности хоста.
    expect(out.refusal?.path).toBe('');
    expect(out.refusal?.message).toMatch(match);
    // Отказ НЕ отдаёт подписок: половина результата хуже отсутствия — вызывающий, забывший
    // проверить отказ, построил бы актора на пустом списке.
    expect(out.subscriptions).toEqual([]);
  };

  it.each(['open_interest', 'liquidations', 'taker_volume', 'funding'])(
    'вид «%s» не поддержан в этом срезе',
    (kind) => {
      refuses([supported({ kind } as Partial<MarketDataRequirement>)], /поддержаны только/);
    },
  );

  it('чужой инструмент этой лентой не обслужить', () => {
    refuses(
      [supported({ instrument: { venue: 'binance', symbol: 'ETHUSDT' } } as Partial<MarketDataRequirement>)],
      /а прогон идёт по BTCUSDT/,
    );
  });

  it('другой интервал — агрегации в этом срезе нет', () => {
    refuses([supported({ interval: 5 * MINUTE_US } as Partial<MarketDataRequirement>)], /шагом 60000000 мкс/);
  });

  it('ревизии обещать нечем', () => {
    refuses(
      [supported({ revisionPolicy: { mode: 'revisable' } } as unknown as Partial<MarketDataRequirement>)],
      /ревизий не несёт/,
    );
  });

  it('lookback длиннее ленты не набрать', () => {
    refuses([supported({ lookback: 101 } as Partial<MarketDataRequirement>)], /барах в ленте/);
  });

  it('дубликат требования', () => {
    refuses([supported(), supported()], /объявлено дважды/);
  });

  it('пустой marketData — допуск самостоятелен, а не полагается на чужую проверку', () => {
    // Контракт 017.4 отвергает такой манифест раньше, но допуск не вправе на это рассчитывать:
    // проверка, опирающаяся на «кто-то до меня уже посмотрел», исчезает вместе с тем, кто смотрел.
    refuses([], /не объявляет marketData/);
  });
});

describe('ПРОВЕРКА ПРОВЕРКИ: границы допуска', () => {
  it('lookback РОВНО по длине ленты допускается', () => {
    // Без этого «lookback длиннее ленты» зеленело бы и у проверки, отвергающей любой lookback.
    expect(admitActorMarketData(strategyWith([supported({ lookback: 100 })]), TAPE).refusal).toBeNull();
  });

  it('отсутствующая revisionPolicy допускается — это не то же, что чужая', () => {
    const req = supported();
    delete (req as { revisionPolicy?: unknown }).revisionPolicy;
    expect(admitActorMarketData(strategyWith([req]), TAPE).refusal).toBeNull();
  });

  it('не-event-driven манифест сюда не попадает — решает вызывающий, а не эта функция', () => {
    // Функция намеренно НЕ спрашивает про lifecycle: её вызывают уже после `admitActorRun`, и
    // вторая проверка того же условия рано или поздно разойдётся с первой.
    const out = admitActorMarketData(strategyWith([supported()]), TAPE);
    expect(out.refusal).toBeNull();
  });
});
