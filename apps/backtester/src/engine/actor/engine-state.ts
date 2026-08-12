// 083 S3 — состояние ядра актора и `BatchCore` над ним.
//
// ОДНО СОСТОЯНИЕ, ДВА ЧИТАТЕЛЯ. `readiness` живёт ЗДЕСЬ, и отсюда её берут оба: `ActorContext`,
// который видит автор, и `BatchCore.validate`, который решает судьбу команды.Два источника — а
// именно ими стали бы «поле в контексте» и «флаг у раннера» — разошлись бы ровно в том случае, где
// это важно: автор прочитал `ready`, отправил `place`, а хост отклонил его как прогревающегося.
//
// ПОЧЕМУ ЗАПРЕТ `place` ДО ГОТОВНОСТИ — ЭТО `validate`, А НЕ PRE-FILTER. Отфильтровать команду
// раньше `applyBatch` значит вынуть её из ЕДИНСТВЕННОГО места, где живёт политика отказа §3.8.4:
// префикс коммитится, отклонённая не имеет частичных эффектов, суффикс обрывается, событие отказа
// встаёт в outbox и доезжает актору каскадом в том же frontier. Pre-filter не даёт ничего из
// этого — он даёт тишину, и тогда прогрев был бы неотличим от «автор ничего не отправлял».

import {
  cancelTimer,
  scheduleTimer,
  type Ledger,
  type OutboxEvent,
  type ScheduledTimer,
  type Validation,
  type Applied,
  type BatchCore,
} from '@trdlabs/engine';
import type {
  ActorCommand,
  ActorInputEvent,
  ActorReadiness,
  OrderSide,
  TimestampUs,
  TradingState,
} from '@trdlabs/sdk/research-contract';

/** Заявка, стоящая в книге симулятора. Форма ХОСТА: движок матчит свою `RestingOrder`. */
export interface ActorOpenOrder {
  readonly clientOrderId: string;
  readonly side: OrderSide;
  /** Запрошенный нотионал в USD — до превращения в базовый размер по цене исполнения. */
  readonly qtyUsd: number;
  readonly type: 'market' | 'limit' | 'stop_market';
  readonly triggerPrice?: number;
  /** Frontier подачи. Нужен и анти-лукахеду движка, и записи прогона. */
  readonly placedAtFrontier: number;
  readonly placedAtTsUs: TimestampUs;
  readonly reduceOnly: boolean;
}

/**
 * Всё изменяемое состояние ядра одного актора.
 *
 * Плоская запись, а не объект с методами: `applyBatch` замораживает состояние ГЛУБОКО перед каждой
 * командой, и метод, дописывающий поле, бросил бы `TypeError` вместо того, чтобы вернуть новое
 * состояние. Форма выбрана под это правило, а не вопреки ему.
 */
export interface ActorEngineState {
  readonly frontierIndex: number;
  readonly frontierUs: TimestampUs;
  /** ЕДИНСТВЕННЫЙ источник готовности — и для контекста автора, и для валидации команд. */
  readonly readiness: ActorReadiness;
  readonly tradingState: TradingState;
  readonly ledger: Ledger;
  readonly openOrders: readonly ActorOpenOrder[];
  readonly timers: readonly ScheduledTimer[];
  /** Заметки команды `annotate` — единственный её эффект, и он обязан быть наблюдаем. */
  readonly notes: readonly { readonly frontier: number; readonly note: string }[];
}

/** Событие outbox'а несёт ГОТОВОЕ входное событие: раннеру нечего додумывать по строке `kind`. */
export interface ActorOutboxPayload {
  readonly event: ActorInputEvent;
  /** Подписка, от имени которой доставляется каскадное событие (внутренние — служебная подписка). */
  readonly subscriptionId: string;
}

/** Идентификатор служебной подписки внутренних событий: они приходят не из ленты. */
export const INTERNAL_SUBSCRIPTION_ID = 'sub-internal';

function outbox(event: ActorInputEvent, businessTsUs: TimestampUs): OutboxEvent {
  const payload: ActorOutboxPayload = { event, subscriptionId: INTERNAL_SUBSCRIPTION_ID };
  return { kind: event.kind, businessTsUs, payload };
}

/** Событие отказа команды — то, что `applyBatch` кладёт в outbox вместо применения. */
export function actorRejectionEvent(
  command: ActorCommand,
  _index: number,
  reason: string,
  frontierUs: TimestampUs,
): OutboxEvent {
  // Отказ адресуется заявке, если она у команды есть: автору нужен не «что-то отклонено», а
  // «отклонена ВОТ ЭТА заявка», иначе его FSM не может закрыть своё ожидание.
  const clientOrderId =
    command.kind === 'place' || command.kind === 'cancel' ? command.clientOrderId : `-${command.kind}`;
  if (command.kind === 'cancel') {
    return outbox({ kind: 'cancel.rejected', clientOrderId, reason }, frontierUs);
  }
  return outbox({ kind: 'order.denied', clientOrderId, reason }, frontierUs);
}

/**
 * Ядро применения команд актора.
 *
 * `validate` СМОТРИТ на `state.readiness` — то же поле, что уезжает в `ActorContext`. Именно этим
 * warm-up-запрет и является обычным rejection'ом: он проходит по той же дороге, что нехватка
 * средств или неизвестная заявка, и получает те же гарантии — префикс, обрыв суффикса, событие в
 * outbox, запись в timeline.
 */
export function createActorBatchCore(): BatchCore<ActorCommand, ActorEngineState> {
  return {
    validate(command, state): Validation {
      switch (command.kind) {
        case 'place': {
          if (state.readiness !== 'ready') {
            return {
              ok: false,
              reason:
                `place отклонена: актор ещё прогревается (readiness=${state.readiness}). Торговые ` +
                'права выдаются после набора объявленного lookback — события до этого доставляются, ' +
                'но не торгуются',
            };
          }
          if (state.tradingState === 'halted') {
            return { ok: false, reason: 'place отклонена: хост остановил торговлю (tradingState=halted)' };
          }
          if (state.tradingState === 'reducing' && command.reduceOnly !== true) {
            return {
              ok: false,
              reason: 'place отклонена: хост в режиме reducing, принимаются только reduceOnly-заявки',
            };
          }
          if (state.openOrders.some((o) => o.clientOrderId === command.clientOrderId)) {
            return { ok: false, reason: `place отклонена: clientOrderId '${command.clientOrderId}' уже стоит` };
          }
          if (!Number.isFinite(command.qtyUsd) || command.qtyUsd <= 0) {
            return { ok: false, reason: `place отклонена: qtyUsd обязан быть положительным, получено ${command.qtyUsd}` };
          }
          return { ok: true };
        }
        case 'cancel': {
          if (!state.openOrders.some((o) => o.clientOrderId === command.clientOrderId)) {
            return { ok: false, reason: `cancel отклонена: заявки '${command.clientOrderId}' нет в книге` };
          }
          return { ok: true };
        }
        case 'timer.set': {
          // Проверяется ЗДЕСЬ, хотя движковый `scheduleTimer` тоже бросает на дубликате: бросок из
          // `apply` — это halt+finalize, а повторный timerId это ошибка автора, а не поломка
          // инстанса. Разница классов отказа наблюдаема и терять её нельзя.
          if (state.timers.some((t) => t.timerId === command.timerId)) {
            return { ok: false, reason: `timer.set отклонена: timerId '${command.timerId}' уже поставлен` };
          }
          return { ok: true };
        }
        case 'timer.cancel':
          // Снятие отсутствующего таймера законно: гонка отмены со срабатыванием — не ошибка.
          return { ok: true };
        case 'annotate':
          return command.note.trim() === ''
            ? { ok: false, reason: 'annotate отклонена: пустая заметка не является записью' }
            : { ok: true };
      }
    },

    apply(command, state): Applied<ActorEngineState> {
      switch (command.kind) {
        case 'place': {
          const order: ActorOpenOrder = {
            clientOrderId: command.clientOrderId,
            side: command.side,
            qtyUsd: command.qtyUsd,
            type: command.type === 'stop_market' ? 'stop_market' : command.type,
            ...(command.type !== 'market' ? { triggerPrice: (command as { price?: number; triggerPrice?: number }).price ?? (command as { triggerPrice?: number }).triggerPrice ?? 0 } : {}),
            placedAtFrontier: state.frontierIndex,
            placedAtTsUs: state.frontierUs,
            reduceOnly: command.reduceOnly === true,
          };
          return {
            state: { ...state, openOrders: [...state.openOrders, order] },
            events: [outbox({ kind: 'order.accepted', clientOrderId: command.clientOrderId }, state.frontierUs)],
          };
        }
        case 'cancel': {
          return {
            state: {
              ...state,
              openOrders: state.openOrders.filter((o) => o.clientOrderId !== command.clientOrderId),
            },
            events: [outbox({ kind: 'order.canceled', clientOrderId: command.clientOrderId }, state.frontierUs)],
          };
        }
        case 'timer.set': {
          // Срок материализуется ЗДЕСЬ по правилу контракта: `atTs` абсолютен, `afterUs` считается
          // от `eventTsUs` доставки — то есть от текущего frontier. Обе формы сводятся к одному
          // числу до того, как таймер попадёт движку: у него своей базы отсчёта нет.
          const dueTsUs = ('atTs' in command ? command.atTs : ((state.frontierUs as number) + (command.afterUs as number))) as TimestampUs;
          return {
            state: { ...state, timers: scheduleTimer(state.timers, command.timerId, dueTsUs, state.frontierUs) },
            events: [],
          };
        }
        case 'timer.cancel':
          return { state: { ...state, timers: cancelTimer(state.timers, command.timerId) }, events: [] };
        case 'annotate':
          return {
            state: { ...state, notes: [...state.notes, { frontier: state.frontierIndex, note: command.note }] },
            events: [],
          };
      }
    },
  };
}
