// 083 S3 — внутренний event-driven раннер одного символа. Срез 1: без production-проводки.
//
// ЧТО ЗДЕСЬ ЕСТЬ И ЧЕГО ЗДЕСЬ НЕТ. Очередь, `seq`, таймеры, бюджет каскада и переходы ledger имеют
// единственного владельца — `@trdlabs/engine` (`orderFrontier`, `nextSeq`, `assertContiguous`,
// `applyBatch`, `openFrontierTimers`, `applyFill`/`applyFunding`). Раннер их КОМПОНУЕТ и не
// переизобретает: параллельная диспетчеризация в бэктестере означала бы две реализации одного
// правила, расходящиеся молча — а расхождение здесь выглядит как другое число, а не как ошибка.
//
// ПОРЯДОК ЖИЗНЕННОГО ЦИКЛА — ПЕРВОЕ, ЧТО ЗАКРЫВАЕТСЯ, И НЕ ИЗ АККУРАТНОСТИ. У sandbox-исполнителя
// созданный актор — это сессия за границей изолята. Не освободить её значит утечь на каждый прогон;
// освободить не созданную — позвать `dispose` на том, чего нет. Разница между двумя этими исходами
// в одной строке кода, и обе тихие: ни та, ни другая не роняют прогон.
//
// Поэтому `createActor` стоит СНАРУЖИ `try`, а `disposeActor` — в `finally` внутри. Это не стиль
// расстановки скобок, а само правило: бросок создания проходит мимо `finally` по построению, и
// «dispose не зовётся на несозданном» держится формой кода, а не дисциплиной читателя.

import type { ActorInit, ActorBudgets, TradingState } from '@trdlabs/sdk/research-contract';
import type { CascadeBudget } from '@trdlabs/engine';

import type { ActorLifecycleExecutor, ActorSource } from './execution-handle.js';
import type { ActorMarketDataAdmitted } from './admission.js';
import type { ActorRiskBinding } from './engine-state.js';
import { runActorFrontiers, type ActorBar, type ActorExecutionCosts } from './frontier-runner.js';
import type { ActorExecutionRecord } from './execution-record.js';

/** Вход раннера: всё уже ПРОВЕРЕНО допуском, перечитывать манифест здесь нечего. */
export interface EventDrivenSymbolInput {
  readonly executor: ActorLifecycleExecutor;
  readonly source: ActorSource;
  /** Идентификатор инстанса актора — попадает в запись прогона и различает акторов между собой. */
  readonly actorId: string;
  readonly symbol: string;
  readonly seed: number;
  readonly params: Readonly<Record<string, unknown>>;
  /** Результат `admitActorMarketData`, уже сузённый до разрешённого. */
  readonly admission: ActorMarketDataAdmitted;
  readonly budgets?: ActorBudgets;
  /** Лента прогона. Пустая законна: прогон без баров даёт запись с нулём frontier'ов. */
  readonly bars?: readonly ActorBar[];
  readonly costs?: ActorExecutionCosts;
  readonly cascade?: CascadeBudget;
  readonly tradingState?: TradingState;
  /** Риск-профиль прогона. Дефолта нет по той же причине, что и у `costs` (см. ниже). */
  readonly risk?: ActorRiskBinding;
}

/**
 * Собрать `ActorInit` из разрешённого входа.
 *
 * `subscriptions` берутся ТЕМ ЖЕ экземпляром, что отдал допуск (замороженный массив замороженных
 * дескрипторов): состав, который проверен, и состав, который объявлен актору, обязаны быть одним
 * объектом, пока мы внутри процесса хоста. За сериализацией идентичности нет по построению — там
 * пиннится каноническое содержимое, порядок и неизменяемость восстановленного `ActorInit`.
 */
export function buildActorInit(input: EventDrivenSymbolInput): ActorInit {
  return {
    params: input.params,
    seed: input.seed,
    symbol: input.symbol,
    subscriptions: input.admission.subscriptions,
    ...(input.budgets !== undefined ? { budgets: input.budgets } : {}),
  };
}

/**
 * Провести тело прогона внутри жизненного цикла актора.
 *
 * Выделено отдельной функцией НАМЕРЕННО: правило «создание снаружи, освобождение на всех путях»
 * должно существовать в ОДНОМ месте. Стоило бы ему повториться в теле цикла — и одна из копий рано
 * или поздно оказалась бы другой.
 *
 * `dispose` зовётся РОВНО ОДИН РАЗ на любом пути завершения тела: успех, отказ, бросок.
 *
 * ПОЧЕМУ ЗДЕСЬ НЕТ `finally`, ХОТЯ ОН НАПРАШИВАЕТСЯ. `try { return await body() } finally { await
 * dispose() }` выглядит как та же семантика и ею не является: бросок из `finally` ЗАМЕЩАЕТ ошибку
 * тела. Прогон, упавший по прикладной причине и не сумевший освободить сессию, доложил бы только
 * вторую — а диагносту нужна первая, потому что «не смог освободить» без неё не диагностируется
 * вовсе. Первая редакция этой функции обещала сохранение исходной ошибки комментарием и подменяла
 * её кодом; найдено ревью владельца. Заявка была сильнее гарантии — ровно тот дефект, который мы
 * ловим в чужом коде.
 *
 * Три исхода зафиксированы явно, и ни один не сводится к другому:
 *
 *   • тело прошло, `dispose` бросил      → ошибка `dispose` (другой причины нет);
 *   • тело бросило, `dispose` прошёл     → ИСХОДНАЯ ошибка тела, тот же объект;
 *   • оба бросили                        → `AggregateError([ошибка тела, ошибка dispose])` —
 *     обе сохранены по идентичности и в этом порядке. Выбрать одну значило бы решить за диагноста,
 *     какая из двух причин настоящая, а этого знания у нас нет.
 */
export async function withActorLifecycle<T>(
  input: EventDrivenSymbolInput,
  body: (handle: Awaited<ReturnType<ActorLifecycleExecutor['createActor']>>) => Promise<T>,
): Promise<T> {
  // СНАРУЖИ. Бросок отсюда обязан пройти мимо освобождения по построению: освобождать нечего.
  const handle = await input.executor.createActor(input.source, buildActorInit(input));
  return withHandle(input, handle, body);
}

/** Тело цикла в отрыве от создания — чтобы правило трёх исходов жило ровно в одном месте. */
async function withHandle<T>(
  input: EventDrivenSymbolInput,
  handle: Awaited<ReturnType<ActorLifecycleExecutor['createActor']>>,
  body: (handle: Awaited<ReturnType<ActorLifecycleExecutor['createActor']>>) => Promise<T>,
): Promise<T> {

  let result!: T;
  let bodyError: unknown;
  // Флаг, а не `bodyError !== undefined`: бросить можно и `undefined`, и тогда проверка по значению
  // прочитала бы отказ как успех.
  let bodyOk = false;
  try {
    result = await body(handle);
    bodyOk = true;
  } catch (err) {
    bodyError = err;
  }

  try {
    await input.executor.disposeActor(handle);
  } catch (disposeError) {
    if (bodyOk) throw disposeError;
    throw new AggregateError(
      [bodyError, disposeError],
      'прогон актора отказал, и освободить актора тоже не удалось: обе причины сохранены',
    );
  }

  if (!bodyOk) throw bodyError;
  return result;
}

/**
 * Внутренний event-driven раннер одного символа.
 *
 * Один `ActorHost` на инстанс актора создаётся внутри `runActorFrontiers` — не переиспользуется
 * между акторами: гейт чекпойнта и фаза frontier'а принадлежат ИНСТАНСУ, и общий хост на двоих
 * означал бы, что открытый frontier одного запрещает чекпойнт другому.
 *
 * Production-проводка (direct/thread, агрегация нескольких символов) здесь НЕ делается: это
 * следующий срез. Функция принимает уже разрешённый допуском вход и уже поднятого исполнителя.
 */
export async function runEventDrivenSymbol(
  input: EventDrivenSymbolInput,
): Promise<ActorExecutionRecord> {
  const bars = input.bars ?? [];
  const costs = input.costs;
  if (costs === undefined) {
    // Дефолта нет намеренно: прогон с забытой комиссией показал бы прибыль, которой нет, и ничем
    // бы себя не выдал. Отсутствие параметров исполнения — отказ, а не ноль.
    throw new Error('runEventDrivenSymbol: costs обязательны — комиссия и стартовый капитал не имеют дефолта');
  }
  const risk = input.risk;
  if (risk === undefined) {
    // Дефолтный «профиль без лимитов» здесь был бы худшим из возможных умолчаний: прогон прошёл бы
    // целиком и отдал числа, выглядящие как результат стратегии, хотя это результат стратегии БЕЗ
    // риска. Разница не в точности, а в предмете — это другой прогон.
    throw new Error(
      'runEventDrivenSymbol: risk обязателен — прогон без риск-профиля посчитал бы стратегию без лимитов',
    );
  }
  const cascade = input.cascade ?? { maxCascadeDepth: 8, maxEventsPerFrontier: 256 };

  return withActorLifecycle(input, async (handle) =>
    runActorFrontiers({
      executor: input.executor,
      handle,
      actorId: input.actorId,
      symbol: input.symbol,
      seed: input.seed,
      admission: input.admission,
      bars,
      costs,
      risk,
      cascade,
      ...(input.tradingState !== undefined ? { tradingState: input.tradingState } : {}),
    }),
  );
}
