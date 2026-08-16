// Декларация для actor-harness.mjs (083 S3) — внутриизолятной половины actor-шва.
//
// Намеренно РЫХЛАЯ (`unknown` вместо контрактных типов), по той же причине, что у соседних
// `hook-batch.d.mts` / `universe-instances.d.mts`: сам харнесс — обычный нетипизированный ESM,
// исполняемый ВНУТРИ изолята, где ни `@trdlabs/sdk`, ни какого-либо другого пакета нет. Этот файл
// существует ровно затем, чтобы `tsc --noEmit` прошёл по импорту из тестов; частью границы доверия
// он не является и типовых гарантий харнессу не даёт.
//
// Точные формы обеих сторон провода записаны в `src/engine/sandbox/actor-boundary.ts` — там же, где
// они и должны быть: у стороны, которая типизируется.

/** Генератор с извлекаемым состоянием — вендорная копия `@trdlabs/engine` `actor/rng.ts`. */
export declare function createCheckpointableRng(state: { readonly a: number }): {
  next(): number;
  snapshot(): { readonly a: number };
};

export type ResolveEventDrivenModuleResult =
  | { readonly ok: true; readonly module: { createActor: (init: unknown) => unknown } }
  | { readonly ok: false; readonly detail: string };

/** Найти `EventDrivenModule` в пространстве имён бандла (namespace либо default). */
export declare function resolveEventDrivenModule(loaded: unknown): ResolveEventDrivenModuleResult;

/** Восстановить `ActorInit` из проводного вида; результат заморожен глубоко. */
export declare function rebuildActorInit(wire: unknown): unknown;

/**
 * Собрать `ActorContext` из снимка. Бросает, если на проводе потеряны `openOrders`/`position`:
 * «книга пуста» и «позиции нет» — законные состояния, и подставлять их на месте пропажи нельзя.
 */
export declare function rebuildActorContext(wire: unknown, rng: unknown): unknown;

/** Таблица живых акторов изолята. */
export interface ActorStore {
  has(handleId: string): boolean;
  get(handleId: string): unknown;
  set(handleId: string, slot: unknown): unknown;
  delete(handleId: string): boolean;
  readonly size: number;
}

export declare function makeActorStore(): ActorStore;

export type ActorSlotResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly detail: string };

/** Создать актора и занять слот. Запись в таблицу — последняя строка удачного пути. */
export declare function createActorSlot(
  store: ActorStore,
  loaded: unknown,
  handleId: string,
  initWire: unknown,
): ActorSlotResult;

export type ActorDeliveryResult =
  | { readonly ok: true; readonly commands: unknown; readonly rng: { readonly a: number } }
  | { readonly ok: false; readonly detail: string };

/** Доставить событие актору синхронно; вернуть команды и состояние генератора после розыгрышей. */
export declare function deliverActorEvent(store: ActorStore, msg: unknown): ActorDeliveryResult;
