// ГЕЙТЫ АГРЕГАЦИИ И ГРАНИЦЫ СЕРИАЛИЗАЦИИ (083 S3).
//
// `seq` и `subscriptionId` АКТОР-ЛОКАЛЬНЫ. У двух акторов одного прогона они совпадают по значению
// и означают разное: `seq: 7` первого и `seq: 7` второго — два разных события. Слияние их потоков
// по одному `seq` даёт правдоподобную ленту, описывающую историю, которой не было, — и это самый
// дорогой вид дефекта, потому что результат выглядит нормально.
//
// ЗА ГРАНИЦЕЙ СЕРИАЛИЗАЦИИ идентичности объектов НЕТ по построению: десериализация всегда порождает
// новые. Требовать её там значило бы написать гейт, который не может пройти. Проверяется другое:
// каноническое СОДЕРЖИМОЕ, ПОРЯДОК и неизменяемость восстановленного в рантайме.

import { describe, expect, it } from 'vitest';
import { CONTRACT_VERSION } from '@trading/research-contracts/research';
import type { ActorCommand, ActorInputEvent, MarketDataRequirement } from '@trdlabs/sdk/research-contract';
import { timestampUsFromMillis } from '@trdlabs/sdk/research-contract';
import { canonicalJson } from '@trdlabs/engine';

import { admitActorMarketData, proveCandleVenue } from '../src/engine/actor/admission.js';
import { aggregateActorRuns, serializeAggregatedTimeline } from '../src/engine/actor/aggregate.js';
import { runEventDrivenSymbol } from '../src/engine/actor/run-symbol.js';
import { buildActorInit } from '../src/engine/actor/run-symbol.js';
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

const bars = (n: number, base: number): readonly ActorBar[] =>
  Array.from({ length: n }, (_, i) => ({
    tsUs: timestampUsFromMillis(T0 + i * MINUTE_MS),
    open: base + i,
    high: base + 1 + i,
    low: base - 1 + i,
    close: base + 0.5 + i,
  }));

const strategyFor = (symbol: string): ResolvedStrategy =>
  ({
    manifest: {
      id: 'aggregate-probe',
      version: '1.0.0',
      kind: 'strategy',
      contractVersion: CONTRACT_VERSION,
      lifecycle: 'event_driven',
      marketData: [
        {
          kind: 'candles',
          id: 'req-candles',
          instrument: { venue: 'bybit', symbol },
          interval: MINUTE_US,
          lookback: 0,
          revisionPolicy: { mode: 'final_only' },
          priceType: 'trade',
        } as unknown as MarketDataRequirement,
      ],
    },
    module: {},
  }) as unknown as ResolvedStrategy;

async function runOne(symbol: string, actorId: string, base: number): Promise<ActorExecutionRecord> {
  const handle = { __h: actorId } as unknown as ActorExecutionHandle;
  let placed = false;
  const executor: ActorLifecycleExecutor = {
    createActor: async () => handle,
    executeActorEvent: async (_h, event: ActorInputEvent) => {
      if (event.kind !== 'market.candle.closed' || placed) return [];
      placed = true;
      return [
        { kind: 'place', type: 'market', clientOrderId: `${actorId}-o1`, side: 'buy', qtyUsd: 500 } as ActorCommand,
      ];
    },
    disposeActor: async () => {},
  };
  const admission = admitActorMarketData(strategyFor(symbol), {
    candleVenue: proveCandleVenue({ datasetRef: 'aggregate-fixture-1m', candleVenue: 'bybit' }),
    symbol,
    barIntervalUs: MINUTE_US,
    barCount: 4,
    // Лента этих проб — только свечи: агрегатов она не несёт, и допуск обязан это
    // увидеть, а не додумать. Значение явное, потому что дефолта у поля нет.
    carries: () => false,
  });
  if (admission.refusal !== null) throw new Error(admission.refusal.message);
  return runEventDrivenSymbol({
    executor,
    source: { manifest: strategyFor(symbol).manifest, module: {} },
    actorId,
    symbol,
    seed: 1,
    params: {},
    admission,
    bars: bars(4, base),
    costs: { feeBps: 5, slippageBps: 0, initialEquity: 10_000 },
    risk: riskBinding(10_000),
  });
}

describe('агрегация нескольких акторов сохраняет идентичность', () => {
  it('одинаковые локальные seq двух акторов НЕ склеиваются', async () => {
    const btc = await runOne('BTCUSDT', 'actor-btc', 100);
    const eth = await runOne('ETHUSDT', 'actor-eth', 50);

    // Предпосылка пробы: номера действительно пересекаются. Без неё тест доказывал бы пустое.
    const btcSeqs = btc.timeline.map((e) => e.envelope.seq);
    const ethSeqs = eth.timeline.map((e) => e.envelope.seq);
    expect(btcSeqs.some((s) => ethSeqs.includes(s))).toBe(true);

    const merged = aggregateActorRuns([btc, eth]);
    // Ни одна строка не потерялась и ни одна не слилась.
    expect(merged.timeline).toHaveLength(btc.timeline.length + eth.timeline.length);
    // Каждая пара (actorId, seq) уникальна — а пара (seq) сама по себе нет.
    const pairs = merged.timeline.map((r) => `${r.actorId}#${r.seq}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    expect(new Set(merged.timeline.map((r) => r.seq)).size).toBeLessThan(pairs.length);
  });

  it('порядок внутри каждого актора остаётся его собственным и непрерывным', async () => {
    const merged = aggregateActorRuns([
      await runOne('BTCUSDT', 'actor-btc', 100),
      await runOne('ETHUSDT', 'actor-eth', 50),
    ]);
    for (const actorId of ['actor-btc', 'actor-eth']) {
      const seqs = merged.timeline.filter((r) => r.actorId === actorId).map((r) => r.seq);
      expect(seqs).toEqual(seqs.map((_, i) => i));
    }
  });

  it('подписки остаются привязаны к своему актору', async () => {
    const merged = aggregateActorRuns([
      await runOne('BTCUSDT', 'actor-btc', 100),
      await runOne('ETHUSDT', 'actor-eth', 50),
    ]);
    // `subscriptionId` выводится из requirementId и у обоих акторов ОДИН И ТОТ ЖЕ по значению —
    // ровно поэтому строка обязана нести ещё и символ с actorId.
    const bySymbol = new Map(merged.perActor.map((a) => [a.symbol, a.actorId]));
    expect(bySymbol.get('BTCUSDT')).toBe('actor-btc');
    expect(bySymbol.get('ETHUSDT')).toBe('actor-eth');
    for (const row of merged.timeline) {
      expect(bySymbol.get(row.symbol)).toBe(row.actorId);
    }
  });

  it('повтор actorId отвергается', async () => {
    // Разметка — единственное, что различает потоки; при её повторе агрегат теряет смысл молча.
    const one = await runOne('BTCUSDT', 'actor-dup', 100);
    const two = await runOne('ETHUSDT', 'actor-dup', 50);
    expect(() => aggregateActorRuns([one, two])).toThrow(/встречается дважды/);
  });

  it('артефакты считаются на КАЖДОГО актора отдельно', async () => {
    const merged = aggregateActorRuns([
      await runOne('BTCUSDT', 'actor-btc', 100),
      await runOne('ETHUSDT', 'actor-eth', 50),
    ]);
    expect(merged.perActor).toHaveLength(2);
    for (const actor of merged.perActor) {
      expect(actor.artifacts.equityCurve).toHaveLength(4);
      expect(actor.artifacts.orders).toHaveLength(1);
    }
    // И цифры разные: ленты разные, значит общий агрегат не подменил их одной.
    const [a, b] = merged.perActor;
    expect(a!.artifacts.fills).toHaveLength(1);
    expect(a!.artifacts.fills[0]!.fillPrice).not.toBe(b!.artifacts.fills[0]!.fillPrice);
  });
});

describe('граница сериализации: содержимое, порядок, неизменяемость — но НЕ идентичность', () => {
  it('ActorInit переживает JSON без потерь содержимого и порядка', async () => {
    const admission = admitActorMarketData(strategyFor('BTCUSDT'), {
      candleVenue: proveCandleVenue({ datasetRef: 'aggregate-fixture-1m', candleVenue: 'bybit' }),
      symbol: 'BTCUSDT',
      barIntervalUs: MINUTE_US,
      barCount: 4,
      // Лента этих проб — только свечи: агрегатов она не несёт, и допуск обязан это
      // увидеть, а не додумать. Значение явное, потому что дефолта у поля нет.
      carries: () => false,
    });
    if (admission.refusal !== null) throw new Error(admission.refusal.message);
    const init = buildActorInit({
      executor: {} as ActorLifecycleExecutor,
      source: { manifest: strategyFor('BTCUSDT').manifest },
      actorId: 'actor-btc',
      symbol: 'BTCUSDT',
      seed: 3,
      params: { a: 1 },
      admission,
    });

    const revived = JSON.parse(JSON.stringify(init)) as typeof init;

    // Идентичность НЕ проверяется: за границей её нет по построению.
    expect(revived.subscriptions).not.toBe(init.subscriptions);
    // Проверяется каноническое содержимое…
    expect(canonicalJson(revived)).toBe(canonicalJson(init));
    // …и порядок, отдельно от содержимого: множество то же, а последовательность могла бы уехать.
    expect(revived.subscriptions.map((s) => s.subscriptionId)).toEqual(
      init.subscriptions.map((s) => s.subscriptionId),
    );
  });

  it('восстановленный ActorInit обязан быть заморожен ПОТРЕБИТЕЛЕМ', async () => {
    // Заморозка не переживает JSON — это свойство рантайма, а не значения. Значит сторона, которая
    // приняла десериализованное, обязана заморозить его сама; иначе за границей появляется
    // изменяемый список подписок, и «состав объявлен один раз» перестаёт быть правдой.
    const raw = JSON.parse('{"subscriptions":[{"subscriptionId":"sub-a","kind":"candles","requirementId":"a"}]}');
    expect(Object.isFrozen(raw.subscriptions)).toBe(false);

    const adopted = Object.freeze(raw.subscriptions.map((s: unknown) => Object.freeze(s)));
    expect(Object.isFrozen(adopted)).toBe(true);
    expect(() => (adopted as unknown[]).push({})).toThrow(TypeError);
    expect(Object.isFrozen(adopted[0])).toBe(true);
  });

  it('объединённый поток сериализуется вместе с разметкой', async () => {
    const merged = aggregateActorRuns([
      await runOne('BTCUSDT', 'actor-btc', 100),
      await runOne('ETHUSDT', 'actor-eth', 50),
    ]);
    const wire = serializeAggregatedTimeline(merged.timeline);
    // Поток без `actorId` невозможно разобрать обратно, а evidence, который нельзя разобрать,
    // доказывает только факт своего существования.
    expect(wire).toContain('actor-btc');
    expect(wire).toContain('actor-eth');
    // Канонический вид стабилен: повторная сериализация того же значения даёт ту же строку.
    expect(serializeAggregatedTimeline(merged.timeline)).toBe(wire);
    // И порядок строк переживает сериализацию.
    const revived = JSON.parse(wire) as { actorId: string; seq: number }[];
    expect(revived.map((r) => `${r.actorId}#${r.seq}`)).toEqual(
      merged.timeline.map((r) => `${r.actorId}#${r.seq}`),
    );
  });
});
