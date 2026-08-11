// 083 S3 — непрозрачный дескриптор исполняемого актора и полный lifecycle-seam исполнителя.
//
// ПОЧЕМУ ДЕСКРИПТОР, А НЕ САМ АКТОР. По контракту 017.4 `EventDrivenModule` создаёт `StrategyActor`,
// и `onEvent` принадлежит ИНСТАНСУ актора. Соблазн передать этот инстанс через границу
// раннер → исполнитель велик и неверен: у доверенного in-process исполнителя актор — живой объект в
// этом же процессе, а у sandbox-исполнителя его в этом процессе нет вовсе — он живёт за границей
// изолята, и «передать» можно только ссылку, которую сам изолят и понимает.
//
// Раннер, работающий с сырым `StrategyActor`, поэтому обязан был бы знать, какой он сегодня, и
// разойтись с sandbox-путём — то есть завести два дизайна там, где нужен один. Актор создаётся
// ВНУТРИ execution boundary исполнителя, наружу отдаётся непрозрачный дескриптор, и раннер умеет с
// ним ровно одно: вернуть обратно.
//
// НЕПРОЗРАЧНОСТЬ ВЫРАЖЕНА ТИПОМ, А НЕ ПРОСЬБОЙ. Брендированный `unique symbol` не конструируется
// снаружи и не читается: у раннера нет способа ни собрать дескриптор самому, ни заглянуть внутрь.
// Комментарий «пожалуйста, не трогайте поля» держался бы ровно до первого, кому что-то понадобится.

import type {
  ActorCommand,
  ActorContext,
  ActorInit,
  ActorInputEvent,
  ModuleManifest,
} from '@trdlabs/sdk/research-contract';

declare const ACTOR_EXECUTION_HANDLE: unique symbol;

/**
 * Источник актора для исполнителя — СВОЙ тип, а не legacy `ResolvedStrategy`.
 *
 * `ResolvedStrategy` несёт `module: StrategyModule` — интерфейс формы `single_position` с
 * `onBarClose`/`onPositionBar`. Передавать его в actor-seam значило бы объявить, что исполнитель
 * получает legacy-модуль и сам догадывается, что тот на самом деле `EventDrivenModule`. Догадка
 * поселилась бы в каждой реализации отдельно и разошлась бы между trusted и sandbox.
 *
 * Здесь ровно то, что нужно для создания актора: манифест (по нему исполнитель знает форму и
 * требования) и способ добраться до кода — `module` для доверенного пути, `bundleDir` для
 * песочницы. Ни одного legacy-хука.
 */
export interface ActorSource {
  readonly manifest: ModuleManifest;
  /** Доверенный путь: `EventDrivenModule` уже в этом процессе. Типизирован как `unknown` — форму
   *  проверяет исполнитель, а не раннер: раннер по контракту в модуль не заглядывает. */
  readonly module?: unknown;
  /** Путь песочницы: каталог бандла, из которого исполнитель поднимет модуль за своей границей. */
  readonly bundleDir?: string;
}

/**
 * Дескриптор созданного актора. Значение принадлежит ИСПОЛНИТЕЛЮ: у trusted это может быть сам
 * инстанс, у sandbox — идентификатор сессии за границей изолята. Раннер не строит его и не читает.
 */
export interface ActorExecutionHandle {
  readonly [ACTOR_EXECUTION_HANDLE]: 'ActorExecutionHandle';
}

/**
 * Lifecycle-seam исполнителя для `lifecycle: 'event_driven'`: create → execute → dispose.
 *
 * ВСЕ ТРИ ОПЦИОНАЛЬНЫ ВМЕСТЕ, и это существенно. Исполнитель, умеющий создать актора, но не умеющий
 * его освободить, оставил бы за собой сессию на каждый прогон — поэтому способность проверяется как
 * ЦЕЛОЕ (`supportsActorLifecycle`), а не по одному методу в точке вызова. Частичная реализация —
 * дефект исполнителя, и обнаружиться он обязан до старта прогона, а не на dispose.
 *
 * Отсутствие seam'а НЕ означает деградацию в `onBarClose`: это другая семантика, и подмена одной
 * другой — ровно то, что запрещает `unsupported_lifecycle`.
 */
export interface ActorLifecycleExecutor {
  /**
   * Создать актора ВНУТРИ своей execution boundary и вернуть непрозрачный дескриптор.
   *
   * Принимает `ActorInit`, а не `ActorContext`, и это не вкусовщина. `ActorInit` — вход СОЗДАНИЯ:
   * params, seed, symbol, подписки, начальное состояние, бюджеты. `ActorContext` — вход ДОСТАВКИ
   * события: он несёт то, что верно на конкретный момент времени. Передать контекст в создание
   * значило бы дать актору момент времени, которого при создании ещё нет, — и тем самым завести
   * вопрос «какой именно момент», у которого нет правильного ответа.
   */
  createActor(source: ActorSource, init: ActorInit): Promise<ActorExecutionHandle>;
  /** Доставить событие актору; вернуть команды. Порядок команд — причинный, как вернул автор. */
  executeActorEvent(
    handle: ActorExecutionHandle,
    event: ActorInputEvent,
    ctx: ActorContext,
  ): Promise<readonly ActorCommand[]>;
  /** Освободить актора. Идемпотентно: повторный вызов на уже освобождённом — no-op, не бросок. */
  disposeActor(handle: ActorExecutionHandle): Promise<void>;
}

/**
 * Умеет ли исполнитель ВЕСЬ lifecycle актора.
 *
 * Проверяется тройка целиком: `createActor` без `disposeActor` — это утечка сессии, отложенная до
 * конца прогона, и узнать о ней на первом же вызове дешевле, чем на последнем.
 */
export function supportsActorLifecycle(
  executor: Partial<ActorLifecycleExecutor>,
): executor is ActorLifecycleExecutor {
  return (
    typeof executor.createActor === 'function' &&
    typeof executor.executeActorEvent === 'function' &&
    typeof executor.disposeActor === 'function'
  );
}
