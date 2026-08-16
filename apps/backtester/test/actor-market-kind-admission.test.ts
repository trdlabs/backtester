// ДОПУСК РЫНОЧНЫХ ВИДОВ: четыре агрегированных вида рядом со свечами, и каждое отличие названо.
//
// ═══ ПОЧЕМУ ЭТО НЕ «КАК СВЕЧИ, ТОЛЬКО ДЛЯ ОСТАЛЬНЫХ» ═══
//
// Провенанс у видов РАЗНЫЙ, и это свойство записи, а не бэктестера. Венью-специфична в каноне
// только свеча; OI, ликвидации, taker и funding кросс-биржевые ПО ПОСТРОЕНИЮ — подтверждено кодом
// рекордера (control-center, `docs/operations/evidence/2026-08-17-canonical-row-provenance-by-code.md`):
// у трёх из них валидность гейтится счётом источников, а ликвидации приходят списком срезов,
// типизированных биржей, и складываются.
//
// Отсюда две оси вместо одной. `instrument.venue` называет ИНСТРУМЕНТ, `scope` говорит, венью ли
// локально ЗНАЧЕНИЕ. Спутать их дорого в обе стороны: сверять venue агрегата с доказанным
// происхождением свечей значило бы требовать от кросс-биржевой величины того, чего у неё нет; не
// сверять вовсе — принять заявление, которого никто не обслуживает.
//
// ═══ ТРЕТЬЕ СОСТОЯНИЕ ПОКРЫТИЯ ═══
//
// «Вид не несётся лентой» и «несётся, но пусто» — РАЗНЫЕ состояния, и слить их нельзя. Пустое
// наблюдение законно: у taker `{0,0}` при `has_taker_flow: true` это наблюдение, а не отсутствие.
// Отвергать пустое значило бы отвергать законные ленты; обещать отсутствующее — заставить стратегию
// ждать событий, которых не будет никогда, при внешне здоровом прогоне.

import { describe, expect, it } from 'vitest';
import { CONTRACT_VERSION } from '@trading/research-contracts/research';
import type { MarketDataRequirement } from '@trdlabs/sdk/research-contract';

import { admitActorMarketData, proveCandleVenue } from '../src/engine/actor/admission.js';
import type {
  ActorAggregateKind,
  ActorAggregateRequirement,
  ActorTapeCapabilities,
} from '../src/engine/actor/admission.js';
import type { ResolvedStrategy } from '../src/engine/artifacts.js';

const MINUTE_US = 60_000_000;
const PROVEN = proveCandleVenue({ datasetRef: 'kind-fixture-1m', candleVenue: 'bybit' });

/** Лента, несущая ровно названные виды. Умолчания нет намеренно: состав объявляется каждой пробой. */
const tapeCarrying = (...kinds: readonly ActorAggregateKind[]): ActorTapeCapabilities => ({
  candleVenue: PROVEN,
  symbol: 'BTCUSDT',
  barIntervalUs: MINUTE_US,
  barCount: 100,
  carries: (k) => kinds.includes(k),
});

const candles = (): MarketDataRequirement =>
  ({
    kind: 'candles',
    id: 'req-candles',
    instrument: { venue: 'bybit', symbol: 'BTCUSDT' },
    interval: MINUTE_US,
    lookback: 5,
    revisionPolicy: { mode: 'final_only' },
    priceType: 'trade',
  }) as MarketDataRequirement;

const aggregate = (
  kind: ActorAggregateKind,
  over: Record<string, unknown> = {},
): MarketDataRequirement =>
  ({
    kind,
    id: `req-${kind}`,
    instrument: { venue: 'bybit', symbol: 'BTCUSDT' },
    interval: MINUTE_US,
    lookback: 5,
    revisionPolicy: { mode: 'final_only' },
    scope: 'aggregate',
    ...(kind === 'open_interest' || kind === 'taker_volume' ? { unit: 'usd' } : {}),
    ...(kind === 'funding' ? { form: 'rate' } : {}),
    ...over,
  }) as MarketDataRequirement;

const strategyWith = (marketData: readonly MarketDataRequirement[]): ResolvedStrategy =>
  ({
    manifest: {
      id: 'kind-probe',
      version: '1.0.0',
      kind: 'strategy',
      contractVersion: CONTRACT_VERSION,
      lifecycle: 'event_driven',
      marketData,
    },
    module: {},
  }) as unknown as ResolvedStrategy;

const ALL: readonly ActorAggregateKind[] = ['open_interest', 'liquidations', 'taker_volume', 'funding'];

describe('агрегированные виды допускаются, когда лента их несёт', () => {
  it.each(ALL)('вид «%s» допущен и НАЗВАН подпиской', (kind) => {
    const out = admitActorMarketData(strategyWith([candles(), aggregate(kind)]), tapeCarrying(kind));
    if (out.refusal !== null) throw new Error(`ожидался допуск, получен отказ: ${out.refusal.message}`);

    // Подписка обязана существовать И называть свой вид: дескриптор — единственная связь события с
    // тем, чем оно разрешено, и вид в нём не декоративен.
    // Сужение по наличию поля, а не приведение: список подписок несёт и ХОСТОВЫЙ дескриптор, у
    // которого `requirementId` нет вовсе (события хоста не разрешены ничьим требованием). Приведение
    // здесь прошло бы компиляцию и молча сравнивало бы `undefined`.
    const mine = out.subscriptions.find((s) => 'requirementId' in s && s.requirementId === `req-${kind}`);
    expect(mine?.kind).toBe(kind);

    // Нормализованное требование — СНИМОК, и он обязан нести scope: без него читатель не отличит
    // «агрегат» от «венью-локального», а второе лента обслужить не может.
    const binding = out.bindings.find((b) => b.requirement.id === `req-${kind}`);
    const req = binding?.requirement as ActorAggregateRequirement | undefined;
    expect(req?.scope).toBe('aggregate');
    expect(req?.revisions).toBe('final_only');
  });

  it('ПРОВЕРКА ПРОВЕРКИ: та же лента без вида даёт ОТКАЗ', () => {
    // Иначе пробы выше зеленели бы и при допуске, который состава ленты вообще не смотрит.
    const out = admitActorMarketData(
      strategyWith([candles(), aggregate('open_interest')]),
      tapeCarrying('funding'),
    );
    expect(out.refusal?.message).toMatch(/лента прогона его не несёт вовсе/);
  });

  it('unit и form нормализованы, а не скопированы как есть', () => {
    const out = admitActorMarketData(
      strategyWith([candles(), aggregate('open_interest'), aggregate('funding')]),
      tapeCarrying('open_interest', 'funding'),
    );
    if (out.refusal !== null) throw new Error(out.refusal.message);
    const oi = out.bindings.find((b) => b.requirement.id === 'req-open_interest')!
      .requirement as ActorAggregateRequirement;
    const fund = out.bindings.find((b) => b.requirement.id === 'req-funding')!
      .requirement as ActorAggregateRequirement;
    expect(oi.unit).toBe('usd');
    expect(oi.form).toBeUndefined();
    expect(fund.form).toBe('rate');
    expect(fund.unit).toBeUndefined();
  });
});

describe('третье состояние: «не несётся» и «несётся, но пусто» — РАЗНОЕ', () => {
  it('вид несётся с нулевым покрытием — ДОПУСК, а не отказ', () => {
    // Состав ленты и покрытие — разные вопросы. `carries` отвечает на первый; пустая минута
    // отвечает на второй и законна. Отвергать её значило бы отвергать честную ленту за то, что
    // рынок в этот час молчал.
    const out = admitActorMarketData(
      strategyWith([candles(), aggregate('liquidations')]),
      tapeCarrying('liquidations'),
    );
    expect(out.refusal).toBeNull();
  });

  it('вид не несётся — ОТКАЗ, и он говорит про состав, а не про покрытие', () => {
    const out = admitActorMarketData(
      strategyWith([candles(), aggregate('liquidations')]),
      tapeCarrying(),
    );
    expect(out.refusal?.message).toMatch(/лента прогона его не несёт вовсе/);
    // Отказ обязан САМ отличать себя от пустого покрытия — иначе читатель пойдёт искать данные там,
    // где их не обещали.
    expect(out.refusal?.message).toMatch(/Пустое покрытие — законное состояние/);
  });
});

describe('scope: по-источниковых значений архив не хранит', () => {
  it.each(ALL)('scope «venue» у «%s» отвергается ХОСТОМ', (kind) => {
    const out = admitActorMarketData(
      strategyWith([candles(), aggregate(kind, { scope: 'venue' })]),
      tapeCarrying(kind),
    );
    expect(out.refusal?.message).toMatch(/просит scope «venue»/);
    expect(out.refusal?.message).toMatch(/свойство записи, а не пробел реализации/);
  });
});

describe('единицы и формы, которых у ленты нет', () => {
  it.each(['base', 'quote'] as const)('open_interest в «%s» отвергается — лента несёт USD', (unit) => {
    const out = admitActorMarketData(
      strategyWith([candles(), aggregate('open_interest', { unit })]),
      tapeCarrying('open_interest'),
    );
    expect(out.refusal?.message).toMatch(/лента несёт этот вид только в USD/);
  });

  it('taker_volume в базовой валюте отвергается по той же причине', () => {
    const out = admitActorMarketData(
      strategyWith([candles(), aggregate('taker_volume', { unit: 'base' })]),
      tapeCarrying('taker_volume'),
    );
    expect(out.refusal?.message).toMatch(/лента несёт этот вид только в USD/);
  });

  it('funding form «settlement» отвергается — колонки в архиве нет', () => {
    const out = admitActorMarketData(
      strategyWith([candles(), aggregate('funding', { form: 'settlement' })]),
      tapeCarrying('funding'),
    );
    expect(out.refusal?.message).toMatch(/колонки\s+settlement в архиве физически нет/);
  });
});

describe('венью агрегата — идентичность инструмента, и отказ обязан это говорить', () => {
  it('чужой инструмент отвергается, но НЕ как проблема происхождения', () => {
    // Разница не косметическая. Прочитав отказ как «происхождение не доказано», диагност пойдёт
    // чинить метаданные датасета — а чинить надо требование стратегии. У кросс-биржевой величины
    // происхождения нет вовсе, и обещать его проверку нельзя.
    const out = admitActorMarketData(
      strategyWith([
        candles(),
        aggregate('open_interest', { instrument: { venue: 'binance', symbol: 'BTCUSDT' } }),
      ]),
      tapeCarrying('open_interest'),
    );
    expect(out.refusal?.message).toMatch(/несовпадение ИНСТРУМЕНТА, а не происхождения/);
    expect(out.refusal?.message).toMatch(/кросс-биржевое по построению/);
    expect(out.refusal?.message).not.toMatch(/происхождение свечей не доказано/);
  });

  it('у СВЕЧЕЙ то же несовпадение остаётся отказом о ПРОИСХОЖДЕНИИ', () => {
    // Проверка проверки для пробы выше: два вида дают два разных диагноза на одном и том же
    // формальном несовпадении, и это именно то, ради чего оси разведены.
    const out = admitActorMarketData(
      strategyWith([
        { ...(candles() as object), instrument: { venue: 'binance', symbol: 'BTCUSDT' } } as MarketDataRequirement,
      ]),
      tapeCarrying(),
    );
    expect(out.refusal?.message).toMatch(/у разных венью различаются и цены, и комиссии, и funding/);
  });
});

describe('свечи не задеты', () => {
  it('candle-only манифест допускается на ленте без единого агрегата', () => {
    const out = admitActorMarketData(strategyWith([candles()]), tapeCarrying());
    expect(out.refusal).toBeNull();
  });
});
