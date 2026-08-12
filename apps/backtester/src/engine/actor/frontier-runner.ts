// 083 S3 — горячий цикл одного актора. Срез 1: внутренний раннер, без production-проводки.
//
// ЧТО ЗДЕСЬ КОМПОНУЕТСЯ И ЧТО ЗДЕСЬ НЕ РЕАЛИЗУЕТСЯ ЗАНОВО. Порядок событий (`orderFrontier`),
// нумерация (`nextSeq`), непрерывность (`assertContiguous`), политика отказа батча (`applyBatch`),
// заморозка eligible-набора таймеров (`openFrontierTimers`), матчинг против бара (`matchBar`) и
// бухгалтерия (`applyFill`) принадлежат `@trdlabs/engine`. Здесь нет ни одной их копии: вторая
// реализация того же правила разошлась бы с первой молча, а расхождение в этом слое выглядит как
// другое число в результате, а не как ошибка.
//
// ГРАНИЦА FRONTIER'А — `runFrontierAsync`, И ОНА ЖЕ ВЛАДЕЕТ ГЕЙТОМ. Весь business-момент, включая
// каскад, исполняется внутри одного вызова; пары «открыть/закрыть» у раннера нет, поэтому «забыл
// уведомить гейт» невыразимо. Бросок изнутри возвращает фазу на границу через `finally` движка.
//
// ДРЕНАЖ ДО ПУСТОТЫ. Следующий `U` не открывается, пока очередь текущего не опустела: события,
// порождённые командами, доставляются в ТОМ ЖЕ frontier каскадной фазой. Перенести их на следующий
// бар значило бы дать актору узнать об отказе собственной команды через минуту рыночного времени.

import {
  applyBatch,
  applyFill,
  createSeededRng,
  matchBar,
  nextSeq,
  openFrontierTimers,
  orderFrontier,
  assertContiguous,
  EMPTY_LEDGER,
  type CascadeBudget,
  type CascadeCounter,
  type Fill,
  type FrontierEvent,
  type Ledger,
  type RestingOrder,
  type Side,
} from '@trdlabs/engine';
import { createActorHost } from '@trdlabs/engine';
import type {
  ActorCommand,
  ActorContext,
  ActorInputEvent,
  TimestampUs,
  TradingState,
} from '@trdlabs/sdk/research-contract';

import { readinessAtBar, type ActorMarketDataAdmitted } from './admission.js';
import {
  actorRejectionEvent,
  createActorBatchCore,
  INTERNAL_SUBSCRIPTION_ID,
  type ActorEngineState,
  type ActorOpenOrder,
  type ActorOutboxPayload,
} from './engine-state.js';
import type {
  ActorCloseAnnotation,
  ActorEquitySample,
  ActorExecutionRecord,
  ActorFrontierRecord,
  ActorJournalEntry,
  ActorOrderRecord,
} from './execution-record.js';
import type { ActorTimelineCommand, ActorTimelineEntry } from './timeline.js';
import type { ActorLifecycleExecutor, ActorExecutionHandle } from './execution-handle.js';

/** Бар ленты в форме, которую матчит движок. */
export interface ActorBar {
  readonly tsUs: TimestampUs;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

/**
 * Экономические параметры прогона. ОБЯЗАТЕЛЬНЫ и без дефолтов.
 *
 * Дефолт здесь был бы не удобством, а молчаливым экономическим допущением: прогон с забытой
 * комиссией показал бы прибыль, которой нет, и ничем бы себя не выдал. Значения приходят из
 * профиля исполнения прогона — раннер их не выбирает.
 */
export interface ActorExecutionCosts {
  readonly feeBps: number;
  readonly slippageBps: number;
  readonly initialEquity: number;
}

export interface FrontierRunInput {
  readonly executor: ActorLifecycleExecutor;
  readonly handle: ActorExecutionHandle;
  readonly actorId: string;
  readonly symbol: string;
  readonly seed: number;
  readonly admission: ActorMarketDataAdmitted;
  readonly bars: readonly ActorBar[];
  readonly costs: ActorExecutionCosts;
  readonly cascade: CascadeBudget;
  readonly tradingState?: TradingState;
}

/** Сторона позиции для `matchBar`: при flat берётся `buy` — «худшее» тогда не определено ничем. */
function positionSideOf(ledger: Ledger): Side {
  return ledger.qty < 0 ? 'sell' : 'buy';
}

function restingOf(orders: readonly ActorOpenOrder[]): readonly RestingOrder[] {
  return orders.map((o) => ({
    orderId: o.clientOrderId,
    kind: o.type === 'stop_market' ? 'stop' : o.type,
    side: o.side,
    // Размер в базовой валюте неизвестен до цены исполнения; матчинг размер не выбирает, поэтому
    // сюда идёт нотионал, а перевод в базу делается по цене матча ниже. Подменять его нулём
    // нельзя: `matchBar` вернул бы филл нулевого размера, и позиция не изменилась бы вовсе.
    qty: o.qtyUsd,
    ...(o.triggerPrice !== undefined ? { triggerPrice: o.triggerPrice } : {}),
    placedAtTsUs: o.placedAtTsUs,
  }));
}

/** Equity = стартовый капитал + реализованное + нереализованное по цене закрытия бара. */
function equityOf(ledger: Ledger, mark: number, initialEquity: number): number {
  const unrealized = ledger.qty === 0 ? 0 : (mark - ledger.avgPrice) * ledger.qty;
  return initialEquity + ledger.realizedPnl + unrealized;
}

/** Намерение заявки относительно ТЕКУЩЕЙ экспозиции — выводится, а не объявляется автором. */
function intentOf(ledger: Ledger, side: Side): ActorOrderRecord['intent'] {
  if (ledger.qty === 0) return 'open';
  const signed = side === 'buy' ? 1 : -1;
  return Math.sign(ledger.qty) === signed ? 'add' : 'close';
}

interface QueuedPayload extends ActorOutboxPayload {
  readonly causedBySeq?: number;
}

/**
 * Исполнить все frontier'ы одного символа и собрать запись прогона.
 *
 * Вызывается ВНУТРИ `withActorLifecycle`: дескриптор уже получен, освобождение уже гарантировано.
 * Разделение намеренное — цикл не должен уметь создавать и освобождать актора, иначе правило
 * жизненного цикла существовало бы в двух местах.
 */
export async function runActorFrontiers(input: FrontierRunInput): Promise<ActorExecutionRecord> {
  const host = createActorHost();
  const core = createActorBatchCore();
  const rngSource = createSeededRng(input.seed);
  const bindings = input.admission.bindings;
  const tradingFrom = input.admission.tradingFromBarIndex;

  let state: ActorEngineState = {
    frontierIndex: 0,
    frontierUs: (input.bars[0]?.tsUs ?? 0) as TimestampUs,
    readiness: readinessAtBar(0, tradingFrom),
    tradingState: input.tradingState ?? 'normal',
    ledger: EMPTY_LEDGER,
    openOrders: [],
    timers: [],
    notes: [],
  };

  let seqCursor = 0;
  let lastCommittedSeq = -1;
  let fillCounter = 0;

  const frontiers: ActorFrontierRecord[] = [];
  const timeline: ActorTimelineEntry[] = [];
  const journal: ActorJournalEntry[] = [];
  const closes: ActorCloseAnnotation[] = [];
  const equity: ActorEquitySample[] = [];
  const orderRecords = new Map<string, ActorOrderRecord>();

  for (let index = 0; index < input.bars.length; index += 1) {
    const bar = input.bars[index]!;
    const frontierUs = bar.tsUs;

    // ВЕСЬ business-момент — внутри одного вызова. Каскад, таймеры, матчинг и запись включительно.
    await host.runFrontierAsync(frontierUs, async () => {
      state = {
        ...state,
        frontierIndex: index,
        frontierUs,
        // Готовность пересчитывается на КАЖДОМ frontier и берётся из допуска: одно значение отсюда
        // уедет и в контекст автора, и в `validate`.
        readiness: readinessAtBar(index, tradingFrom),
      };
      const counter: CascadeCounter = { depth: 0, events: 0 };
      const seed: FrontierEvent<QueuedPayload>[] = [];

      // ── Фаза 1: исполнение. Матчинг стоящих заявок против ЭТОГО бара ──────────
      const match = matchBar(restingOf(state.openOrders), bar, positionSideOf(state.ledger));
      if (match !== null) {
        const order = state.openOrders.find((o) => o.clientOrderId === match.orderId)!;
        // Нотионал → базовый размер по цене исполнения. Единственная арифметика, доступная без
        // отдельной политики сайзинга; клампа риском в этом срезе нет и он не имитируется.
        const qty = match.qty / match.price;
        const fee = Math.abs(qty * match.price) * (input.costs.feeBps / 10_000);
        const fillId = `${input.actorId}-fill-${fillCounter}`;
        fillCounter += 1;
        const fill: Fill = {
          fillId,
          tsUs: frontierUs,
          price: match.price,
          qty,
          side: order.side,
          fee,
          causedBy: order.clientOrderId,
        };
        const before = state.ledger;
        const intent = intentOf(before, order.side);
        state = {
          ...state,
          ledger: applyFill(before, fill),
          openOrders: state.openOrders.filter((o) => o.clientOrderId !== order.clientOrderId),
        };
        journal.push({
          kind: 'fill',
          frontier: index,
          fillId,
          orderId: order.clientOrderId,
          tsUs: frontierUs,
          price: match.price,
          baseOpen: match.price,
          slippageBps: input.costs.slippageBps,
          qty,
          fee,
          side: order.side,
          fillKind: intent === 'add' ? 'add' : intent === 'close' ? 'close' : 'open',
        });
        orderRecords.set(order.clientOrderId, {
          orderId: order.clientOrderId,
          placedAtFrontier: order.placedAtFrontier,
          side: order.side === 'buy' ? 'long' : 'short',
          intent,
          terminalState: 'filled',
        });
        if (intent === 'close') {
          // Аннотация нужна КАЖДОМУ сокращающему филлу, а не только обнуляющему позицию: движковая
          // деривация сделок требует причину у любого закрытия — частичного тоже, — потому что
          // причину знает только хост, и подставить её она не вправе.
          //
          // `closeFraction` здесь НЕ передаётся сознательно. Актор посылает НОТИОНАЛ, а не долю
          // позиции; исполненный размер получается из цены и с запрошенной долей побайтово не
          // совпадёт. Аннотация с долей, не равной `mul(размер эры, доля)`, — ровно та
          // противоречивая пара, которую движок отвергает с 0.10.0.
          closes.push({ exitFillId: fillId, closeReason: 'strategy_exit' });
        }
        seed.push({
          businessTsUs: frontierUs,
          phase: 'execution',
          stableSubscriptionId: INTERNAL_SUBSCRIPTION_ID,
          sourceSequence: 0,
          payload: {
            subscriptionId: INTERNAL_SUBSCRIPTION_ID,
            event: {
              kind: 'fill',
              clientOrderId: order.clientOrderId,
              price: match.price,
              qty,
              fee,
              last: true,
            },
          },
        });
      }

      // ── Фаза 2: таймеры. Набор ЗАМОРАЖИВАЕТСЯ движком ровно один раз на frontier ──
      const timers = openFrontierTimers(state.timers, frontierUs);
      state = { ...state, timers: timers.pending };
      timers.eligible.forEach((t, i) => {
        seed.push({
          businessTsUs: frontierUs,
          phase: 'timers',
          stableSubscriptionId: INTERNAL_SUBSCRIPTION_ID,
          sourceSequence: i,
          payload: {
            subscriptionId: INTERNAL_SUBSCRIPTION_ID,
            event: { kind: 'timer.fired', timerId: t.timerId, dueTsUs: t.dueTsUs },
          },
        });
      });

      // ── Фаза 4: свечи. По одному событию на КАЖДУЮ разрешённую подписку ───────
      bindings.forEach((binding, i) => {
        seed.push({
          businessTsUs: frontierUs,
          phase: 'candle',
          marketKind: 'candles',
          stableSubscriptionId: binding.descriptor.subscriptionId,
          sourceSequence: i,
          payload: {
            subscriptionId: binding.descriptor.subscriptionId,
            event: {
              kind: 'market.candle.closed',
              candle: {
                effectiveTsUs: frontierUs,
                value: { open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: 0 },
                finality: 'final',
                revision: 0,
              },
            },
          },
        });
      });

      // ── Дренаж до пустоты ─────────────────────────────────────────────────────
      const deliveredSeqs: number[] = [];
      let queue = orderFrontier(seed, seqCursor);
      seqCursor = nextSeq(seqCursor, queue);

      while (queue.length > 0) {
        const cascade: FrontierEvent<QueuedPayload>[] = [];

        for (const scheduled of queue) {
          const envelope = {
            seq: scheduled.seq,
            eventTsUs: frontierUs,
            subscriptionId: scheduled.payload.subscriptionId,
            event: scheduled.payload.event,
          } as ActorTimelineEntry['envelope'];

          const ctx = buildContext(state, frontierUs, rngSource);
          const commands: readonly ActorCommand[] = await input.executor.executeActorEvent(
            input.handle,
            scheduled.payload.event,
            ctx,
          );

          const outcome = applyBatch(commands, state, core, input.cascade, counter, (c, i, reason) =>
            actorRejectionEvent(c, i, reason, frontierUs),
          );
          state = outcome.state;
          deliveredSeqs.push(scheduled.seq);
          lastCommittedSeq = scheduled.seq;

          timeline.push({
            envelope,
            frontier: index,
            commands: describeCommands(commands, outcome),
            ...(scheduled.payload.causedBySeq !== undefined
              ? { causedBySeq: scheduled.payload.causedBySeq }
              : {}),
          });

          outcome.outbox.forEach((event, i) => {
            const payload = event.payload as ActorOutboxPayload;
            cascade.push({
              businessTsUs: frontierUs,
              phase: 'cascade',
              stableSubscriptionId: payload.subscriptionId,
              sourceSequence: i,
              payload: { ...payload, causedBySeq: scheduled.seq },
            });
          });

          if (outcome.halt !== null) {
            throw new Error(
              `актор ${input.actorId} остановлен на frontier ${index}: ${outcome.halt.reason}`,
            );
          }
        }

        queue = cascade.length > 0 ? orderFrontier(cascade, seqCursor) : [];
        seqCursor = nextSeq(seqCursor, queue);
      }

      // Непрерывность внутри frontier'а — движковым гардом, а не своей проверкой.
      if (deliveredSeqs.length > 0) assertContiguous(deliveredSeqs, deliveredSeqs[0]!);

      frontiers.push({ index, tsUs: frontierUs, lastCommittedSeq });
      equity.push({ frontier: index, equity: equityOf(state.ledger, bar.close, input.costs.initialEquity) });
    });
  }

  return {
    actorId: input.actorId,
    symbol: input.symbol,
    subscriptions: input.admission.subscriptions,
    frontiers,
    orders: [...orderRecords.values()],
    journal,
    closes,
    equity,
    riskDecisions: [],
    finalLedger: state.ledger,
    timeline,
  };
}

/** Контекст автора. `readiness` берётся ИЗ ТОГО ЖЕ состояния, что видит `BatchCore.validate`. */
function buildContext(
  state: ActorEngineState,
  frontierUs: TimestampUs,
  rng: { next: () => number },
): ActorContext {
  return {
    clock: { nowUs: () => frontierUs },
    rng,
    readiness: state.readiness,
    tradingState: state.tradingState,
    orders: {
      open: () =>
        state.openOrders.map((o) => ({
          clientOrderId: o.clientOrderId,
          side: o.side,
          status: 'accepted' as const,
          qtyUsd: o.qtyUsd,
          qty: 0,
          filledQty: 0,
        })),
    },
    position: () =>
      state.ledger.qty === 0
        ? undefined
        : {
            qty: state.ledger.qty,
            avgPrice: state.ledger.avgPrice,
            realizedPnl: state.ledger.realizedPnl,
            openedAtUs: state.ledger.openedAtUs,
          },
  } as unknown as ActorContext;
}

/**
 * Исход КАЖДОЙ команды батча — включая те, что не оставили материального следа.
 *
 * `applyBatch` возвращает `committed`, `rejectedIndex` и `skipped`; отсюда однозначно
 * восстанавливается судьба каждого индекса. Записывается вся команда целиком, а не её вид: таймеры,
 * отмены и аннотации не восстанавливаются ни из журнала, ни из заявок.
 */
function describeCommands(
  commands: readonly ActorCommand[],
  outcome: { readonly committed: number; readonly rejectedIndex: number | null; readonly rejectedReason: string | null; readonly halt: { readonly reason: string } | null },
): readonly ActorTimelineCommand[] {
  return commands.map((command, i) => {
    if (i < outcome.committed) return { command, outcome: { status: 'applied' as const } };
    if (outcome.rejectedIndex === i) {
      return { command, outcome: { status: 'rejected' as const, reason: outcome.rejectedReason ?? 'причина не указана' } };
    }
    const reason =
      outcome.halt !== null
        ? `батч остановлен: ${outcome.halt.reason}`
        : `суффикс оборван после отклонённой команды #${outcome.rejectedIndex ?? '?'}`;
    return { command, outcome: { status: 'skipped' as const, reason } };
  });
}
