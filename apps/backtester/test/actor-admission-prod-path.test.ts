// ГЕЙТ: отказ actor-пути доходит до прогона ЦЕЛИКОМ — через `runBacktest` и через прод-проводку.
//
// Почему отдельно от `actor-admission-fail-closed.test.ts`. Тот доказывает РЕШЕНИЕ: при каком
// наборе условий допуск отказывает и с какой причиной. Он вызывает функции допуска напрямую и про
// раннер, конфиг, воркера и поток не знает ничего.
//
// Здесь проверяется другое и ровно то, что сломалось бы молча: доезжает ли флаг до прогона ВООБЩЕ
// и отвергается ли `event_driven` НА САМОМ ДЕЛЕ, а не только в чистой функции. Ровно этот класс уже
// стоил репозиторию дефекта: `contextFreeze` считался в конфиге, `StrategyRunDeps` его не принимал,
// и развёртывание просило снять заморозку, а она молча оставалась (см.
// `context-freeze-prod-path.test.ts`). Разница в том, что там расходилась СТОИМОСТЬ при верных
// числах, а здесь разошлось бы то, ЧТО исполнялось.
//
// Обе дороги — прямая и потоковая — потому что флаг едет к ним разными путями: прямая берёт его из
// `runFlags`, потоковая — тем же объектом через `ThreadRunFlags` и structured clone. Разъехаться
// они могут независимо, и тогда одна дорога отвергала бы манифест, а другая нет.

import { describe, expect, it } from 'vitest';
import { CONTRACT_VERSION } from '@trading/research-contracts/research';
import type {
  ExecutionProfile,
  StrategyContext,
  StrategyDecision,
  StrategyModule,
} from '@trading/research-contracts/research';

import { buildTape, makeRequest } from '../scripts/lib/profile-runner-fixture.js';
import { createModuleRegistry } from '../src/engine/sandbox/routing.js';
import { createTrustedRouter } from '../src/engine/module-executor.js';
import { DEFAULT_RISK } from '../src/engine/profiles.js';
import { runStrategyBacktest } from '../src/engine/run-strategy.js';
import type { RunOutcome } from '../src/engine/artifacts.js';

const BASE_MANIFEST = {
  version: '1.0.0',
  kind: 'strategy' as const,
  name: 'admission probe',
  summary: 'зонд допуска actor-пути',
  rationale: 'гейт проводки флага и отказа',
  author: 'agent',
  contractVersion: CONTRACT_VERSION,
  status: 'research_only' as const,
  paramsSchema: { type: 'object', additionalProperties: false, properties: {} },
  params: {},
  capabilities: { platformSdk: true },
  dataNeeds: { closedCandlesUpToCurrent: true, asOfIndicators: false },
  hooks: ['onBarClose'],
};

/**
 * Зонд, СЧИТАЮЩИЙ вызовы хука.
 *
 * Ноль вызовов при отказе — это и есть «до init»: отклонённый прогон не должен успеть тронуть
 * модуль. Проверять это косвенно (по отсутствию артефактов) нельзя — артефактов не будет и у
 * прогона, который стратегию звал и упал позже.
 */
function probe(overrides: Record<string, unknown>): {
  readonly registry: ReturnType<typeof createModuleRegistry>;
  readonly calls: string[];
  readonly moduleRef: { id: string; version: string };
} {
  const calls: string[] = [];
  const manifest = { ...BASE_MANIFEST, id: 'admission_probe', ...overrides };
  const make = (): StrategyModule =>
    ({
      manifest,
      onBarClose(_ctx: StrategyContext): StrategyDecision {
        calls.push('onBarClose');
        return { kind: 'idle' };
      },
    }) as unknown as StrategyModule;

  const noCost: ExecutionProfile = {
    id: 'paper_match',
    version: '1.0.0',
    fillModel: { kind: 'same_bar_close' } as never,
    feeModel: { kind: 'fixed_bps', bps: 0 },
    slippageModel: { kind: 'fixed_bps', bps: 0 },
  };

  return {
    registry: createModuleRegistry({
      strategies: [Object.assign(make(), { moduleFactory: make })],
      riskProfiles: [DEFAULT_RISK],
      executionProfiles: [noCost],
    }),
    calls,
    moduleRef: { id: manifest.id, version: manifest.version },
  };
}

const SPEC = { symbols: ['BTCUSDT'], bars: 20, seed: 7, barMajor: false, marketKinds: true };

/**
 * Router, чей исполнитель УМЕЕТ полный lifecycle актора.
 *
 * Нужен потому, что сегодня его не умеет никто: реализация seam'а — следующий срез. Без подстановки
 * прогон с включённым флагом упирался бы в отказ по способности, и условие «при НАЛИЧИИ capability
 * всё равно отказ по проекции» осталось бы непроверенным — то есть непроверенным осталось бы
 * главное утверждение среза.
 *
 * Методы-заглушки не вызываются ни разу: допуск отказывает раньше. Счётчик ниже это и доказывает.
 */
function capableRouter(calls: string[]) {
  const base = createTrustedRouter();
  const augment = (ex: unknown): unknown =>
    Object.assign(Object.create(Object.getPrototypeOf(ex) as object), ex, {
      createActor: async () => {
        calls.push('createActor');
        return {};
      },
      executeActorEvent: async () => {
        calls.push('executeActorEvent');
        return [];
      },
      disposeActor: async () => {
        calls.push('disposeActor');
      },
    });
  return {
    forStrategy: (r: never) => augment(base.forStrategy(r)),
    forOverlay: (r: never) => base.forOverlay(r),
    closeAll: () => base.closeAll(),
  };
}

/**
 * Router, чей исполнитель lifecycle актора НЕ умеет.
 *
 * Нужен с тех пор, как его умеет прямой: без явно неспособного исполнителя гейт способности стало
 * бы нечем проверить, а он остаётся верным для sandbox-исполнителей — им lifecycle не реализован.
 */
function incapableRouter() {
  const base = createTrustedRouter();
  const strip = (ex: unknown): unknown => {
    const { createActor: _c, executeActorEvent: _e, disposeActor: _d, ...rest } = ex as Record<string, unknown>;
    // Прототипные методы класса тоже надо снять — копия полей их бы унаследовала.
    const flat: Record<string, unknown> = { ...rest };
    for (const key of ['executeStrategyHook', 'executeOverlayApply', 'executeStrategyHookBarMajor', 'initStrategy', 'disposeStrategy', 'close']) {
      const fn = (ex as Record<string, unknown>)[key];
      if (typeof fn === 'function') flat[key] = (fn as (...a: unknown[]) => unknown).bind(ex);
    }
    return flat;
  };
  return {
    forStrategy: (r: never) => strip(base.forStrategy(r)),
    forOverlay: (r: never) => base.forOverlay(r),
    closeAll: () => base.closeAll(),
  };
}

async function runThrough(
  overrides: Record<string, unknown>,
  deps: {
    readonly eventDrivenEnabled?: boolean;
    readonly barBatching?: { maxBars: number };
    readonly capableExecutor?: boolean;
    readonly incapableExecutor?: boolean;
  } = {},
): Promise<{ outcome: RunOutcome; calls: string[] }> {
  const p = probe(overrides);
  const { capableExecutor, incapableExecutor, ...runDeps } = deps;
  const router =
    capableExecutor === true
      ? capableRouter(p.calls)
      : incapableExecutor === true
        ? incapableRouter()
        : createTrustedRouter();
  const outcome = await runStrategyBacktest(
    { ...makeRequest(SPEC), moduleRef: p.moduleRef },
    {
      registry: p.registry,
      marketTape: buildTape(SPEC),
      router,
      ...runDeps,
    } as never,
  );
  return { outcome, calls: p.calls };
}

/** Причина отказа в форме, пригодной для утверждений. */
const refusalOf = (outcome: RunOutcome): { code?: string; path?: string; message?: string } => {
  const issues = (outcome as { validation?: { issues?: { code: string; path: string; message: string }[] } })
    .validation?.issues;
  return issues?.[0] ?? {};
};

describe('сквозь runBacktest: event_driven отвергается, а не исполняется по-старому', () => {
  // Манифест event-driven здесь ОБЯЗАН нести marketData: контракт 017.4 отвергает его без них
  // раньше допуска (`missing_market_data_requirement`), и фикстура без них проверяла бы состояние,
  // которого не бывает.
  const eventDriven = {
    lifecycle: 'event_driven',
    // Форма требования взята из тестов sdk, а не угадана: схема анйОф'а требует разный набор
    // полей на каждый `kind`, и придуманная форма отвергается раньше допуска как `schema_invalid`
    // — то есть тест зеленел бы, ни разу не доехав до проверяемого.
    marketData: [
      {
        kind: 'candles',
        id: 'req-candles',
        instrument: { venue: 'binance', symbol: 'BTCUSDT' },
        interval: 60_000_000,
        lookback: 5,
        revisionPolicy: { mode: 'final_only' },
        priceType: 'trade',
      },
    ],
    hooks: ['onEvent'],
  };

  it('флаг выключен → unsupported_lifecycle с пустым path, стратегия НЕ звана', async () => {
    const { outcome, calls } = await runThrough(eventDriven);
    expect(outcome.status).toBe('rejected');
    const r = refusalOf(outcome);
    expect(r.code).toBe('unsupported_lifecycle');
    expect(r.path).toBe('');
    // Ноль вызовов — это «до init» наблюдаемо снаружи, а не по заявлению в комментарии.
    expect(calls).toEqual([]);
  }, 60_000);

  it('исполнитель БЕЗ lifecycle актора → отказ по способности', async () => {
    // Прямой исполнитель lifecycle УЖЕ умеет (S3), поэтому неспособного приходится предъявить
    // явно — иначе гейт способности перестал бы проверяться вовсе, а он остаётся верным для
    // sandbox-исполнителей, которым lifecycle ещё не реализован.
    const { outcome, calls } = await runThrough(eventDriven, {
      eventDrivenEnabled: true,
      incapableExecutor: true,
    });
    expect(outcome.status).toBe('rejected');
    expect(refusalOf(outcome).code).toBe('unsupported_lifecycle');
    expect(refusalOf(outcome).message).toMatch(/lifecycle актора/);
    expect(calls).toEqual([]);
  }, 60_000);

  it('прямой исполнитель умеет lifecycle → путь идёт дальше, до риск-контура', async () => {
    // Отличие от пробы выше ровно в исполнителе: способность больше не является тем, что закрывает
    // путь у trusted. Закрывает его профиль риска — и отказ обязан называть именно это, иначе
    // чинить пойдут не то.
    const { outcome, calls } = await runThrough(eventDriven, { eventDrivenEnabled: true });
    expect(outcome.status).toBe('rejected');
    expect(refusalOf(outcome).code).toBe('unsupported_lifecycle');
    expect(refusalOf(outcome).message).toMatch(/профиль риска/);
    expect(calls).toEqual([]);
  }, 60_000);

  it('флаг включён, режимы совместимы, capability ЕСТЬ → отказ по НЕСОБЛЮДАЕМОМУ риск-контуру', async () => {
    // Требование владельца дословно: ни один набор условий не проваливается в legacy, включая
    // полностью совместимый. Проверяется через подставленного способного исполнителя.
    //
    // ПРИЧИНА ОТКАЗА СМЕНИЛАСЬ ВМЕСТЕ С КОДОМ. Прежде путь упирался в отсутствие проекции; теперь
    // проекция, раннер и продовая точка вызова подключены, и прогон доходит до допуска подписок,
    // где и отвергается: фикстура датасета не объявляет происхождения свечей. Это состояние ВСЕХ
    // реальных датасетов, поэтому поведение прода не изменилось — изменилось лишь то, КАКАЯ
    // проверка его удерживает, и она теперь называет конкретный несошедшийся параметр.
    const { outcome, calls } = await runThrough(eventDriven, {
      eventDrivenEnabled: true,
      capableExecutor: true,
    });
    expect(outcome.status).toBe('rejected');
    const r = refusalOf(outcome);
    expect(r.code).toBe('unsupported_lifecycle');
    expect(r.path).toBe('');
    // ПЕРВЫМ срабатывает риск-контур: профиль прогона по умолчанию объявляет лимиты, которых
    // actor-путь не соблюдает. Происхождение свечей проверяется следом — обе проверки
    // fail-closed, и порядок между ними значения не имеет, важно что путь закрыт до создания
    // актора. Ровно эту причину и надо назвать: отказ, называющий не своё, отправляет чинить
    // не то.
    expect(r.message).toMatch(/профиль риска|происхождение свечей не доказано/);
    // Актор так и не создан: отказ случается ДО `createActor`, и счётчик это доказывает.
    expect(calls).toEqual([]);
  }, 60_000);

  it('флаг включён + BAR_BATCHING → отказ называет батчинг, а не проекцию', async () => {
    const { outcome } = await runThrough(eventDriven, {
      eventDrivenEnabled: true,
      barBatching: { maxBars: 8 },
    });
    expect(refusalOf(outcome).code).toBe('unsupported_lifecycle');
    expect(refusalOf(outcome).message).toMatch(/BAR_BATCHING/);
  }, 60_000);

  it('ПРОВЕРКА ПРОВОДКИ: legacy-стратегия проходит при ЛЮБОМ значении флага', async () => {
    // Без этого все проверки выше позеленели бы и на допуске, отвергающем всё подряд: «отказано»
    // ничего не доказывает, пока не показано, что что-то проходит.
    const off = await runThrough({});
    const on = await runThrough({}, { eventDrivenEnabled: true });
    expect(off.outcome.status).toBe('completed');
    expect(on.outcome.status).toBe('completed');
    expect(on.calls.length).toBeGreaterThan(0);
  }, 120_000);
});
