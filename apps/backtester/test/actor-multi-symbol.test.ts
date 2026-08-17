// СТУПЕНЬ 1 MULTI-SYMBOL: N ОДНОСИМВОЛЬНЫХ акторов в одном прогоне.
//
// ═══ ЧТО ЗДЕСЬ ЗАКРЫТО, А ЧТО НЕТ ═══
//
// Исполнена ФИКСИРОВАННАЯ ветвь плана cc#395 §5 — та, что и есть сегодняшняя форма требования:
// требование называет КОНКРЕТНЫЙ инструмент и обслуживает только его. Связанная ветвь («символ
// приносит актор») требует новой формы в контракте и приедет своей релизной цепочкой.
//
// ═══ ПОЧЕМУ ЭТИ ОТКАЗЫ СТОЯТ НА УРОВНЕ ПРОГОНА ═══
//
// Допуск вызывается на КАЖДЫЙ символ и видит ровно одну ленту. Требование на символ ВНЕ прогона он
// назвал бы «не тот символ», а символ БЕЗ требований не заметил бы вовсе — актор поднялся бы и не
// получил ничего. Оба видны только там, где известны все символы сразу.
//
// ═══ ГЛАВНОЕ: ПРАВИЛО ПОРТФЕЛЯ СТАЛО ДОСТИЖИМЫМ ═══
//
// `portfolioLimitUnsupported` стоял до создания акторов и был НЕДОСТИЖИМ: сплошной отказ по
// multi-symbol возвращался раньше. Пробы ниже — первое место, где он реально срабатывает на
// продовом пути. Без них снятие сплошного отказа тихо превратило бы «1 позиция на портфель» в «до N».

import { describe, expect, it } from 'vitest';
import { CONTRACT_VERSION } from '@trading/research-contracts/research';
import type { MarketDataRequirement } from '@trdlabs/sdk/research-contract';

import { runActorProduction } from '../src/engine/actor/production.js';
import type { ActorExecutionHandle, ActorLifecycleExecutor } from '../src/engine/actor/execution-handle.js';
import type { ResolvedStrategy } from '../src/engine/artifacts.js';
import type { CandleDataset } from '../src/engine/dataset.js';
import { InMemoryArtifactStore } from '../src/artifacts/store.js';
import { riskBinding } from './helpers/actor-risk.js';

const MINUTE_US = 60_000_000;
const MINUTE_MS = 60_000;
const T0 = 1_700_000_000_000;

/**
 * Датасет собран ЗДЕСЬ, а не взят фикстурой, по двум причинам.
 *
 * Первая практическая: единственная фикстура с объявленным происхождением свечей лежит в формате
 * читалки (`rows`), а `loadCandleDataset` ждёт формат `symbols` — это разные формы, и одна другую
 * не заменяет.
 *
 * Вторая существенная: пробам нужен МНОГОСИМВОЛЬНЫЙ датасет, а фикстур с ним нет. Собранный тут
 * объект несёт ровно то, что читает продовый путь, — и происхождение свечей в том числе, иначе
 * прогон отвергался бы раньше по провенансу и пробы проверяли бы не то.
 */
const datasetOf = (symbols: readonly string[]): CandleDataset => {
  const bars = Array.from({ length: 3 }, (_, i) => ({
    ts: T0 + i * MINUTE_MS,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 10,
  }));
  return {
    datasetRef: 'multi-symbol-probe-1m',
    timeframe: '1m',
    candleVenue: 'bybit',
    symbols: () => symbols,
    candles: (symbol: string) => {
      if (!symbols.includes(symbol)) throw new Error(`нет символа ${symbol}`);
      return bars;
    },
  } as unknown as CandleDataset;
};

const requirement = (symbol: string, id: string): MarketDataRequirement =>
  ({
    kind: 'candles',
    id,
    instrument: { venue: 'bybit', symbol },
    interval: MINUTE_US,
    lookback: 0,
    revisionPolicy: { mode: 'final_only' },
    priceType: 'trade',
  }) as MarketDataRequirement;

const strategyFor = (reqs: readonly MarketDataRequirement[]): ResolvedStrategy =>
  ({
    manifest: {
      id: 'multi-symbol-probe',
      version: '1.0.0',
      kind: 'strategy',
      contractVersion: CONTRACT_VERSION,
      lifecycle: 'event_driven',
      marketData: reqs,
    },
    module: {},
  }) as unknown as ResolvedStrategy;

const executor: ActorLifecycleExecutor = {
  createActor: async () => ({ __h: 1 }) as unknown as ActorExecutionHandle,
  executeActorEvent: async () => [],
  disposeActor: async () => {},
};

/** Прогон продовым путём: та же функция, что зовёт раннер, а не её копия. */
async function run(
  symbols: readonly string[],
  reqs: readonly MarketDataRequirement[],
  risk = riskBinding(10_000),
) {
  return runActorProduction({
    executor,
    strategy: strategyFor(reqs),
    symbols,
    dataset: datasetOf(symbols),
    barIntervalUs: MINUTE_US,
    seed: 1,
    params: {},
    costs: { feeBps: 0, slippageBps: 0, initialEquity: 10_000 },
    riskProfile: risk.profile,
    artifactStore: new InMemoryArtifactStore(),
  } as never);
}

describe('требование на символ ВНЕ прогона — отказ, чинит автор манифеста', () => {
  it('лишнее требование не отбрасывается молча', async () => {
    // Отбросить его значило бы запустить стратегию без входа, который она объявила, — а числа
    // такого прогона выглядят как её результат.
    const out = await run(['BTCUSDT'], [requirement('BTCUSDT', 'r1'), requirement('ETHUSDT', 'r2')]);
    expect(out.refusal?.message).toMatch(/требования объявлены на символы вне прогона \(ETHUSDT\)/);
    expect(out.refusal?.message).toMatch(/Чинит АВТОР манифеста/);
  });
});

describe('символ БЕЗ требований — отказ, чинит автор запроса', () => {
  it('актор не поднимается на символ, которому нечего доставлять', async () => {
    const out = await run(['BTCUSDT', 'ETHUSDT'], [requirement('BTCUSDT', 'r1')]);
    expect(out.refusal?.message).toMatch(/не объявил ни одного требования \(ETHUSDT\)/);
    // Различение адресата — не украшение: у двух отказов выше чинящие РАЗНЫЕ, и общий текст
    // отправил бы одного из них не туда.
    expect(out.refusal?.message).toMatch(/Чинит АВТОР запроса/);
  });
});

describe('ПРАВИЛО ПОРТФЕЛЯ стало достижимым на продовом пути', () => {
  it('portfolio-wide maxConcurrentPositions отвергает multi-symbol ДО создания акторов', async () => {
    // ЭТО ПЕРВАЯ ПРОБА, КОТОРАЯ ВООБЩЕ ДОХОДИТ ДО ЭТОГО ПРАВИЛА. До снятия сплошного отказа оно
    // было недостижимо: multi-symbol отвергался раньше, и правило стояло веткой с недостижимым
    // условием. Применить лимит к каждому актору отдельно значило бы разрешить до N позиций там,
    // где профиль разрешает одну, — и результат выглядел бы законным.
    const out = await run(
      ['BTCUSDT', 'ETHUSDT'],
      [requirement('BTCUSDT', 'r1'), requirement('ETHUSDT', 'r2')],
    );
    expect(out.refusal?.message).toMatch(/для ПОРТФЕЛЯ/);
    expect(out.refusal?.message).toMatch(/координатора над акторами, которого в этом срезе нет/);
  });

  it('ПРОВЕРКА ПРОВЕРКИ: отказ наступает ДО создания акторов', async () => {
    // Иначе проба выше зеленела бы и в случае, когда акторы уже подняты, а лимит применён поздно —
    // то есть когда ресурс уже создан и его надо закрывать.
    let created = 0;
    const counting: ActorLifecycleExecutor = {
      createActor: async () => {
        created += 1;
        return { __h: 1 } as unknown as ActorExecutionHandle;
      },
      executeActorEvent: async () => [],
      disposeActor: async () => {},
    };
    const out = await runActorProduction({
      executor: counting,
      strategy: strategyFor([requirement('BTCUSDT', 'r1'), requirement('ETHUSDT', 'r2')]),
      symbols: ['BTCUSDT', 'ETHUSDT'],
      dataset: datasetOf(['BTCUSDT', 'ETHUSDT']),
      barIntervalUs: MINUTE_US,
      seed: 1,
      params: {},
      costs: { feeBps: 0, slippageBps: 0, initialEquity: 10_000 },
      riskProfile: riskBinding(10_000).profile,
      artifactStore: new InMemoryArtifactStore(),
    } as never);
    expect(out.refusal).toBeDefined();
    expect(created).toBe(0);
  });
});
