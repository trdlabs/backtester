// 083 S3 — ВНУТРИИЗОЛЯТНАЯ половина actor-шва: create → event → dispose.
//
// Второй конец контракта, первый — `src/engine/sandbox/actor-boundary.ts`. Там записано, ЧТО
// кладётся на провод; здесь — как из этого собирается настоящий `ActorContext`, который автор
// читает документированными полями.
//
// ЧЕМ ЭТО ОТЛИЧАЕТСЯ ОТ `initSymbol` РЯДОМ. У legacy-хуков модуль — ОДИН экземпляр на символ, и
// не-фабричный default-export приходится отвергать вторым символом (общий объект тёк бы `this`-
// состоянием между символами). У актора этой опасности нет по построению: `createActor(init)` —
// сама фабрика, и каждый вызов ОБЯЗАН вернуть новый экземпляр. Поэтому здесь нет ни зонда на
// занятость, ни отказа второму символу: их повод не выполнен.
//
// ВЛАДЕНИЕ АТОМАРНО. Запись в таблицу происходит ПОСЛЕДНЕЙ строкой удачного пути: всё, что может
// отказать (резолв модуля, вызов фабрики, проверка формы актора), стоит до неё. Отказ на любом
// шаге не оставляет слота, который некому освободить, — а освободить его действительно было бы
// некому: дескриптора у хоста ещё нет.

import { deepFreeze } from './rehydrate.mjs';

/**
 * mulberry32 с ИЗВЛЕКАЕМЫМ состоянием — вендорная копия `@trdlabs/engine` `actor/rng.ts`.
 *
 * Копия здесь вынужденная: код внутри изолята не импортирует ничего из node_modules — граф
 * схлопывается esbuild'ом в один classic-script. Копия — это второе место, где живёт одно правило,
 * и молчаливое расхождение таких пар мы ловим гейтом, а не надеждой: набор сверяет
 * последовательность этой функции с движковой (`actor-isolate-lifecycle`, «оба mulberry32 дают
 * одну ленту»). Разойдись они — актор в песочнице и актор в процессе получили бы разные числа при
 * одном seed, и происхождение расхождения искали бы в стратегии.
 */
export function createCheckpointableRng(state) {
  let a = (state && typeof state.a === 'number' ? state.a : 0) >>> 0;
  return {
    next() {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    snapshot() {
      return { a: a >>> 0 };
    },
  };
}

/**
 * Найти `EventDrivenModule` в загруженном пространстве имён бандла.
 *
 * Две законные формы, и обе встречаются: `export function createActor` (тогда модуль — само
 * пространство имён) и `export default { createActor }`. Порядок проверки не произволен —
 * пространство имён рассматривается первым, потому что именно оно является модулем по контракту
 * (`EventDrivenModule` = объект с `createActor`), а default — лишь один из способов его выразить.
 */
export function resolveEventDrivenModule(loaded) {
  if (loaded === undefined || loaded === null) {
    return { ok: false, detail: 'бандл не загружен в изолят' };
  }
  if (typeof loaded.createActor === 'function') return { ok: true, module: loaded };
  const dflt = loaded.default;
  if (dflt !== undefined && dflt !== null && typeof dflt.createActor === 'function') {
    return { ok: true, module: dflt };
  }
  return {
    ok: false,
    detail:
      'модуль объявлен event_driven, но не предоставляет createActor — ни экспортом, ни в default. ' +
      'Форма модуля не совпадает с объявленным lifecycle',
  };
}

/**
 * Восстановить `ActorInit` из проводного вида.
 *
 * ЗАМОРАЖИВАЕТСЯ ГЛУБОКО, и это не украшение. Внутри процесса хоста допуск отдаёт замороженный
 * массив замороженных дескрипторов, и «проверено» с «доставлено» — один объект. За границей
 * идентичности нет; единственное, что здесь ещё можно удержать, — что автор получит те же
 * значения В ТОМ ЖЕ ПОРЯДКЕ и не сможет их изменить. Незамороженный `init.subscriptions` позволил
 * бы стратегии дописать себе подписку и сверяться с собственным списком.
 */
export function rebuildActorInit(wire) {
  const init = {
    params: wire.params,
    seed: wire.seed,
    symbol: wire.symbol,
    subscriptions: wire.subscriptions,
  };
  if (wire.budgets !== undefined) init.budgets = wire.budgets;
  if (wire.state !== undefined) init.state = wire.state;
  return deepFreeze(init);
}

/**
 * Собрать настоящий `ActorContext` из снимка.
 *
 * Функции восстановлены функциями — автор читает `ctx.position()`, а не `ctx.position`. Значения
 * под ними заморожены: контракт называет их снимками и мутацию запрещает, а на прямом пути
 * `position()` отдаёт ОБЩИЙ объект хоста — его изменение испортило бы бухгалтерию прогона молча.
 * Здесь испортить нечего, но правило одно, и лучше, чтобы нарушение было видно там, где его вообще
 * можно увидеть.
 *
 * `position: null` на проводе означает «позиции нет» и восстанавливается в `undefined` — ровно то,
 * что контракт обещает автору.
 */
export function rebuildActorContext(wire, rng) {
  // ПРИСУТСТВИЕ ПОЛЕЙ ТРЕБУЕТСЯ, А НЕ ПОДРАЗУМЕВАЕТСЯ. Первая редакция читала `wire.openOrders ?? []`
  // и `wire.position ?? undefined` — то есть подставляла «книга пуста» и «позиции нет» на потерянное
  // по дороге поле. Это худшая из возможных подстановок: оба значения ЗАКОННЫ, автор принял бы их
  // за состояние рынка и торговал бы по нему, а потеря не оставила бы следа нигде.
  //
  // Отсюда `null` на проводе для отсутствующей позиции: `undefined` исчезает при `JSON.stringify`,
  // и «позиции нет» стало бы неотличимо от «поля не доехало». Различить их можно только договорясь
  // о значении для первого — и потребовав ключ для второго.
  if (!Object.prototype.hasOwnProperty.call(wire, 'openOrders')) {
    throw new Error('контекст без openOrders: пустая книга — законное состояние, потеря поля — нет');
  }
  if (!Object.prototype.hasOwnProperty.call(wire, 'position')) {
    throw new Error('контекст без position: «позиции нет» на проводе это null, а не отсутствие ключа');
  }
  const nowUs = wire.nowUs;
  const openOrders = deepFreeze(wire.openOrders);
  const position = wire.position === null ? undefined : deepFreeze(wire.position);
  return Object.freeze({
    clock: Object.freeze({ nowUs: () => nowUs }),
    rng,
    readiness: wire.readiness,
    tradingState: wire.tradingState,
    orders: Object.freeze({ open: () => openOrders }),
    position: () => position,
  });
}

/** Таблица живых акторов изолята. Ключ — дескриптор, выданный хостом. */
export function makeActorStore() {
  const slots = new Map();
  return {
    has: (handleId) => slots.has(handleId),
    get: (handleId) => slots.get(handleId),
    set: (handleId, slot) => slots.set(handleId, slot),
    delete: (handleId) => slots.delete(handleId),
    get size() {
      return slots.size;
    },
  };
}

/**
 * Создать актора и занять слот.
 *
 * Возвращает `{ ok }` либо `{ ok:false, detail }`; бросков наружу нет — исход отказа обязан быть
 * ЗНАЧЕНИЕМ, чтобы хост отличил «модуль не той формы» от «изолят умер».
 */
export function createActorSlot(store, loaded, handleId, initWire) {
  if (store.has(handleId)) {
    // Тихая перезапись потеряла бы прежнего актора вместе со всем его состоянием, а хост продолжал
    // бы адресовать его тем же дескриптором и получать чужие ответы.
    return { ok: false, detail: `дескриптор '${handleId}' уже занят` };
  }
  const resolved = resolveEventDrivenModule(loaded);
  if (!resolved.ok) return { ok: false, detail: resolved.detail };
  let actor;
  try {
    actor = resolved.module.createActor(rebuildActorInit(initWire));
  } catch (e) {
    return { ok: false, detail: `createActor бросил: ${e && e.message ? e.message : String(e)}` };
  }
  if (actor === undefined || actor === null || typeof actor.onEvent !== 'function') {
    return { ok: false, detail: 'createActor вернул не актора — нет onEvent' };
  }
  // ПОСЛЕДНЯЯ строка удачного пути: всё, что могло отказать, уже позади.
  store.set(handleId, { actor });
  return { ok: true };
}

/**
 * Доставить событие актору.
 *
 * СИНХРОННО — по форме контракта: `onEvent` объявлен возвращающим массив команд, не промис.
 * Thenable отвергается явной причиной, а не ждётся: заход в изолят синхронный, дождаться промиса
 * внутри него нечем, и молчаливое `[]` вместо ответа проглотило бы решения автора.
 */
export function deliverActorEvent(store, msg) {
  const slot = store.get(msg.handleId);
  if (slot === undefined) {
    return { ok: false, detail: `дескриптор '${msg.handleId}' неизвестен — актор не создан либо освобождён` };
  }
  const rng = createCheckpointableRng(msg.ctx.rng);
  const ctx = rebuildActorContext(msg.ctx, rng);
  let out;
  try {
    out = slot.actor.onEvent(deepFreeze(msg.event), ctx);
  } catch (e) {
    return { ok: false, detail: `onEvent бросил: ${e && e.message ? e.message : String(e)}` };
  }
  if (out !== null && typeof out === 'object' && typeof out.then === 'function') {
    return { ok: false, detail: 'onEvent вернул промис: актор обязан отвечать синхронно' };
  }
  // Форму батча проверяет ХОСТ по схеме контракта. Здесь она намеренно не проверяется второй
  // раз: гейт, стоящий по обе стороны, — это две мерки одного предмета, и однажды они разойдутся.
  // Возврат отдаётся как есть; `null`/`undefined` не подменяется пустым массивом, иначе «автор
  // ничего не вернул» стало бы неотличимо от «автор решил ничего не делать».
  return { ok: true, commands: out, rng: rng.snapshot() };
}
