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

import type { ActorInit, ActorBudgets } from '@trdlabs/sdk/research-contract';

import type { ActorLifecycleExecutor, ActorSource } from './execution-handle.js';
import type { ActorMarketDataAdmitted } from './admission.js';

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
 * Выделено отдельной функцией НАМЕРЕННО: правило «создание снаружи try, освобождение в finally»
 * должно существовать в ОДНОМ месте. Стоило бы ему повториться в теле цикла — и одна из копий
 * рано или поздно оказалась бы другой.
 *
 * `dispose` зовётся РОВНО ОДИН РАЗ на любом пути завершения тела: успех, отказ, бросок. Его
 * собственный бросок не подменяет исходную ошибку — она и есть то, что нужно диагносту, а «не смог
 * освободить» без неё не диагностируется вовсе.
 */
export async function withActorLifecycle<T>(
  input: EventDrivenSymbolInput,
  body: (handle: Awaited<ReturnType<ActorLifecycleExecutor['createActor']>>) => Promise<T>,
): Promise<T> {
  // СНАРУЖИ try. Бросок отсюда обязан пройти мимо `finally`: освобождать нечего.
  const handle = await input.executor.createActor(input.source, buildActorInit(input));
  try {
    return await body(handle);
  } finally {
    await input.executor.disposeActor(handle);
  }
}
