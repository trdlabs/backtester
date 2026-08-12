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
//
// ВТОРАЯ ТЕМА НАБОРА — `lookback`. Он НЕ означает «пропустить первые бары»: события прогрева
// доставляются, отклоняется только `place` до готовности (§3.3, требование 6). Не доставлять их
// значило бы сделать первый торговый бар недетерминированным.

import { describe, expect, it } from 'vitest';
import { CONTRACT_VERSION } from '@trading/research-contracts/research';
import type {
  ActorSubscriptionDescriptor,
  MarketDataRequirement,
} from '@trdlabs/sdk/research-contract';

import {
  admitActorMarketData,
  proveCandleVenue,
  readinessAtBar,
  subscriptionIdFor,
} from '../src/engine/actor/admission.js';
import type {
  ActorSubscriptionBinding,
  ActorTapeCapabilities,
} from '../src/engine/actor/admission.js';
import type { ResolvedStrategy } from '../src/engine/artifacts.js';

const MINUTE_US = 60_000_000;
/** Венью берётся ТОЛЬКО у прувера — тест не вправе объявить его сам, иначе гейт проверялся бы мимо. */
const PROVEN_BINANCE = proveCandleVenue({ datasetRef: 'probe-fixture-1m', candleVenue: 'binance' });
const TAPE: ActorTapeCapabilities = {
  candleVenue: PROVEN_BINANCE,
  symbol: 'BTCUSDT',
  barIntervalUs: MINUTE_US,
  barCount: 100,
};

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

/** Допуск, о котором утверждается, что он РАЗРЕШИЛ: сузить здесь, а не в каждом ожидании. */
const admitted = (marketData: readonly MarketDataRequirement[], tape: ActorTapeCapabilities = TAPE) => {
  const out = admitActorMarketData(strategyWith(marketData), tape);
  if (out.refusal !== null) throw new Error(`ожидался допуск, получен отказ: ${out.refusal.message}`);
  return out;
};

describe('поддерживаемая форма проходит и НАЗЫВАЕТ подписки', () => {
  it('candle-only требование допускается', () => {
    expect(admitActorMarketData(strategyWith([supported()]), TAPE).refusal).toBeNull();
  });

  it('дескрипторы строит ДОПУСК, а не раннер', () => {
    // `subscriptionId` обязан быть канонической ссылкой на элемент этого же списка (контракт).
    // Назначать его в двух местах значило бы дать им разойтись: «проверено» относилось бы к одному
    // списку, «доставлено» — к другому.
    expect(admitted([supported()]).subscriptions).toEqual([
      { subscriptionId: subscriptionIdFor('req-candles'), kind: 'candles', requirementId: 'req-candles' },
    ]);
  });

  it('несколько свечных требований — каждое со своим идентификатором', () => {
    const out = admitted([supported(), supported({ id: 'req-second' })]);
    expect(out.subscriptions.map((s) => s.subscriptionId)).toEqual([
      subscriptionIdFor('req-candles'),
      subscriptionIdFor('req-second'),
    ]);
  });
});

describe('допуск отдаёт РАЗРЕШЁННЫЙ вход, а не сырьё для повторного резолва', () => {
  it('binding несёт НОРМАЛИЗОВАННЫЙ СНИМОК требования, а не ссылку на манифест', () => {
    // Раннеру нечего перечитывать в манифесте: всё проверенное лежит здесь. Второе чтение того же
    // поля в другом месте рано или поздно разойдётся с первым — и разойдётся молча.
    const req = supported({ lookback: 7 });
    const [binding, ...rest] = admitted([req]).bindings;
    expect(rest).toEqual([]);
    expect(binding!.requirement).not.toBe(req);
    expect(binding!.requirement).toEqual({
      id: 'req-candles',
      kind: 'candles',
      venue: 'binance',
      symbol: 'BTCUSDT',
      intervalUs: MINUTE_US,
      lookback: 7,
      priceType: 'trade',
      revisions: 'final_only',
    });
    expect(binding!.lookback).toBe(7);
    expect(binding!.descriptor.requirementId).toBe('req-candles');
  });

  it('МУТАЦИЯ МАНИФЕСТА ПОСЛЕ ДОПУСКА не меняет ни binding, ни дескриптор, ни готовность', () => {
    // Главная проба этого блока. Манифест приезжает из недоверенного модуля и живёт своей жизнью;
    // ссылка на его объект сделала бы результат допуска изменяемым ПОСЛЕ проверки — «проверено»
    // относилось бы к одному состоянию, «доставлено» к другому, и следа бы не осталось.
    const req = supported({ lookback: 7 });
    const out = admitted([req]);
    const before = structuredClone({
      bindings: out.bindings,
      subscriptions: out.subscriptions,
      tradingFromBarIndex: out.tradingFromBarIndex,
    });

    const mutable = req as unknown as {
      id: string;
      lookback: number;
      priceType: string;
      instrument: { venue: string; symbol: string };
      interval: number;
    };
    mutable.id = 'подменённый';
    mutable.lookback = 999;
    mutable.priceType = 'mark';
    mutable.instrument = { venue: 'bybit', symbol: 'ETHUSDT' };
    mutable.interval = 5 * MINUTE_US;

    expect(out.bindings).toEqual(before.bindings);
    expect(out.subscriptions).toEqual(before.subscriptions);
    expect(out.tradingFromBarIndex).toBe(before.tradingFromBarIndex);
  });

  it('снимок и дескриптор заморожены — правка через сам binding тоже не проходит', () => {
    // Заморозка поуровневая: `Object.isFrozen` истинен и для поверхностно замороженного объекта,
    // поэтому проверять надо КАЖДЫЙ уровень, а не только внешний.
    const [binding] = admitted([supported()]).bindings;
    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.isFrozen(binding!.requirement)).toBe(true);
    expect(Object.isFrozen(binding!.descriptor)).toBe(true);
    expect(() => {
      (binding!.requirement as { lookback: number }).lookback = 42;
    }).toThrow(TypeError);
  });

  it('порядок bindings повторяет порядок требований манифеста', () => {
    const out = admitted([supported({ id: 'a' }), supported({ id: 'b' }), supported({ id: 'c' })]);
    expect(out.bindings.map((b) => b.requirement.id)).toEqual(['a', 'b', 'c']);
  });

  it('subscriptions и bindings держат ОДНИ И ТЕ ЖЕ объекты дескрипторов', () => {
    // Не «равные», а те же самые. Равенство содержимого сегодня ничего не обещает про завтра:
    // два одинаковых объекта — это два места, где значение может разойтись.
    const out = admitted([supported({ id: 'a' }), supported({ id: 'b' })]);
    expect(out.subscriptions).toHaveLength(2);
    out.subscriptions.forEach((s, i) => expect(s).toBe(out.bindings[i]!.descriptor));
  });

  it('САМ массив подписок заморожен: push и splice не проходят', () => {
    // `readonly` в типе — обещание компилятору, и любое приведение проходит мимо него. Массив,
    // уезжающий в `ActorInit` и в запись прогона, обязан быть неизменяемым в рантайме: дописанная
    // подписка означала бы, что актор объявил один состав, а получил другой.
    const out = admitted([supported()]);
    const mutable = out.subscriptions as ActorSubscriptionDescriptor[];
    expect(Object.isFrozen(out.subscriptions)).toBe(true);
    expect(() =>
      mutable.push({ subscriptionId: 'sub-подложенная', kind: 'candles', requirementId: 'x' }),
    ).toThrow(TypeError);
    expect(() => mutable.splice(0, 1)).toThrow(TypeError);
    expect(out.subscriptions).toHaveLength(1);
  });

  it('массив bindings заморожен тоже', () => {
    const out = admitted([supported()]);
    expect(Object.isFrozen(out.bindings)).toBe(true);
    expect(() => (out.bindings as ActorSubscriptionBinding[]).pop()).toThrow(TypeError);
  });
});

describe('всё, что не поддержано, отвергается — и отказ НЕ ОТДАЁТ ничего пригодного', () => {
  const refuses = (marketData: readonly MarketDataRequirement[], match: RegExp): void => {
    const out = admitActorMarketData(strategyWith(marketData), TAPE);
    expect(out.refusal?.code).toBe('unsupported_lifecycle');
    // Пустой Pointer: нарушен не узел запроса, а возможности хоста.
    expect(out.refusal?.path).toBe('');
    expect(out.refusal?.message).toMatch(match);
    // На отказе полей результата НЕТ ВОВСЕ — ни пустого списка, ни нулевого порога. Пустой список и
    // ноль читаются как разрешающие значения тем, кто забыл проверить отказ; отсутствие поля не
    // читается никак.
    expect(out.bindings).toBeUndefined();
    expect(out.tradingFromBarIndex).toBeUndefined();
  };

  it.each(['open_interest', 'liquidations', 'taker_volume', 'funding'])(
    'вид «%s» не поддержан в этом срезе',
    (kind) => {
      refuses([supported({ kind } as Partial<MarketDataRequirement>)], /поддержаны только/);
    },
  );

  it('чужое венью — подставить одно вместо другого нельзя', () => {
    refuses(
      [supported({ instrument: { venue: 'bybit', symbol: 'BTCUSDT' } } as Partial<MarketDataRequirement>)],
      /просит венью bybit, а свечи прогона с binance/,
    );
  });

  it('чужой инструмент этой лентой не обслужить', () => {
    refuses(
      [supported({ instrument: { venue: 'binance', symbol: 'ETHUSDT' } } as Partial<MarketDataRequirement>)],
      /а прогон идёт по BTCUSDT/,
    );
  });

  it('priceType вне контракта — типом это НЕ проверено ни разу', () => {
    // Манифест приезжает из JSON недоверенного модуля. Тип замыкает `priceType` на `'trade'`, но
    // проверять его обязан рантайм: приведение ниже воспроизводит ровно то, что придёт по проводу.
    refuses(
      [supported({ priceType: 'mark' } as unknown as Partial<MarketDataRequirement>)],
      /просит priceType «mark»/,
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

  it('lookback длиннее ленты: готовность не наступит никогда', () => {
    refuses([supported({ lookback: 101 } as Partial<MarketDataRequirement>)], /готовность не наступит/);
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

describe('венью обязано быть ДОКАЗАНО, а не объявлено вызывающим', () => {
  it('датасет без метаданных венью — происхождение неизвестно', () => {
    // Ровно случай реальной ленты: рекордер знал венью в момент записи (переменная окружения
    // адаптера) и не положил его ни в строку, ни в дескриптор.
    const proof = proveCandleVenue({ datasetRef: 'smoke-btc-1m' });
    expect(proof.proven).toBe(false);
    // Поля `venue` у недоказанного НЕТ — его нельзя случайно сравнить с требованием.
    expect(proof.venue).toBeUndefined();
  });

  it('пустая строка — это не объявление', () => {
    expect(proveCandleVenue({ datasetRef: 'ds', candleVenue: '' }).proven).toBe(false);
  });

  it.each([' ', '\t', '\n', '   \t\n '])('строка из одних пробелов (%j) — тоже не объявление', (blank) => {
    // Такое же молчание, как отсутствие поля, но выглядит как заполненное значение. Пройди оно
    // гейт — дальше сравнивалось бы с venue требования и никогда не совпадало: отказ пришёл бы с
    // неверной причиной, отправляя читателя чинить манифест вместо метаданных датасета.
    expect(proveCandleVenue({ datasetRef: 'ds', candleVenue: blank }).proven).toBe(false);
  });

  it('обрамляющие пробелы срезаются, а не отвергают объявление', () => {
    // Проверка проверки: без неё «пробелы не объявление» зеленело бы и у прувера, отвергающего
    // любое значение с пробелом внутри строки.
    const proof = proveCandleVenue({ datasetRef: 'ds', candleVenue: '  bybit \n' });
    expect(proof.proven).toBe(true);
    expect(proof.venue).toBe('bybit');
  });

  it('датасет с объявленным венью доказывает его и НАЗЫВАЕТ источник', () => {
    const proof = proveCandleVenue({ datasetRef: 'smoke-btc-1m', candleVenue: 'bybit' });
    expect(proof).toEqual({
      proven: true,
      venue: 'bybit',
      source: 'dataset_metadata:smoke-btc-1m',
    });
  });

  it('недоказанное венью отвергает прогон ЦЕЛИКОМ, даже если строки совпали бы', () => {
    // Требование просит binance; будь венью просто строкой 'binance', проверка совпала бы и
    // зеленела. Доказательства нет — значит сверять не с чем, и совпадение строк ничего не значит.
    const out = admitActorMarketData(strategyWith([supported()]), {
      ...TAPE,
      candleVenue: proveCandleVenue({ datasetRef: 'smoke-btc-1m' }),
    });
    expect(out.refusal?.code).toBe('unsupported_lifecycle');
    expect(out.refusal?.message).toMatch(/происхождение свечей не доказано/);
    expect(out.bindings).toBeUndefined();
  });
});

describe('lookback — это ПРОГРЕВ, а не пропуск: граница торговых прав', () => {
  it('порог равен объявленному lookback', () => {
    expect(admitted([supported({ lookback: 5 })]).tradingFromBarIndex).toBe(5);
  });

  it('lookback: 0 — торговля с первого же события', () => {
    const out = admitted([supported({ lookback: 0 })]);
    expect(out.tradingFromBarIndex).toBe(0);
    expect(readinessAtBar(0, out.tradingFromBarIndex)).toBe('ready');
  });

  it('lookback === barCount — вся лента доставляется, торговых баров ноль', () => {
    // Это НЕ отказ: прогрев выполним и выполнен, торговать после него просто не на чем.
    const out = admitted([supported({ lookback: TAPE.barCount })]);
    expect(out.tradingFromBarIndex).toBe(TAPE.barCount);
    // Последний бар ленты — всё ещё прогрев, значит торговых баров действительно нет ни одного.
    expect(readinessAtBar(TAPE.barCount - 1, out.tradingFromBarIndex)).toBe('warming_up');
  });

  it('порог — МАКСИМУМ по требованиям, а не первый и не сумма', () => {
    // `readiness` у актора одна на всех; актор готов, когда набрана история КАЖДОГО требования.
    // Первый дал бы права раньше времени, сумма — позже, и оба молча.
    const out = admitted([
      supported({ id: 'short', lookback: 3 }),
      supported({ id: 'long', lookback: 20 }),
      supported({ id: 'mid', lookback: 8 }),
    ]);
    expect(out.tradingFromBarIndex).toBe(20);
  });

  it('граница readiness проходит РОВНО по индексу порога', () => {
    // Сдвиг на единицу здесь стоит одного торгового бара и не виден ни в одном числе результата.
    expect(readinessAtBar(4, 5)).toBe('warming_up');
    expect(readinessAtBar(5, 5)).toBe('ready');
    expect(readinessAtBar(6, 5)).toBe('ready');
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

  it('своё венью допускается — иначе проверка венью зеленела бы, отвергая любое', () => {
    const bybitTape: ActorTapeCapabilities = {
      ...TAPE,
      candleVenue: proveCandleVenue({ datasetRef: 'probe-fixture-1m', candleVenue: 'bybit' }),
    };
    expect(admitActorMarketData(strategyWith([supported()]), bybitTape).refusal?.message).toMatch(
      /просит венью binance, а свечи прогона с bybit/,
    );
    // …и ровно та же стратегия на своей ленте проходит.
    expect(
      admitActorMarketData(
        strategyWith([
          supported({ instrument: { venue: 'bybit', symbol: 'BTCUSDT' } } as Partial<MarketDataRequirement>),
        ]),
        bybitTape,
      ).refusal,
    ).toBeNull();
  });

  it('не-event-driven манифест сюда не попадает — решает вызывающий, а не эта функция', () => {
    // Функция намеренно НЕ спрашивает про lifecycle: её вызывают уже после `admitActorRun`, и
    // вторая проверка того же условия рано или поздно разойдётся с первой.
    expect(admitActorMarketData(strategyWith([supported()]), TAPE).refusal).toBeNull();
  });
});
