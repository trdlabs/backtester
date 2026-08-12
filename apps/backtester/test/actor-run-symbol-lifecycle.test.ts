// ГЕЙТ ЖИЗНЕННОГО ЦИКЛА АКТОРА (083 S3, срез 1, шаг 1).
//
// У sandbox-исполнителя созданный актор — сессия за границей изолята. Оба возможных промаха тихие:
// не освободить созданного — утечка сессии на каждый прогон, обнаруживаемая по исчерпанию ресурса
// через сотни прогонов; освободить несозданного — вызов на `undefined`, который у идемпотентного
// исполнителя пройдёт молча и оставит впечатление, что цикл отработал.
//
// Ни то, ни другое не роняет прогон и не видно в числах результата. Проверяется поэтому СЧЁТ
// вызовов, а не факт, и на КАЖДОМ пути завершения отдельно.

import { describe, expect, it } from 'vitest';
import { CONTRACT_VERSION } from '@trading/research-contracts/research';
import type { MarketDataRequirement } from '@trdlabs/sdk/research-contract';

import { admitActorMarketData, proveCandleVenue } from '../src/engine/actor/admission.js';
import type { ActorTapeCapabilities } from '../src/engine/actor/admission.js';
import { buildActorInit, withActorLifecycle } from '../src/engine/actor/run-symbol.js';
import type { EventDrivenSymbolInput } from '../src/engine/actor/run-symbol.js';
import type {
  ActorExecutionHandle,
  ActorLifecycleExecutor,
} from '../src/engine/actor/execution-handle.js';
import type { ResolvedStrategy } from '../src/engine/artifacts.js';

const MINUTE_US = 60_000_000;
const TAPE: ActorTapeCapabilities = {
  candleVenue: proveCandleVenue({ datasetRef: 'lifecycle-fixture-1m', candleVenue: 'bybit' }),
  symbol: 'BTCUSDT',
  barIntervalUs: MINUTE_US,
  barCount: 10,
};

const REQUIREMENT = {
  kind: 'candles',
  id: 'req-candles',
  instrument: { venue: 'bybit', symbol: 'BTCUSDT' },
  interval: MINUTE_US,
  lookback: 2,
  revisionPolicy: { mode: 'final_only' },
  priceType: 'trade',
} as unknown as MarketDataRequirement;

const STRATEGY = {
  manifest: {
    id: 'lifecycle-probe',
    version: '1.0.0',
    kind: 'strategy',
    contractVersion: CONTRACT_VERSION,
    lifecycle: 'event_driven',
    marketData: [REQUIREMENT],
  },
  module: {},
} as unknown as ResolvedStrategy;

/** Допуск настоящий, а не выдуманный: раннер обязан работать ровно с тем, что отдаёт допуск. */
function admittedInput(executor: ActorLifecycleExecutor): EventDrivenSymbolInput {
  const admission = admitActorMarketData(STRATEGY, TAPE);
  if (admission.refusal !== null) throw new Error(`фикстура не проходит допуск: ${admission.refusal.message}`);
  return {
    executor,
    source: { manifest: STRATEGY.manifest, module: STRATEGY.module },
    actorId: 'actor-btcusdt-0',
    symbol: 'BTCUSDT',
    seed: 42,
    params: {},
    admission,
  };
}

/** Счётчик вызовов исполнителя. `createActor` управляем: успех либо бросок. */
function recordingExecutor(opts: { createFails?: boolean } = {}) {
  const calls = { create: 0, dispose: 0, execute: 0 };
  const handle = { __actorExecutionHandle: 'ActorExecutionHandle' } as unknown as ActorExecutionHandle;
  const executor: ActorLifecycleExecutor = {
    createActor: async () => {
      calls.create += 1;
      if (opts.createFails === true) throw new Error('изолят не поднялся');
      return handle;
    },
    executeActorEvent: async () => {
      calls.execute += 1;
      return [];
    },
    disposeActor: async () => {
      calls.dispose += 1;
    },
  };
  return { calls, executor, handle };
}

describe('создание не удалось — освобождать нечего', () => {
  it('dispose НЕ вызывается ни разу', async () => {
    // Создание стоит СНАРУЖИ try намеренно: бросок проходит мимо finally по построению, а не
    // потому, что кто-то не забыл проверить `handle !== undefined`.
    const { calls, executor } = recordingExecutor({ createFails: true });
    await expect(withActorLifecycle(admittedInput(executor), async () => 'не должно исполниться')).rejects.toThrow(
      'изолят не поднялся',
    );
    expect(calls.create).toBe(1);
    expect(calls.dispose).toBe(0);
  });
});

describe('создание удалось — освобождение РОВНО ОДИН РАЗ на каждом пути', () => {
  it('успешное тело', async () => {
    const { calls, executor, handle } = recordingExecutor();
    const seen: unknown[] = [];
    const out = await withActorLifecycle(admittedInput(executor), async (h) => {
      seen.push(h);
      return 'готово';
    });
    expect(out).toBe('готово');
    // Телу отдаётся дескриптор ИСПОЛНИТЕЛЯ, а не что-то построенное раннером.
    expect(seen).toEqual([handle]);
    expect(calls.dispose).toBe(1);
  });

  it('тело бросило — исходная ошибка сохраняется, dispose всё равно один', async () => {
    const { calls, executor } = recordingExecutor();
    await expect(
      withActorLifecycle(admittedInput(executor), async () => {
        throw new Error('отказ внутри прогона');
      }),
    ).rejects.toThrow('отказ внутри прогона');
    expect(calls.dispose).toBe(1);
  });

  it('тело бросило ПОСЛЕ await — dispose один, ошибка та же', async () => {
    // Отдельный случай: до первого `await` тело исполняется синхронно внутри промиса, после —
    // возобновляется в другом тике. Путь освобождения при этом другой, и проверять его надо
    // отдельно, иначе гейт закрывает только половину случаев.
    const { calls, executor } = recordingExecutor();
    await expect(
      withActorLifecycle(admittedInput(executor), async () => {
        await Promise.resolve();
        throw new Error('отказ после await');
      }),
    ).rejects.toThrow('отказ после await');
    expect(calls.dispose).toBe(1);
  });

  it('ПРОВЕРКА ПРОВЕРКИ: два прогона дают два освобождения, а не одно на всех', async () => {
    // Без этого «ровно один» зеленело бы и у реализации, зовущей dispose один раз за процесс.
    const { calls, executor } = recordingExecutor();
    await withActorLifecycle(admittedInput(executor), async () => 'a');
    await withActorLifecycle(admittedInput(executor), async () => 'b');
    expect(calls.create).toBe(2);
    expect(calls.dispose).toBe(2);
  });
});

describe('ActorInit собирается из разрешённого входа', () => {
  it('несёт symbol, seed и ТОТ САМЫЙ экземпляр подписок допуска', async () => {
    const { executor } = recordingExecutor();
    const input = admittedInput(executor);
    const init = buildActorInit(input);
    expect(init.symbol).toBe('BTCUSDT');
    expect(init.seed).toBe(42);
    // Идентичность, а не равенство: пока мы внутри процесса хоста, проверенный состав и
    // объявленный актору состав обязаны быть одним объектом.
    expect(init.subscriptions).toBe(input.admission.subscriptions);
    expect(Object.isFrozen(init.subscriptions)).toBe(true);
  });

  it('budgets отсутствуют, когда их не задали — а не приезжают как undefined-ключ', () => {
    const { executor } = recordingExecutor();
    expect('budgets' in buildActorInit(admittedInput(executor))).toBe(false);
  });
});
