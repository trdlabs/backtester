// 083 S3 — продовая точка вызова actor-пути: от датасета до `RunAccumulators`.
//
// ЧТО ЗДЕСЬ НЕ РЕШАЕТСЯ. Формат результата прогона принадлежит `assembleResult` — единственному
// владельцу `BacktestRunResult` и `RunEvidence`. Здесь собирается ровно `RunAccumulators`, то есть
// тот же вход, который ему подаёт legacy-путь. Собрать результат «по-своему» значило бы завести
// вторую форму evidence, которая совпадает с первой сегодня и разойдётся завтра.
//
// ОДНА СЕМАНТИКА НА ОБА ТРАНСПОРТА. direct и thread различаются ИСПОЛНИТЕЛЕМ (`router.forStrategy`),
// а не путём: обе ветки проходят через эту функцию и через `assembleResult`. Развилки «если thread,
// то иначе» здесь нет и быть не должно — она и есть тот способ, которым транспорты расходятся.

import type { RiskDecision } from '@trdlabs/engine';

import type { CandleDataset } from '../dataset.js';
import type { ResolvedStrategy } from '../artifacts.js';
import type { RunAccumulators } from '../runner.js';
import {
  admitActorMarketData,
  proveCandleVenue,
  type ActorAdmissionRefusal,
  type ActorTapeCapabilities,
} from './admission.js';
import { aggregateActorRuns, type AggregatedActorRun } from './aggregate.js';
import type { ActorBar, ActorExecutionCosts } from './frontier-runner.js';
import { runEventDrivenSymbol } from './run-symbol.js';
import type { ActorLifecycleExecutor } from './execution-handle.js';
import type { ActorExecutionRecord } from './execution-record.js';

export interface ActorProductionInput {
  readonly strategy: ResolvedStrategy;
  readonly executor: ActorLifecycleExecutor;
  readonly dataset: CandleDataset;
  readonly symbols: readonly string[];
  readonly seed: number;
  readonly params: Readonly<Record<string, unknown>>;
  readonly costs: ActorExecutionCosts;
  /** Интервал бара ленты в микросекундах — из таймфрейма прогона, а не угадывается по данным. */
  readonly barIntervalUs: number;
}

export interface ActorProductionOutcome {
  readonly refusal: ActorAdmissionRefusal | null;
  readonly accumulators?: RunAccumulators;
  readonly barsProcessed?: number;
  readonly aggregate?: AggregatedActorRun;
  readonly records?: readonly ActorExecutionRecord[];
}

/** Идентификатор инстанса: один актор на символ в этом срезе, и это видно из имени. */
export function actorIdFor(symbol: string): string {
  return `actor-${symbol.toLowerCase()}`;
}

/**
 * Исполнить actor-путь для всех символов прогона.
 *
 * Fail-closed целиком: отказ ЛЮБОГО символа отменяет прогон, а не исключает символ. Частичный
 * прогон вернул бы результат, посчитанный по подмножеству запрошенного, и ничем бы об этом не
 * сообщил — числа получились бы правдоподобные.
 */
export async function runActorProduction(
  input: ActorProductionInput,
): Promise<ActorProductionOutcome> {
  // РАЗВИЛКА, КОТОРУЮ НЕ ЗАКРЫВАЕТ СПЕКА, И ПОТОМУ ЗДЕСЬ ОТКАЗ, А НЕ ДОГАДКА.
  //
  // У event-driven манифеста `marketData[].instrument` называет КОНКРЕТНЫЙ инструмент. При прогоне
  // на нескольких символах на каждый поднимается свой актор — и непонятно, что означают требования
  // манифеста для КАЖДОГО из них:
  //
  //   • «применять только совпавшие по символу» — тогда требование на символ вне прогона исчезает
  //     молча, и актор объявил вход, которого не получил;
  //   • «подставлять символ актора вместо объявленного» — тогда `instrument` в манифесте перестаёт
  //     что-либо значить, и стратегия, написанная под BTC, молча исполнится на ETH.
  //
  // Оба чтения меняют смысл публичного поля контракта. Выбор за владельцем спеки; до него
  // многосимвольный event-driven прогон отвергается целиком.
  if (input.symbols.length > 1) {
    return {
      refusal: {
        code: 'unsupported_lifecycle',
        path: '',
        message:
          `${input.strategy.manifest.id}@${input.strategy.manifest.version}: прогон запрошен на ` +
          `${input.symbols.length} символах, а lifecycle: 'event_driven' поднимает по актору на символ. ` +
          'Что означают объявленные `marketData[].instrument` для каждого из акторов, контракт не ' +
          'фиксирует: и «применять только совпавшие», и «подставлять символ актора» меняют смысл ' +
          'поля. Пока правило не выбрано, многосимвольный actor-прогон отвергается — молча выбрать ' +
          'одно из чтений значило бы отдать стратегии не тот вход, который она объявила',
      },
    };
  }

  const records: ActorExecutionRecord[] = [];
  let barsProcessed = 0;

  for (const symbol of input.symbols) {
    const candles = input.dataset.candles(symbol);
    const tape: ActorTapeCapabilities = {
      // Происхождение берётся у ДАТАСЕТА и доказывается прувером. Строка от вызывающего здесь
      // недопустима: она доказывала бы лишь то, что вызывающий её написал.
      candleVenue: proveCandleVenue({
        datasetRef: input.dataset.datasetRef,
        ...(input.dataset.candleVenue !== undefined ? { candleVenue: input.dataset.candleVenue } : {}),
      }),
      symbol,
      barIntervalUs: input.barIntervalUs,
      barCount: candles.length,
    };

    const admission = admitActorMarketData(input.strategy, tape);
    if (admission.refusal !== null) return { refusal: admission.refusal };

    const bars: readonly ActorBar[] = candles.map((c) => ({
      tsUs: (c.ts * 1000) as ActorBar['tsUs'],
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));

    records.push(
      await runEventDrivenSymbol({
        executor: input.executor,
        source: { manifest: input.strategy.manifest, module: input.strategy.module },
        actorId: actorIdFor(symbol),
        symbol,
        seed: input.seed,
        params: input.params,
        admission,
        bars,
        costs: input.costs,
      }),
    );
    barsProcessed += candles.length;
  }

  const aggregate = aggregateActorRuns(records);

  // Сведение в тот же аккумулятор, который потребляет `assembleResult`. Порядок — по акторам, как
  // они предъявлены: перемешивать записи разных акторов по времени здесь нельзя, у них нет общей оси.
  const acc: RunAccumulators = {
    decisionRecords: [],
    orders: [],
    orderIndex: new Map(),
    fills: [],
    riskDecisions: [],
    trades: [],
    equityCurve: [],
    fundingLedger: [],
    validationIssues: [],
  };
  for (const actor of aggregate.perActor) {
    acc.decisionRecords.push(...actor.artifacts.decisionRecords);
    acc.orders.push(...actor.artifacts.orders);
    acc.fills.push(...actor.artifacts.fills);
    acc.riskDecisions.push(...(actor.artifacts.riskDecisions as RiskDecision[]));
    acc.trades.push(...actor.artifacts.trades);
    acc.equityCurve.push(...actor.artifacts.equityCurve);
    acc.fundingLedger.push(...actor.artifacts.fundingLedger);
    acc.validationIssues.push(...actor.artifacts.validationIssues);
    for (const order of actor.artifacts.orders) acc.orderIndex.set(order.id, order);
  }

  return { refusal: null, accumulators: acc, barsProcessed, aggregate, records };
}
