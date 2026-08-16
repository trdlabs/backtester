// ДОСТАВКА РЫНОЧНЫХ ВИДОВ: события агрегатов, разрыв наблюдаемости и нормативный порядок.
//
// ═══ ОТСУТСТВИЕ ВЫРАЖАЕТСЯ ОДНИМ КАНАЛОМ ═══
//
// Контракт (§3.11.2) запрещает событию вида нести «данных не было»: это самопротиворечивое
// высказывание — «наблюдено, что бакета не было». Поэтому событие вида несёт ТОЛЬКО present, а
// пропуск выражается `market.subscription.status_changed` со `state: 'gap'` — и РОВНО ОДИН РАЗ на
// переходе. Повтор на каждом пустом frontier превратил бы сигнал об изменении в шум на каждом тике.
//
// ═══ ПОРЯДОК ЗАДАЁТ ДВИЖОК ═══
//
// §3.8.2 (`MARKET_KIND_RANK`: open_interest первым, свеча последней) применяет `orderFrontier`
// движка по полю `marketKind`. Своя сортировка в раннере была бы второй реализацией нормативного
// порядка и разошлась бы с движковой молча — обе «работают».

import { describe, expect, it } from 'vitest';
import { CONTRACT_VERSION } from '@trading/research-contracts/research';
import { timestampUsFromMillis } from '@trdlabs/sdk/research-contract';
import type {
  ActorCommand,
  ActorInputEvent,
  MarketDataRequirement,
} from '@trdlabs/sdk/research-contract';

import { admitActorMarketData, proveCandleVenue } from '../src/engine/actor/admission.js';
import type { ActorTapeCapabilities } from '../src/engine/actor/admission.js';
import { runEventDrivenSymbol } from '../src/engine/actor/run-symbol.js';
import { marketPhaseFor } from '../src/engine/actor/frontier-runner.js';
import type { ActorBar } from '../src/engine/actor/frontier-runner.js';
import type {
  ActorExecutionHandle,
  ActorLifecycleExecutor,
} from '../src/engine/actor/execution-handle.js';
import type { ResolvedStrategy } from '../src/engine/artifacts.js';
import { riskBinding } from './helpers/actor-risk.js';

const MINUTE_MS = 60_000;
const MINUTE_US = 60_000_000;
const T0 = 1_700_000_000_000;

/** Бар с объявленным наблюдением OI ровно на тех минутах, что перечислены. */
const barsWithOi = (n: number, oiAt: readonly number[]): readonly ActorBar[] =>
  Array.from({ length: n }, (_, i) => ({
    tsUs: timestampUsFromMillis(T0 + i * MINUTE_MS),
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    // Ненулевой и РАЗНЫЙ по барам: константа не отличила бы «доставили объём» от «доставили ноль».
    volume: 10 + i,
    ...(oiAt.includes(i) ? { aggregates: { openInterest: { oiTotalUsd: 1_000 + i } } } : {}),
  }));

const req = (kind: string, id: string, extra: Record<string, unknown> = {}): MarketDataRequirement =>
  ({
    kind,
    id,
    instrument: { venue: 'bybit', symbol: 'BTCUSDT' },
    interval: MINUTE_US,
    lookback: 0,
    revisionPolicy: { mode: 'final_only' },
    ...extra,
  }) as MarketDataRequirement;

const strategy = (): ResolvedStrategy =>
  ({
    manifest: {
      id: 'delivery-probe',
      version: '1.0.0',
      kind: 'strategy',
      contractVersion: CONTRACT_VERSION,
      lifecycle: 'event_driven',
      marketData: [
        req('candles', 'req-candles', { priceType: 'trade' }),
        req('open_interest', 'req-oi', { scope: 'aggregate', unit: 'usd' }),
      ],
    },
    module: {},
  }) as unknown as ResolvedStrategy;

/** Прогон, отдающий ПОЛНЫЙ список доставленных событий в порядке доставки. */
async function deliver(bars: readonly ActorBar[]): Promise<readonly ActorInputEvent[]> {
  const seen: ActorInputEvent[] = [];
  const handle = { __actorExecutionHandle: 'ActorExecutionHandle' } as unknown as ActorExecutionHandle;
  const executor: ActorLifecycleExecutor = {
    createActor: async () => handle,
    executeActorEvent: async (_h, event): Promise<readonly ActorCommand[]> => {
      seen.push(event);
      return [];
    },
    disposeActor: async () => {},
  };

  const tape: ActorTapeCapabilities = {
    candleVenue: proveCandleVenue({ datasetRef: 'delivery-fixture-1m', candleVenue: 'bybit' }),
    symbol: 'BTCUSDT',
    barIntervalUs: MINUTE_US,
    barCount: bars.length,
    // Лента НЕСЁТ open interest — иначе допуск отверг бы прогон по составу, и проба доставки
    // никогда бы не выполнилась.
    carries: (k) => k === 'open_interest',
  };
  const admission = admitActorMarketData(strategy(), tape);
  if (admission.refusal !== null) throw new Error(`фикстура не прошла допуск: ${admission.refusal.message}`);

  await runEventDrivenSymbol({
    executor,
    source: { manifest: strategy().manifest, module: {} },
    actorId: 'actor-btcusdt',
    symbol: 'BTCUSDT',
    seed: 1,
    params: {},
    admission,
    bars,
    costs: { feeBps: 0, slippageBps: 0, initialEquity: 10_000 },
    risk: riskBinding(10_000),
  });
  return seen;
}

const kinds = (events: readonly ActorInputEvent[]): readonly string[] => events.map((e) => e.kind);

describe('наблюдение доставляется событием своего вида', () => {
  it('OI приходит с наблюдённым значением, а не с нулём', async () => {
    const events = await deliver(barsWithOi(2, [0, 1]));
    const oi = events.filter((e) => e.kind === 'market.open_interest.observed');
    expect(oi).toHaveLength(2);
    expect((oi[0] as { oi: { value: { oiTotalUsd: number } } }).oi.value.oiTotalUsd).toBe(1_000);
    expect((oi[1] as { oi: { value: { oiTotalUsd: number } } }).oi.value.oiTotalUsd).toBe(1_001);
  });

  it('объём свечи — НАБЛЮДЁННЫЙ, а не константа', async () => {
    // До этого среза событие свечи уезжало с `volume: 0` на каждом баре. Ноль — законный объём,
    // поэтому автор, торгующий по объёму, видел бы «рынок стоял» и не имел бы способа это заметить.
    const events = await deliver(barsWithOi(2, []));
    const candles = events.filter((e) => e.kind === 'market.candle.closed');
    expect(candles.map((c) => (c as { candle: { value: { volume: number } } }).candle.value.volume)).toEqual([
      10, 11,
    ]);
  });

  it('агрегированная подписка НЕ получает свечу', async () => {
    // Свечной цикл шлёт событие на каждый элемент списка биндингов; без разделения по виду
    // подписка на OI получила бы `market.candle.closed` со своим subscriptionId.
    const events = await deliver(barsWithOi(1, [0]));
    expect(kinds(events).filter((k) => k === 'market.candle.closed')).toHaveLength(1);
  });
});

describe('пропуск наблюдения — РОВНО одно событие статуса на переходе', () => {
  it('первый разрыв объявляется один раз и не повторяется', async () => {
    // Наблюдения на баре 0, дальше три пустых. Событий статуса обязано быть ОДНО, а не три.
    const events = await deliver(barsWithOi(4, [0]));
    const status = events.filter((e) => e.kind === 'market.subscription.status_changed');
    expect(status).toHaveLength(1);
    const s = (status[0] as { status: { state: string; expectedTsUs: number; lastObservedTsUs?: number } }).status;
    expect(s.state).toBe('gap');
    // Первая ОЖИДАЕМАЯ, но не пришедшая точка — бар 1, а не момент детекции и не последний бар.
    expect(Number(s.expectedTsUs)).toBe(Number(timestampUsFromMillis(T0 + MINUTE_MS)));
    expect(Number(s.lastObservedTsUs)).toBe(Number(timestampUsFromMillis(T0)));
  });

  it('самый первый разрыв в жизни подписки НЕ несёт последнего наблюдения', async () => {
    // Ключа нет, а не «ноль» и не «unknown»: наблюдения не было вовсе, и выдумывать координату
    // значило бы дать диагносту ложную опору.
    const events = await deliver(barsWithOi(2, []));
    const status = events.filter((e) => e.kind === 'market.subscription.status_changed');
    expect(status).toHaveLength(1);
    const s = (status[0] as { status: Record<string, unknown> }).status;
    expect(Object.prototype.hasOwnProperty.call(s, 'lastObservedTsUs')).toBe(false);
  });

  it('возврат наблюдения закрывает разрыв, и следующий пропуск объявляется ЗАНОВО', async () => {
    // Наблюдения на 0 и 2; пропуски на 1 и 3. Два разных разрыва — два события статуса.
    const events = await deliver(barsWithOi(4, [0, 2]));
    expect(events.filter((e) => e.kind === 'market.subscription.status_changed')).toHaveLength(2);
    // Возврат отдельным событием НЕ объявляется: само появление следующего события вида уже
    // сигнализирует возврат, и «gap ended» дублировало бы то, что поток несёт и так.
    expect(kinds(events)).not.toContain('market.subscription.status_ended');
  });
});

describe('нормативная ФАЗА §3.8.1 — не выводится из порядка', () => {
  // ЭТА ПРОБА НЕЗАМЕНИМА ПРОБОЙ НА ПОРЯДОК, и в этом весь её смысл. Спека нормирует РАСПАД слота
  // «bar» на фазы 3 (`market`) и 4 (`candle`), а не старшинство рангов внутри одной фазы. Движок
  // говорит это дословно: «обе кодировки дали бы сегодня один и тот же порядок, но фаза — это то,
  // что нормировано, а совпадение результата с альтернативной кодировкой случайно и не обязано
  // пережить следующий вид данных».
  //
  // Значит зелёная проба «OI раньше свечи» НЕ доказывает правильной кодировки: она зелена и при
  // неверной. Различает только сама фаза — поэтому она и пиннится напрямую.

  it('агрегат идёт фазой market, свеча — фазой candle', () => {
    expect(marketPhaseFor('open_interest')).toBe('market');
    expect(marketPhaseFor('liquidations')).toBe('market');
    expect(marketPhaseFor('taker_volume')).toBe('market');
    expect(marketPhaseFor('funding')).toBe('market');
    expect(marketPhaseFor('candles')).toBe('candle');
  });

  it('ПРОВЕРКА ПРОВЕРКИ: две фазы РАЗНЫЕ', () => {
    // Иначе проба выше зеленела бы и на функции, возвращающей одно значение всегда.
    expect(marketPhaseFor('open_interest')).not.toBe(marketPhaseFor('candles'));
  });
});

describe('нормативный порядок §3.8.2', () => {
  it('внутри frontier OI приходит РАНЬШЕ свечи', async () => {
    const events = await deliver(barsWithOi(1, [0]));
    const order = kinds(events).filter(
      (k) => k === 'market.open_interest.observed' || k === 'market.candle.closed',
    );
    expect(order).toEqual(['market.open_interest.observed', 'market.candle.closed']);
  });

  it('ПРОВЕРКА ПРОВЕРКИ: оба события действительно доставлены', async () => {
    // Иначе проба выше зеленела бы на списке из одного элемента или пустом.
    const events = await deliver(barsWithOi(1, [0]));
    expect(kinds(events)).toContain('market.open_interest.observed');
    expect(kinds(events)).toContain('market.candle.closed');
  });
});
