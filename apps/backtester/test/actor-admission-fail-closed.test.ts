// 083 S3 — допуск на actor-путь: срез FAIL-CLOSED целиком.
//
// ГЛАВНОЕ УТВЕРЖДЕНИЕ НАБОРА, и оно одно: НИ ОДИН набор условий не проваливается в legacy. Включая
// тот, где всё совместимо — флаг включён, режимы не мешают, у исполнителя есть полный lifecycle
// актора, `marketData` объявлен как того требует контракт. Даже там отказ, потому что проекция
// ledger → артефакты ещё не подключена, и успешный прогон вернул бы пустые артефакты.
//
// Пустой успех ХУЖЕ отказа: у отказа есть код, причина и адресат, у пустого успеха нет ничего, а
// обнаруживается он у того, кто сравнивает результаты двух lifecycle и видит правдоподобные числа.
//
// Проверяется ДО init: ни одна ветка допуска не создаёт env, не зовёт `initStrategy` и не трогает
// модуль. Тест на это стоит отдельно — «до init» легко заявить и трудно заметить, когда перестало
// быть правдой.

import { describe, expect, it } from 'vitest';

import { admitActorExecutor, admitActorRun, isEventDriven } from '../src/engine/actor/admission.js';
import { supportsActorLifecycle } from '../src/engine/actor/execution-handle.js';
import type { ActorLifecycleExecutor } from '../src/engine/actor/execution-handle.js';
import type { ResolvedStrategy } from '../src/engine/artifacts.js';

/** Резолвнутая стратегия с заданной формой жизненного цикла. */
const strategyWith = (over: Record<string, unknown> = {}): ResolvedStrategy =>
  ({
    manifest: {
      id: 'demo',
      version: '1.0.0',
      kind: 'strategy',
      lifecycle: 'event_driven',
      ...over,
    },
    module: {},
  }) as unknown as ResolvedStrategy;

/**
 * ПОЛНЫЙ допуск — обе части подряд, в том же порядке, что и раннер.
 *
 * Допуск разделён надвое не по вкусу: конфигурационная часть исполняется ДО построения router'а
 * (иначе созданный router утекал бы на пути отказа, минуя `finally`), исполнительская — внутри
 * `try`. Тесты обязаны ходить тем же порядком, иначе они проверяют не то, что исполняется.
 */
const admit = (input: ReturnType<typeof allCompatible>) =>
  admitActorRun(input) ?? admitActorExecutor(input.strategy, input.executor);

/** Исполнитель с ПОЛНЫМ lifecycle актора — способность есть. */
const capableExecutor = (): Partial<ActorLifecycleExecutor> => ({
  createActor: async () => ({}) as never,
  executeActorEvent: async () => [],
  disposeActor: async () => {},
});

/**
 * Все условия совместимы: единственный набор, который «должен был бы» пройти.
 *
 * `marketData` здесь НЕПУСТ, и это не деталь фикстуры. Контракт 017.4 требует от `event_driven`
 * объявить хотя бы одно требование (`missing_market_data_requirement`), а модульная валидация в
 * `runBacktest` идёт ДО допуска — значит манифест с пустым `marketData` до допуска не доезжает
 * вовсе. Фикстура без него описывала бы состояние, которого не бывает, и тест проходил бы «по
 * несуществующей причине».
 */
const allCompatible = () => ({
  strategy: strategyWith({ marketData: [{ id: 'oi', kind: 'open_interest' }] }),
  eventDrivenEnabled: true,
  barBatching: false,
  barMajorBatch: false,
  executor: capableExecutor(),
});

describe('S3: семантику выбирает только manifest.lifecycle', () => {
  it('single_position не трогается допуском вовсе', () => {
    // Legacy-путь обязан остаться нетронутым: `null` означает «это не наша забота».
    expect(admit({ ...allCompatible(), strategy: strategyWith({ lifecycle: 'single_position' }) })).toBeNull();
  });

  it('отсутствующий lifecycle — тоже legacy (манифесты 017.1–017.2)', () => {
    const legacy = strategyWith();
    delete (legacy.manifest as unknown as Record<string, unknown>).lifecycle;
    expect(admit({ ...allCompatible(), strategy: legacy })).toBeNull();
  });

  it('флаг НЕ выбирает семантику: с выключенным флагом legacy по-прежнему проходит', () => {
    // Если бы флаг был осью семантики, его выключение меняло бы поведение legacy-стратегии. Не
    // меняет — и это ровно то, ради чего оси разведены.
    expect(
      admit({
        ...allCompatible(),
        eventDrivenEnabled: false,
        strategy: strategyWith({ lifecycle: 'single_position' }),
      }),
    ).toBeNull();
  });

  it('isEventDriven читает только lifecycle', () => {
    expect(isEventDriven(strategyWith())).toBe(true);
    expect(isEventDriven(strategyWith({ lifecycle: 'single_position' }))).toBe(false);
  });
});

describe('S3: НИ ОДИН набор условий не проваливается в legacy', () => {
  // Перебор построен так, чтобы покрыть каждую причину отказа И их сочетания: набор, где
  // «сработала бы первая», не доказывает, что сработала бы вторая.
  const cases: readonly { readonly name: string; readonly input: ReturnType<typeof allCompatible> }[] = [
    { name: 'флаг выключен', input: { ...allCompatible(), eventDrivenEnabled: false } },
    { name: 'BAR_BATCHING включён', input: { ...allCompatible(), barBatching: true } },
    { name: 'barMajorBatch включён', input: { ...allCompatible(), barMajorBatch: true } },
    { name: 'исполнитель без lifecycle', input: { ...allCompatible(), executor: {} } },
    {
      name: 'исполнитель умеет create, но не dispose',
      input: { ...allCompatible(), executor: { createActor: async () => ({}) as never, executeActorEvent: async () => [] } },
    },
    { name: 'ВСЁ совместимо', input: allCompatible() },
    {
      name: 'marketData пуст — допуск его НЕ читает, отказ тот же',
      input: { ...allCompatible(), strategy: strategyWith({ marketData: [] }) },
    },
    {
      name: 'флаг выключен И BAR_BATCHING',
      input: { ...allCompatible(), eventDrivenEnabled: false, barBatching: true },
    },
    {
      name: 'всё несовместимо разом',
      input: {
        ...allCompatible(),
        eventDrivenEnabled: false,
        barBatching: true,
        barMajorBatch: true,
        executor: {},
      },
    },
  ];

  it.each(cases)('$name → unsupported_lifecycle, а не legacy', ({ input }) => {
    const refusal = admit(input);
    expect(refusal).not.toBeNull();
    expect(refusal!.code).toBe('unsupported_lifecycle');
  });

  it.each(cases)('$name → path пустой', ({ input }) => {
    // Нарушающего узла нет: запрос корректен, манифест безупречен, не совпадает окружение.
    // `/moduleRef` обвинил бы валидный узел.
    expect(admit(input)!.path).toBe('');
  });

  it.each(cases)('$name → причина названа, а не «отказано»', ({ input }) => {
    // Отказ без причины отправляет оператора выяснять заново то, что допуск уже знал.
    expect(admit(input)!.message.length).toBeGreaterThan(60);
  });
});

describe('S3: ПОЛНОСТЬЮ совместимый набор всё равно отвергается', () => {
  // Отдельно от перебора, потому что это утверждение среза, а не одна из его строк: пока нет
  // проекции ledger → артефакты, успешного actor-прогона не существует.
  it('отказ называет именно отсутствие проекции, а не что-то другое', () => {
    const refusal = admit(allCompatible());
    expect(refusal!.message).toMatch(/проекц/);
  });

  it('и это ЕДИНСТВЕННОЕ, что мешает: остальные причины к нему не относятся', () => {
    // Проверка проверки. Если бы совместимый набор отвергался, скажем, по способности исполнителя,
    // снятие последнего отказа не открыло бы путь — и мы бы этого не заметили.
    const refusal = admit(allCompatible());
    expect(refusal!.message).not.toMatch(/BACKTESTER_EVENT_DRIVEN_ENABLED|BAR_BATCHING|BAR_MAJOR_BATCH/);
  });

  it('объявленный marketData НЕ перебивает отказ по проекции', () => {
    // Порядок проверок здесь несущий, а не косметический. Контракт 017.4 требует от event_driven
    // непустой marketData, и модульная валидация идёт ДО допуска — значит проверка marketData,
    // стоящая выше, срабатывала бы ВСЕГДА, а отказ по проекции не срабатывал бы никогда. Оператор
    // получал бы «объявлен marketData» и шёл править манифест, которого нечем исполнить вовсе.
    const withMany = admit({
      ...allCompatible(),
      strategy: strategyWith({ marketData: [{ id: 'oi' }, { id: 'liq' }, { id: 'funding' }] }),
    });
    expect(withMany!.message).toMatch(/проекц/);
  });
});

describe('S3: способность исполнителя — ЦЕЛОЕ, а не метод', () => {
  it('полный lifecycle распознаётся', () => {
    expect(supportsActorLifecycle(capableExecutor())).toBe(true);
  });

  it.each([
    ['без createActor', { executeActorEvent: async () => [], disposeActor: async () => {} }],
    ['без executeActorEvent', { createActor: async () => ({}) as never, disposeActor: async () => {} }],
    ['без disposeActor', { createActor: async () => ({}) as never, executeActorEvent: async () => [] }],
    ['пустой', {}],
  ])('%s — способности нет', (_name, executor) => {
    // Исполнитель, умеющий создать актора и не умеющий освободить, оставил бы сессию на каждый
    // прогон. Узнать об этом на допуске дешевле, чем на dispose последнего символа.
    expect(supportsActorLifecycle(executor as Partial<ActorLifecycleExecutor>)).toBe(false);
  });
});

describe('S3: допуск не трогает модуль', () => {
  it('ни одна ветка не зовёт init/dispose и не создаёт актора', () => {
    // «До init» легко заявить и трудно заметить, когда перестало быть правдой. Здесь исполнитель
    // считает вызовы: любой из них означал бы, что отказ обошёлся дороже, чем должен.
    const calls: string[] = [];
    const spy: Partial<ActorLifecycleExecutor> = {
      createActor: async () => {
        calls.push('createActor');
        return {} as never;
      },
      executeActorEvent: async () => {
        calls.push('executeActorEvent');
        return [];
      },
      disposeActor: async () => {
        calls.push('disposeActor');
      },
    };
    admit({ ...allCompatible(), executor: spy });
    expect(calls).toEqual([]);
  });
});
