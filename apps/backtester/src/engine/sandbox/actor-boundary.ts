// 083 S3 — ПРОВОДНОЙ ФОРМАТ actor-шва через границу изолята.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ, А НЕ ПАРА `JSON.stringify` В ИСПОЛНИТЕЛЕ. У `ActorContext` половина
// поверхности — ФУНКЦИИ (`clock.nowUs`, `rng.next`, `orders.open`, `position`). `JSON.stringify`
// молча выбрасывает функции: контекст доехал бы до автора объектом с четырьмя отсутствующими
// полями, и `ctx.position` в изоляте был бы не «нет позиции», а `TypeError` — либо, что хуже,
// `ctx.readiness` доехал бы, а `orders.open` нет, и стратегия увидела бы полупустой мир, ничем об
// этом не предупреждённая.
//
// Поэтому форма выписана ЯВНО и в обе стороны: здесь — что кладётся на провод, в
// `sandbox-harness-overlay/actor-harness.mjs` — как из этого собирается настоящий `ActorContext`.
// Два конца одного контракта; менять один, не трогая второй, невозможно по построению — они
// разговаривают полями, которых нет больше нигде.
//
// ГРАНИЦА ИДЕНТИЧНОСТИ. Внутри процесса хоста `ActorInit.subscriptions` — ТОТ САМЫЙ замороженный
// массив, что вернул допуск (см. `ActorMarketDataAdmitted.subscriptions`). За сериализацией
// идентичности объектов не существует по построению: десериализация всегда порождает новые.
// Поэтому здесь пиннится то, что за границей проверяемо, — каноническое СОДЕРЖИМОЕ, ПОРЯДОК и
// неизменяемость восстановленного значения.

import type { CheckpointableRng, RngState } from '@trdlabs/engine';
import type {
  ActorBudgets,
  ActorCommand,
  ActorInit,
  ActorInputEvent,
  ActorReadiness,
  ActorStateValue,
  ActorSubscriptionDescriptor,
  OpenOrderView,
  PositionView,
  TradingState,
} from '@trdlabs/sdk/research-contract';

import type { HostActorContext } from '../actor/execution-handle.js';
import { createSchemaRegistry, jsonPointerOf } from '../validation/schema-registry.js';

/**
 * `ActorInit` В ПЛОСКОМ ВИДЕ — ровно то, что переживает JSON.
 *
 * Ни одно поле не выброшено и ни одно не добавлено: у `ActorInit` функций нет, поэтому форма
 * повторяет контрактную один в один. Выписана она всё равно ЯВНО, а не выведена `as unknown`:
 * поле, добавленное в контракт завтра, обязано либо появиться здесь, либо не собраться, — а не
 * молча исчезнуть на проводе.
 */
export interface ActorInitWire {
  readonly params: Readonly<Record<string, unknown>>;
  readonly seed: number;
  readonly symbol: string;
  readonly subscriptions: readonly ActorSubscriptionDescriptor[];
  readonly budgets?: ActorBudgets;
  readonly state?: ActorStateValue;
}

/**
 * `ActorContext` В ПЛОСКОМ ВИДЕ: каждая функция заменена на СНИМОК своего значения.
 *
 * ПОЧЕМУ СНИМОК, А НЕ ОБРАТНЫЙ ВЫЗОВ В ХОСТ. Ленивость `orders.open()`/`position()` внутри процесса
 * бесплатна, а через границу стоила бы отдельного захода на каждое обращение — и, что важнее,
 * открыла бы канал из недоверенного кода В ХОСТ. Значения эти по контракту и так СНИМКИ на момент
 * вызова («дальнейшее состояние актор получает только СЛЕДУЮЩИМ вызовом `onEvent`»), поэтому
 * вычислить их заранее — не приближение, а то же самое значение, посчитанное раньше.
 *
 * НАБЛЮДАЕМОЕ ОТЛИЧИЕ ОДНО, И ОНО НАЗВАНО ЗДЕСЬ: `openOrderViewOf` бросает на заявке `limit`/
 * `stop_market` без цены (инвариант хоста). На прямом пути бросок случился бы, только если автор
 * СПРОСИЛ заявки; здесь — всегда. Это ужесточение, а не расхождение семантики: состояние,
 * вызывающее бросок, незаконно в обоих случаях, и узнать о нём раньше лучше, чем позже.
 */
export interface ActorContextWire {
  readonly nowUs: number;
  readonly readiness: ActorReadiness;
  readonly tradingState: TradingState;
  readonly openOrders: readonly OpenOrderView[];
  /**
   * `null`, а не отсутствующее поле: `undefined` исчезает при `JSON.stringify`, и «позиции нет»
   * стало бы неотличимо от «поле потеряли по дороге». За границей `null` восстанавливается обратно
   * в `undefined` — то, что контракт обещает автору.
   */
  readonly position: PositionView | null;
  /**
   * СОСТОЯНИЕ генератора, а не сам генератор.
   *
   * Дом RNG — хост (§3.6): генератор чекпойнтится вместе с ядром, и авторский `ctx.rng` обязан
   * продолжать ОДНУ последовательность через всю жизнь актора. Объект за границу не передать,
   * поэтому едет значение, а обратно — значение после розыгрышей. Засеять в изоляте «свой» от
   * `seed` было бы почти то же самое ровно до первого прогона, где число вызовов `next()`
   * разойдётся, — и расхождение выглядело бы как другое решение стратегии.
   */
  readonly rng: RngState;
}

/** Одно сообщение доставки события: дескриптор + событие + контекст. */
export interface ActorEventWire {
  readonly handleId: string;
  readonly event: ActorInputEvent;
  readonly ctx: ActorContextWire;
}

/** Ответ изолята на доставку события. `rng` — состояние ПОСЛЕ розыгрышей автора. */
export interface ActorEventReplyWire {
  readonly commands: readonly unknown[];
  readonly rng: RngState;
}

/** Собрать проводной `ActorInit`. Порядок подписок сохраняется — он нормативен (§3.8.2). */
export function serializeActorInit(init: ActorInit): ActorInitWire {
  return {
    params: init.params,
    seed: init.seed,
    symbol: init.symbol,
    subscriptions: init.subscriptions,
    ...(init.budgets !== undefined ? { budgets: init.budgets } : {}),
    ...(init.state !== undefined ? { state: init.state } : {}),
  };
}

/**
 * Собрать проводной контекст.
 *
 * `rng.snapshot()` вызывается ДО доставки: за границу уезжает положение генератора на этот момент,
 * а не после. Требование `HostActorContext` (а не `ActorContext`) — типовое: контекст без
 * извлекаемого состояния сюда не подать, и «а вдруг у него нет snapshot» перестаёт быть вопросом.
 */
export function serializeActorContext(ctx: HostActorContext): ActorContextWire {
  return {
    nowUs: ctx.clock.nowUs() as number,
    readiness: ctx.readiness,
    tradingState: ctx.tradingState,
    openOrders: ctx.orders.open(),
    position: ctx.position() ?? null,
    rng: ctx.rng.snapshot(),
  };
}

/** Результат ревалидации батча команд, вернувшегося из-за границы. */
export type ActorCommandRevalidation =
  | { readonly ok: true; readonly commands: readonly ActorCommand[] }
  | { readonly ok: false; readonly message: string };

/**
 * Реестр схем контракта — один на процесс. Компиляция core-схем стоит заметно, а батч
 * ревалидируется на КАЖДОМ событии каждого актора.
 */
let registrySingleton: ReturnType<typeof createSchemaRegistry> | undefined;
const schemaRegistry = (): ReturnType<typeof createSchemaRegistry> =>
  (registrySingleton ??= createSchemaRegistry());

/**
 * Ревалидировать батч команд, пришедший из-за границы исполнения.
 *
 * ГЕЙТ ПРЕДПИСАН КОНТРАКТОМ, А НЕ ПРИДУМАН ЗДЕСЬ. Схема `actor-command-batch` описывает себя
 * дословно как «то, что актор возвращает из одного `onEvent` и что пересекает JSON-границу
 * изолята; хост валидирует именно ЕГО», и относит невалидный по схеме батч к классу
 * `halt+finalize` — вместе с броском из `dispatch` и превышением бюджета. Поэтому здесь схема
 * контракта, а не самописный разбор полей: вторая мерка того же предмета разошлась бы с первой
 * молча, и разошлась бы в ту сторону, где хост ПРИНИМАЕТ то, чего контракт не разрешает.
 *
 * ПОЧЕМУ НЕ ХВАТАЕТ `BatchCore.validate`. Тот отвечает на другой вопрос — «позволена ли ЭТА
 * команда СЕЙЧАС», — и задаёт его команде, уже признанной командой: читает `command.note.trim()`,
 * `command.qtyUsd`, `command.side`. На объекте `{ kind: 'annotate' }` без `note` он БРОСАЕТ, а
 * бросок из `validate` — это halt инстанса с невнятной причиной вместо названного отказа границы.
 *
 * ПОЧЕМУ НЕ `[]` ВМЕСТО ОТКАЗА. Пустой батч — законный ответ автора («событие проигнорировано»).
 * Подменить им испорченный ответ значит превратить порчу в решение стратегии: прогон дошёл бы до
 * конца и отдал числа, посчитанные без части команд, ничем себя не выдав.
 */
export function revalidateActorCommands(value: unknown): ActorCommandRevalidation {
  // Настоящий массив, а не array-like: объект с `length` и числовыми ключами проходит по схеме
  // не всегда одинаково у разных валидаторов, а дальше по коду `.map`/`.forEach` работают уже не
  // с тем, чем кажутся. Вопрос «массив ли это» задаётся один раз и здесь.
  if (!Array.isArray(value)) {
    return { ok: false, message: `батч команд не массив (${typeof value})` };
  }
  const errors = schemaRegistry().validateCore('actor-command-batch', value);
  if (errors.length > 0) {
    const first = errors[0]!;
    return {
      ok: false,
      message:
        `батч команд не соответствует схеме контракта в ${jsonPointerOf(first) || '<корень>'}: ` +
        `${first.message ?? 'невалидно'}`,
    };
  }
  return { ok: true, commands: value as readonly ActorCommand[] };
}

/** Состояние генератора, вернувшееся из-за границы, — недоверенный вход, как и команды. */
export function isRngStateWire(value: unknown): value is RngState {
  if (typeof value !== 'object' || value === null) return false;
  const a = (value as { a?: unknown }).a;
  return typeof a === 'number' && Number.isInteger(a) && a >= 0 && a <= 0xffffffff;
}

/** Тип-мост: генератор хоста, восстановленный из вернувшегося состояния. */
export type { CheckpointableRng };
