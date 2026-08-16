// 083 S3 — LIFECYCLE АКТОРА ЗА ГРАНИЦЕЙ ИЗОЛЯТА: create → execute → dispose.
//
// Гоняется РЕАЛЬНЫЙ собранный харнесс (`_isolate/harness.js`) и РЕАЛЬНЫЙ isolated-vm — как у
// соседнего `isolate-executor.test.ts`. Подставлять здесь нечего: предмет набора это и есть
// граница, и заглушка вместо изолята доказывала бы свойства собственной заглушки.
//
// ГЛАВНОЕ, ЧТО ПРОВЕРЯЕТСЯ, — НЕ «РАБОТАЕТ», А «НЕ ТЕЧЁТ И НЕ МОЛЧИТ»:
//
//   • атомарность владения проверяется ДВУМЯ счётчиками, хоста и изолята. Счётчик хоста один
//     доказывает лишь то, что хост о себе думает: слот, заведённый за границей и потерянный
//     хостом, виден только изнутри — и это ровно та утечка, которую исключает атомарность;
//   • отказ доставки обязан быть ГРОМКИМ. Пустой батч — законный ответ автора, поэтому
//     проглоченный сбой становится неотличим от решения стратегии, а прогон отдаёт числа,
//     посчитанные без части команд.

import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createCheckpointableRng, rngStateFromSeed } from '@trdlabs/engine';
import type { ModuleManifest } from '@trading/research-contracts/research';
import type { ActorInit, ActorInputEvent } from '@trdlabs/sdk/research-contract';

import { DEFAULT_SANDBOX } from '../src/engine/sandbox-policy.js';
import type { ModuleBundle } from '../src/engine/sandbox/bundle.js';
import { IsolateModuleExecutor } from '../src/engine/sandbox/isolate-executor.js';
import { isRngStateWire, revalidateActorCommands } from '../src/engine/sandbox/actor-boundary.js';
import type { ActorSource, HostActorContext } from '../src/engine/actor/execution-handle.js';
// Вендорная копия mulberry32 из ХАРНЕССА — та, что исполняется внутри изолята.
import {
  createActorSlot,
  createCheckpointableRng as harnessRng,
  makeActorStore,
  rebuildActorContext,
} from '../sandbox-harness-overlay/actor-harness.mjs';

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

const MANIFEST_ID = 'actor_isolate_probe';

/** Временный bundleDir с одним ESM-файлом — тот же канон, что у соседнего набора. */
function writeBundle(source: string): ModuleBundle {
  const dir = mkdtempSync(join(tmpdir(), 'actor-isolate-'));
  tempDirs.push(dir);
  mkdirSync(join(dir, 'module'), { recursive: true });
  writeFileSync(join(dir, 'module/index.js'), source);
  return {
    bundleDir: dir,
    manifest: {
      id: MANIFEST_ID,
      version: '1.0.0',
      kind: 'strategy',
      hooks: ['onEvent'],
      lifecycle: 'event_driven',
    } as unknown as ModuleManifest,
    descriptor: {
      contractVersion: '1.0.0',
      kind: 'strategy',
      entryPoint: 'module/index.js',
      files: [
        { path: 'module/index.js', sha256: createHash('sha256').update(source).digest('hex') },
      ],
      bundleHash: `sha256:${'cd'.repeat(32)}`,
    },
  };
}

const executors: IsolateModuleExecutor[] = [];
function executorFor(source: string): { executor: IsolateModuleExecutor; source: ActorSource } {
  const bundle = writeBundle(source);
  const executor = new IsolateModuleExecutor(bundle, DEFAULT_SANDBOX);
  executors.push(executor);
  return { executor, source: { manifest: bundle.manifest, bundleDir: bundle.bundleDir } };
}
afterAll(() => {
  for (const e of executors) e.close();
});

const INIT: ActorInit = {
  params: { threshold: 3 },
  seed: 11,
  symbol: 'BTCUSDT',
  subscriptions: [
    { subscriptionId: 'host', kind: 'host' },
    { subscriptionId: 'sub-req-candles', kind: 'candles', requirementId: 'req-candles' },
  ] as ActorInit['subscriptions'],
};

const CANDLE: ActorInputEvent = {
  kind: 'market.candle.closed',
  candle: {
    effectiveTsUs: 1_700_000_000_000_000,
    value: { open: 100, high: 105, low: 95, close: 101, volume: 10 },
    finality: 'final',
    revision: 0,
  },
} as ActorInputEvent;

/** Контекст в той форме, в какой его строит раннер: генератор с извлекаемым состоянием. */
function hostContext(over: Partial<HostActorContext> = {}, seed = 11): HostActorContext {
  return {
    clock: { nowUs: () => 1_700_000_000_000_000 as never },
    rng: createCheckpointableRng(rngStateFromSeed(seed)),
    readiness: 'ready',
    tradingState: 'normal',
    orders: { open: () => [] },
    position: () => undefined,
    ...over,
  } as HostActorContext;
}

/** Бандл-актор, который ЭХОМ отдаёт увиденное — иначе о той стороне границы известно только «не упало». */
const ECHO_ACTOR = `
export function createActor(init) {
  const seenInit = {
    params: init.params,
    seed: init.seed,
    symbol: init.symbol,
    subscriptionIds: init.subscriptions.map((s) => s.subscriptionId),
    subscriptionsFrozen: Object.isFrozen(init.subscriptions),
    initFrozen: Object.isFrozen(init),
  };
  return {
    onEvent(event, ctx) {
      return [{
        kind: 'annotate',
        note: JSON.stringify({
          init: seenInit,
          eventKind: event.kind,
          nowUs: ctx.clock.nowUs(),
          readiness: ctx.readiness,
          tradingState: ctx.tradingState,
          openOrderIds: ctx.orders.open().map((o) => o.clientOrderId),
          hasPosition: ctx.position() !== undefined,
          positionSide: ctx.position() === undefined ? null : ctx.position().side,
        }),
      }];
    },
  };
}
`;

const noteOf = (commands: readonly unknown[]): Record<string, unknown> =>
  JSON.parse((commands[0] as { note: string }).note) as Record<string, unknown>;

describe('тройка lifecycle работает через настоящую границу изолята', () => {
  it('create → event → dispose: команды автора доезжают обратно', async () => {
    const { executor, source } = executorFor(ECHO_ACTOR);
    const handle = await executor.createActor(source, INIT);
    const commands = await executor.executeActorEvent(handle, CANDLE, hostContext());
    expect(commands).toHaveLength(1);
    expect(noteOf(commands).eventKind).toBe('market.candle.closed');
    await executor.disposeActor(handle);
  }, 60_000);

  it('`ActorInit` пережил границу целиком: значения, ПОРЯДОК и неизменяемость', async () => {
    // Идентичности объектов за сериализацией не существует по построению — проверяется ровно то,
    // что за границей ещё проверяемо. Незамороженные подписки позволили бы стратегии дописать себе
    // источник и сверяться с собственным списком.
    const { executor, source } = executorFor(ECHO_ACTOR);
    const handle = await executor.createActor(source, INIT);
    const seen = noteOf(await executor.executeActorEvent(handle, CANDLE, hostContext())).init as
      Record<string, unknown>;
    expect(seen.params).toEqual({ threshold: 3 });
    expect(seen.seed).toBe(11);
    expect(seen.symbol).toBe('BTCUSDT');
    expect(seen.subscriptionIds).toEqual(['host', 'sub-req-candles']);
    expect(seen.subscriptionsFrozen).toBe(true);
    expect(seen.initFrozen).toBe(true);
    await executor.disposeActor(handle);
  }, 60_000);

  it('контекст восстановлен ФУНКЦИЯМИ, а не полями: автор читает документированную поверхность', async () => {
    // `JSON.stringify` молча выбрасывает функции. Не будь явной формы провода, `ctx.position`
    // приехал бы отсутствующим полем, и обращение к нему было бы TypeError — либо, что хуже,
    // `ctx.readiness` доехал бы, а `orders.open` нет, и стратегия увидела бы полупустой мир.
    const { executor, source } = executorFor(ECHO_ACTOR);
    const handle = await executor.createActor(source, INIT);
    const ctx = hostContext({
      readiness: 'warming_up',
      tradingState: 'reducing',
      orders: {
        open: () => [
          {
            clientOrderId: 'ord-1',
            side: 'buy',
            status: 'accepted',
            qtyUsd: 1000,
            filledQtyUsd: 0,
            createdTs: 1_700_000_000_000_000,
            type: 'market',
          } as never,
        ],
      },
      position: () =>
        ({
          side: 'long',
          qty: 9.9,
          avgEntryPrice: 101,
          openedAt: 1_700_000_000_000_000,
        }) as never,
    });
    const seen = noteOf(await executor.executeActorEvent(handle, CANDLE, ctx));
    expect(seen.nowUs).toBe(1_700_000_000_000_000);
    expect(seen.readiness).toBe('warming_up');
    expect(seen.tradingState).toBe('reducing');
    expect(seen.openOrderIds).toEqual(['ord-1']);
    expect(seen.hasPosition).toBe(true);
    expect(seen.positionSide).toBe('long');
    await executor.disposeActor(handle);
  }, 60_000);

  it('ПОТЕРЯННОЕ на проводе поле контекста — отказ, а не «пусто»', () => {
    // Прямая проба, потому что дефект здесь неотличим от нормы по значению: «книга пуста» и
    // «позиции нет» — ЗАКОННЫЕ состояния, и подстановка их на месте потерянного поля не оставила
    // бы следа нигде. Автор торговал бы по миру, которого не было.
    const full = {
      nowUs: 1,
      readiness: 'ready',
      tradingState: 'normal',
      openOrders: [],
      position: null,
      rng: { a: 0 },
    };
    const rng = harnessRng({ a: 0 }) as never;
    expect(() => rebuildActorContext(full, rng)).not.toThrow();

    const { openOrders: _o, ...noOrders } = full;
    expect(() => rebuildActorContext(noOrders, rng)).toThrow(/без openOrders/);
    const { position: _p, ...noPosition } = full;
    expect(() => rebuildActorContext(noPosition, rng)).toThrow(/без position/);
  });

  it('«позиции нет» доезжает как `undefined`, а не как пропавшее поле', async () => {
    // На проводе это `null`: `undefined` исчезает при `JSON.stringify`, и «позиции нет» стало бы
    // неотличимо от «поле потеряли по дороге».
    const { executor, source } = executorFor(ECHO_ACTOR);
    const handle = await executor.createActor(source, INIT);
    const seen = noteOf(await executor.executeActorEvent(handle, CANDLE, hostContext()));
    expect(seen.hasPosition).toBe(false);
    expect(seen.positionSide).toBeNull();
    await executor.disposeActor(handle);
  }, 60_000);
});

describe('атомарность владения — по счётчикам ОБЕИХ сторон границы', () => {
  it('модуль без createActor: создание отвергнуто, слотов не осталось ни у хоста, ни в изоляте', async () => {
    const { executor, source } = executorFor('export const nothing = 1;\n');
    await expect(executor.createActor(source, INIT)).rejects.toThrow(/не предоставляет createActor/);
    expect(executor.activeActorSessions()).toBe(0);
    expect(await executor.harnessActorSessions()).toBe(0);
  }, 60_000);

  it('createActor вернул не актора: то же самое — отказ ПОСЛЕ вызова фабрики ничего не оставляет', async () => {
    const { executor, source } = executorFor('export function createActor() { return {}; }\n');
    await expect(executor.createActor(source, INIT)).rejects.toThrow(/вернул не актора/);
    expect(executor.activeActorSessions()).toBe(0);
    expect(await executor.harnessActorSessions()).toBe(0);
  }, 60_000);

  it('фабрика бросила: отказ назван причиной автора, слот не заведён', async () => {
    const { executor, source } = executorFor(
      'export function createActor() { throw new Error("параметры не подходят"); }\n',
    );
    await expect(executor.createActor(source, INIT)).rejects.toThrow(/параметры не подходят/);
    expect(executor.activeActorSessions()).toBe(0);
    expect(await executor.harnessActorSessions()).toBe(0);
  }, 60_000);

  it('ПРОВЕРКА ПРОВЕРКИ: удачное создание слот ЗАВОДИТ по обе стороны, dispose снимает по обе', async () => {
    // Без этого «ноль слотов» выше зеленело бы у исполнителя, который их не заводит вовсе, — и
    // весь набор доказывал бы, что actor-путь не работает.
    const { executor, source } = executorFor(ECHO_ACTOR);
    const handle = await executor.createActor(source, INIT);
    expect(executor.activeActorSessions()).toBe(1);
    expect(await executor.harnessActorSessions()).toBe(1);
    await executor.disposeActor(handle);
    expect(executor.activeActorSessions()).toBe(0);
    expect(await executor.harnessActorSessions()).toBe(0);
    // Идемпотентность: повторное освобождение — no-op, а не бросок.
    await executor.disposeActor(handle);
    expect(executor.activeActorSessions()).toBe(0);
  }, 60_000);

  it('серия отвергнутых созданий не копит слотов — счётчики возвращаются к исходным', async () => {
    const { executor, source } = executorFor('export function createActor() { return null; }\n');
    for (let i = 0; i < 5; i += 1) {
      await expect(executor.createActor(source, INIT)).rejects.toThrow(/вернул не актора/);
    }
    expect(executor.activeActorSessions()).toBe(0);
    expect(await executor.harnessActorSessions()).toBe(0);
  }, 60_000);

  it('два актора одного бандла живут независимо и освобождаются поимённо', async () => {
    const { executor, source } = executorFor(ECHO_ACTOR);
    const a = await executor.createActor(source, INIT);
    const b = await executor.createActor(source, { ...INIT, symbol: 'ETHUSDT' });
    expect(await executor.harnessActorSessions()).toBe(2);
    await executor.disposeActor(a);
    expect(await executor.harnessActorSessions()).toBe(1);
    // Второй жив: освобождение первого не задело его.
    const seen = noteOf(await executor.executeActorEvent(b, CANDLE, hostContext())).init as
      Record<string, unknown>;
    expect(seen.symbol).toBe('ETHUSDT');
    await executor.disposeActor(b);
    expect(await executor.harnessActorSessions()).toBe(0);
  }, 60_000);

  it('освобождённый дескриптор больше не адресует ничего — доставка отвергается, а не молчит', async () => {
    const { executor, source } = executorFor(ECHO_ACTOR);
    const handle = await executor.createActor(source, INIT);
    await executor.disposeActor(handle);
    await expect(executor.executeActorEvent(handle, CANDLE, hostContext())).rejects.toThrow(
      /дескриптор неизвестен/,
    );
  }, 60_000);

  it('чужой манифест отвергается ДО подъёма изолята — работы не начиналось вовсе', async () => {
    // Счётчик изолята здесь НЕ спрашивается, и это не пропуск проверки, а её содержание: изолята
    // ещё не существует, спрашивать некого. Соблазн заставить `harnessActorSessions()` отвечать
    // нулём на закрытом изоляте велик и ядовит — «утечки нет» стало бы неотличимо от «спросить
    // некого», и КАЖДОЕ утверждение этого набора зеленело бы против неподнятого изолята.
    //
    // Отсутствие изолята — исход СИЛЬНЕЕ нулевого счётчика: не создано ничего, что могло бы течь.
    const { executor, source } = executorFor(ECHO_ACTOR);
    const alien: ActorSource = {
      ...source,
      manifest: { ...source.manifest, id: 'someone_else' } as never,
    };
    await expect(executor.createActor(alien, INIT)).rejects.toThrow(/поднят вокруг бандла/);
    expect(executor.activeActorSessions()).toBe(0);
    await expect(executor.harnessActorSessions()).rejects.toThrow();
  }, 60_000);

  it('чужой манифест на ЖИВОМ изоляте не задевает уже созданного актора', async () => {
    // Вторая половина того же требования, и без неё первая ничего не говорит про утечку: там
    // изолята нет, здесь он есть и населён. Проверяется, что отвергнутое создание не добавило
    // слота и не сняло чужого.
    const { executor, source } = executorFor(ECHO_ACTOR);
    const live = await executor.createActor(source, INIT);
    expect(await executor.harnessActorSessions()).toBe(1);
    const alien: ActorSource = {
      ...source,
      manifest: { ...source.manifest, version: '9.9.9' } as never,
    };
    await expect(executor.createActor(alien, INIT)).rejects.toThrow(/поднят вокруг бандла/);
    expect(executor.activeActorSessions()).toBe(1);
    expect(await executor.harnessActorSessions()).toBe(1);
    // И живой актор действительно жив, а не просто числится.
    expect(noteOf(await executor.executeActorEvent(live, CANDLE, hostContext())).eventKind).toBe(
      'market.candle.closed',
    );
    await executor.disposeActor(live);
  }, 60_000);
});

describe('атомарность САМОГО харнесса — без страховки хоста', () => {
  // ЭТОТ НАБОР ЗАВЕДЁН МУТАЦИЕЙ, КОТОРАЯ НИЧЕГО НЕ ПОКРАСИЛА.
  //
  // Перестановка `store.set` ПЕРЕД проверкой формы актора обязана была уронить «слот не заведён» —
  // и не уронила. Причина: хост на пути отказа зовёт `disposeActor` в изоляте (страховка на случай
  // «слот заведён, но ответ не доехал»), и она же прибирает слот, заведённый ошибочно.
  //
  // Поведение прода от этого верное: два независимых механизма, и защита в глубину сработала. Но
  // утверждения выше доказывали ИСХОД («после отвергнутого создания слотов нет»), а не МЕХАНИЗМ,
  // который харнесс заявляет о себе сам («запись — последняя строка удачного пути»). Пока механизм
  // не пиннут, его можно сломать, не покрасив ни строки, — и утечка появится в тот день, когда
  // страховка хоста не сработает: сессия мертва, изолят снят, ответ не доехал.
  //
  // Поэтому здесь харнесс вызывается НАПРЯМУЮ, без хоста и без изолята: страховки, которая могла
  // бы подменить результат, в этой цепочке просто нет.

  const module = (createActor: unknown): unknown => ({ createActor });

  it('модуль без createActor: таблица осталась пустой', () => {
    const store = makeActorStore();
    expect(createActorSlot(store, {}, 'a-0', INIT).ok).toBe(false);
    expect(store.size).toBe(0);
  });

  it('фабрика вернула не актора: таблица осталась пустой', () => {
    const store = makeActorStore();
    expect(createActorSlot(store, module(() => ({})), 'a-0', INIT).ok).toBe(false);
    expect(store.size).toBe(0);
  });

  it('фабрика вернула null: таблица осталась пустой', () => {
    const store = makeActorStore();
    expect(createActorSlot(store, module(() => null), 'a-0', INIT).ok).toBe(false);
    expect(store.size).toBe(0);
  });

  it('фабрика бросила: таблица осталась пустой', () => {
    const store = makeActorStore();
    const boom = (): never => {
      throw new Error('нет');
    };
    expect(createActorSlot(store, module(boom), 'a-0', INIT).ok).toBe(false);
    expect(store.size).toBe(0);
  });

  it('занятый дескриптор не перезаписывается: прежний актор остаётся тем же', () => {
    // Тихая перезапись потеряла бы прежнего актора вместе со всем его состоянием, а хост продолжал
    // бы адресовать его тем же дескриптором и получать ответы чужого.
    const store = makeActorStore();
    const first = { onEvent: () => [] };
    expect(createActorSlot(store, module(() => first), 'a-0', INIT).ok).toBe(true);
    const r = createActorSlot(store, module(() => ({ onEvent: () => [] })), 'a-0', INIT);
    expect(r.ok).toBe(false);
    expect(store.size).toBe(1);
    expect((store.get('a-0') as { actor: unknown }).actor).toBe(first);
  });

  it('ПРОВЕРКА ПРОВЕРКИ: удачное создание слот ЗАВОДИТ', () => {
    // Иначе «таблица пуста» выше зеленело бы у функции, которая не заводит слотов никогда.
    const store = makeActorStore();
    expect(createActorSlot(store, module(() => ({ onEvent: () => [] })), 'a-0', INIT).ok).toBe(true);
    expect(store.size).toBe(1);
  });
});

describe('отказ доставки ГРОМКИЙ — пустой батч зарезервирован за автором', () => {
  it('бросок из onEvent валит прогон, а не превращается в «стратегия ничего не решила»', async () => {
    const { executor, source } = executorFor(
      'export function createActor() { return { onEvent() { throw new Error("автор упал"); } }; }\n',
    );
    const handle = await executor.createActor(source, INIT);
    await expect(executor.executeActorEvent(handle, CANDLE, hostContext())).rejects.toThrow(
      /автор упал/,
    );
  }, 60_000);

  it('не-массив вместо батча отвергается', async () => {
    const { executor, source } = executorFor(
      'export function createActor() { return { onEvent() { return { kind: "annotate", note: "x" }; } }; }\n',
    );
    const handle = await executor.createActor(source, INIT);
    await expect(executor.executeActorEvent(handle, CANDLE, hostContext())).rejects.toThrow(
      /батч команд не массив/,
    );
  }, 60_000);

  it('команда, не проходящая СХЕМУ КОНТРАКТА, отвергается вместе со всем батчем', async () => {
    // `qtyUsd: 0` — не «нулевая заявка», а нарушение `exclusiveMinimum` схемы. Проверяется схемой
    // контракта, а не самописным разбором полей: вторая мерка того же предмета разошлась бы с
    // первой молча и разошлась бы в сторону «хост принял то, чего контракт не разрешает».
    const { executor, source } = executorFor(
      'export function createActor() { return { onEvent() { return [{ kind: "place", type: "market", clientOrderId: "x", side: "buy", qtyUsd: 0 }]; } }; }\n',
    );
    const handle = await executor.createActor(source, INIT);
    await expect(executor.executeActorEvent(handle, CANDLE, hostContext())).rejects.toThrow(
      /схеме контракта/,
    );
  }, 60_000);

  it('промис вместо батча отвергается названной причиной, а не ожиданием', async () => {
    const { executor, source } = executorFor(
      'export function createActor() { return { onEvent() { return Promise.resolve([]); } }; }\n',
    );
    const handle = await executor.createActor(source, INIT);
    await expect(executor.executeActorEvent(handle, CANDLE, hostContext())).rejects.toThrow(
      /обязан отвечать синхронно/,
    );
  }, 60_000);

  it('ПРОВЕРКА ПРОВЕРКИ: законный пустой батч проходит — гейт отвергает не всё подряд', () => {
    // Иначе утверждения выше зеленели бы у ревалидатора, который не принимает ничего, и «отказ
    // громкий» означало бы «actor-путь не работает вовсе».
    expect(revalidateActorCommands([])).toEqual({ ok: true, commands: [] });
    expect(revalidateActorCommands([{ kind: 'annotate', note: 'ok' }]).ok).toBe(true);
  });
});

describe('лента случайности — ОДНА на обе стороны границы', () => {
  it('обе копии mulberry32 дают одну последовательность', () => {
    // Копия внутри изолята вынужденная (там нет node_modules), и это второе место, где живёт одно
    // правило. Расхождение таких пар ловится гейтом, а не надеждой: разойдись они — актор в
    // песочнице и актор в процессе получили бы разные числа при одном seed, и происхождение
    // расхождения искали бы в стратегии.
    const engine = createCheckpointableRng(rngStateFromSeed(1234));
    const harness = harnessRng(rngStateFromSeed(1234)) as { next(): number; snapshot(): { a: number } };
    for (let i = 0; i < 64; i += 1) {
      expect(harness.next()).toBe(engine.next());
      expect(harness.snapshot().a).toBe(engine.snapshot().a);
    }
  });

  it('розыгрыши автора за границей двигают генератор ХОСТА на столько же', async () => {
    // Дом генератора — хост (§3.6): `ctx.rng` автора обязан продолжать ОДНУ последовательность
    // через всю жизнь актора. Засей изолят «свой» от seed — совпадение держалось бы ровно до
    // первого прогона, где число вызовов `next()` разойдётся.
    const { executor, source } = executorFor(
      'export function createActor() { return { onEvent(_e, ctx) { const v = [ctx.rng.next(), ctx.rng.next(), ctx.rng.next()]; return [{ kind: "annotate", note: JSON.stringify(v) }]; } }; }\n',
    );
    const handle = await executor.createActor(source, INIT);
    const ctx = hostContext({}, 4242);
    const drawn = JSON.parse(
      (
        (await executor.executeActorEvent(handle, CANDLE, ctx))[0] as { note: string }
      ).note,
    ) as number[];

    // Те же три числа, что выдал бы генератор хоста, если бы актор жил в этом процессе.
    const mirror = createCheckpointableRng(rngStateFromSeed(4242));
    expect(drawn).toEqual([mirror.next(), mirror.next(), mirror.next()]);
    // И положение хостового генератора догнало положение зеркала — то есть следующее событие
    // продолжит ТУ ЖЕ ленту, а не начнёт её заново.
    expect(ctx.rng.snapshot()).toEqual(mirror.snapshot());
    await executor.disposeActor(handle);
  }, 60_000);

  it('автор, не тянувший чисел, генератор не двигает', async () => {
    const { executor, source } = executorFor(ECHO_ACTOR);
    const handle = await executor.createActor(source, INIT);
    const ctx = hostContext({}, 7);
    const before = ctx.rng.snapshot();
    await executor.executeActorEvent(handle, CANDLE, ctx);
    expect(ctx.rng.snapshot()).toEqual(before);
    await executor.disposeActor(handle);
  }, 60_000);

  it('состояние генератора — недоверенный вход: форма проверяется значением', () => {
    // Прямая проба формы: до `adoptRngState` испорченное состояние доходить не должно, а гейт на
    // нём стоит потому, что принять от бандла произвольное положение ленты значило бы отдать
    // недоверенному коду руль над детерминизмом прогона.
    expect(isRngStateWire({ a: 0 })).toBe(true);
    expect(isRngStateWire({ a: 0xffffffff })).toBe(true);
    expect(isRngStateWire({ a: -1 })).toBe(false);
    expect(isRngStateWire({ a: 1.5 })).toBe(false);
    expect(isRngStateWire({ a: 0x1_0000_0000 })).toBe(false);
    expect(isRngStateWire({ a: Number.NaN })).toBe(false);
    expect(isRngStateWire({})).toBe(false);
    expect(isRngStateWire(null)).toBe(false);
  });
});
