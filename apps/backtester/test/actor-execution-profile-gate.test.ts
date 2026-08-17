// 083 S3 — ГЕЙТ ПРОФИЛЯ ИСПОЛНЕНИЯ: whitelist по образцу риска (решение владельца 2026-08-17).
//
// ═══ ЧТО ЭТОТ ГЕЙТ ЗАКРЫВАЕТ ═══
//
// У РИСК-профиля whitelist стоял с самого начала: правило, которого actor-путь не исполняет,
// отвергает прогон, а не исполняется молча в усечённом виде. У профиля ИСПОЛНЕНИЯ такого гейта не
// было, и асимметрия стоила ровно того, чего гейт риска не допускает:
//
//   из профиля в actor-путь доезжают ТОЛЬКО `feeModel.bps` и `slippageModel.bps`;
//   `fillModel` не доезжает вовсе, и налив идёт по открытию СЛЕДУЮЩЕГО бара.
//
// Прогон, объявивший `same_bar_close`, считался по другой цене, чем заказано, — и числа при этом
// выглядели совершенно законными. Расхождение видел только тот, кто сравнил бы объявленное с
// исполненным, а сравнивать было нечем.
//
// ═══ ЧЕГО ГЕЙТ НЕ ДЕЛАЕТ ═══
//
// Он не меняет поведение дефолтного пути ни на бит: `DEFAULT_EXEC` объявляет `next_bar_open` —
// ровно то, что дорога и делает. Гейт закрывает РАСХОЖДЕНИЕ, а не наливку.

import { describe, expect, it } from 'vitest';

import { CONTRACT_VERSION } from '@trading/research-contracts/research';

import { runActorProduction, unsupportedExecutionRules } from '../src/engine/actor/production.js';
import type { ExecutionProfileShape } from '../src/engine/actor/production.js';
import type { ActorExecutionHandle, ActorLifecycleExecutor } from '../src/engine/actor/execution-handle.js';
import type { ResolvedStrategy } from '../src/engine/artifacts.js';
import type { CandleDataset } from '../src/engine/dataset.js';
import { InMemoryArtifactStore } from '../src/artifacts/store.js';
import { DEFAULT_EXEC, DEFAULT_RISK } from '../src/engine/profiles.js';

const base: ExecutionProfileShape = {
  id: 'probe_exec',
  version: '1.0.0',
  fillModel: { kind: 'next_bar_open' },
  feeModel: { kind: 'fixed_bps', bps: 10 },
  slippageModel: { kind: 'fixed_bps', bps: 5 },
};

describe('ГЕЙТ ДЕЙСТВУЕТ НА НАСТОЯЩЕЙ ДОРОГЕ, а не только существует', () => {
  // ЭТИ ДВЕ ПРОБЫ ЗАВЕДЕНЫ ПОТОМУ, ЧТО ГЕЙТ ОДНАЖДЫ БЫЛ МЁРТВОЙ ПРОВОДКОЙ.
  //
  // `unsupportedExecutionRules` была написана, задокументирована и покрыта всеми пробами ниже — и
  // не вызывалась НИОТКУДА. Пробы оставались зелёными, потому что зовут функцию НАПРЯМУЮ: они
  // проверяют реализацию правила, но ничего не говорят о том, включено ли оно. Ревью нашло это по
  // файлам ветки, а не по диффу.
  //
  // Разница между «правило написано» и «правило действует» видна только отсюда — с прогона,
  // который идёт продовым путём и обязан быть отвергнут.

  const MINUTE_US = 60_000_000;
  const T0 = 1_700_000_000_000;

  const datasetOf = (): CandleDataset =>
    ({
      datasetRef: 'exec-gate-probe-1m',
      timeframe: '1m',
      candleVenue: 'bybit',
      symbols: () => ['BTCUSDT'],
      candles: () =>
        Array.from({ length: 3 }, (_, i) => ({
          ts: T0 + i * 60_000,
          open: 100 + i,
          high: 101 + i,
          low: 99 + i,
          close: 100 + i,
          volume: 10,
        })),
    }) as unknown as CandleDataset;

  const strategy = {
    manifest: {
      id: 'exec-gate-probe',
      version: '1.0.0',
      kind: 'strategy',
      contractVersion: CONTRACT_VERSION,
      lifecycle: 'event_driven',
      marketData: [
        {
          kind: 'candles',
          id: 'r1',
          instrument: { venue: 'bybit', symbol: 'BTCUSDT' },
          interval: MINUTE_US,
          lookback: 0,
          revisionPolicy: { mode: 'final_only' },
          priceType: 'trade',
        },
      ],
    },
    module: {},
  } as unknown as ResolvedStrategy;

  const runWithExec = async (executionProfile: ExecutionProfileShape | undefined) =>
    runActorProduction({
      executor: {
        createActor: async () => ({ __h: 1 }) as unknown as ActorExecutionHandle,
        executeActorEvent: async () => [],
        disposeActor: async () => {},
      } satisfies ActorLifecycleExecutor,
      strategy,
      symbols: ['BTCUSDT'],
      dataset: datasetOf(),
      barIntervalUs: MINUTE_US,
      seed: 1,
      params: {},
      costs: { feeBps: 0, slippageBps: 0, initialEquity: 10_000 },
      riskProfile: DEFAULT_RISK,
      artifactStore: new InMemoryArtifactStore(),
      ...(executionProfile !== undefined ? { executionProfile } : {}),
    } as never);

  it('прогон с same_bar_close ОТВЕРГАЕТСЯ продовым путём', async () => {
    // Красная без подключения гейта — и именно этим отличается от всех проб ниже.
    const out = await runWithExec({ ...base, fillModel: { kind: 'same_bar_close' } });
    expect(out.refusal?.message).toMatch(/профиль исполнения/);
    expect(out.refusal?.message).toMatch(/fillModel\.kind=same_bar_close/);
    expect(out.refusal?.message).toMatch(/Чинит ОПЕРАТОР СТЕНДА/);
    expect(out.accumulators).toBeUndefined();
  });

  it('ПРОВЕРКА ПРОВЕРКИ: тот же прогон с исполнимым профилем ИДЁТ', async () => {
    // Иначе проба выше зеленела бы и у реализации, отвергающей любой прогон с профилем.
    const out = await runWithExec(base);
    expect(out.refusal).toBeNull();
  });

  it('профиль НЕ передан — «нечего проверять», а не «проверка пройдена»', async () => {
    // Вызывающие без профиля (пробы уровня раннера) не должны получать отказ на пустом месте.
    const out = await runWithExec(undefined);
    expect(out.refusal).toBeNull();
  });
});

describe('поставляемый профиль исполнения проходит', () => {
  it('DEFAULT_EXEC исполним actor-путём — дефолт не сдвинулся', () => {
    // Первая проба файла и самая важная: гейт, отвергающий дефолт, сломал бы каждый actor-прогон.
    expect(unsupportedExecutionRules(DEFAULT_EXEC as ExecutionProfileShape)).toEqual([]);
  });
});

describe('объявленное, но неисполняемое — ОТКАЗ, а не молчание', () => {
  it('same_bar_close отвергается: дорога наливает по следующему открытию', () => {
    // Тот самый случай. Прежде он проезжал молча и давал числа по ДРУГОЙ цене.
    expect(unsupportedExecutionRules({ ...base, fillModel: { kind: 'same_bar_close' } })).toEqual([
      'fillModel.kind=same_bar_close',
    ]);
  });

  it('fundingModel отвергается: начисления actor-путь не делает вовсе', () => {
    // Прогон под ним посчитался бы БЕЗ фандинга, и разница ушла бы прямо в pnl.
    const withFunding = { ...base, fundingModel: { kind: 'per_minute_prorate', intervalHours: 8 } };
    expect(unsupportedExecutionRules(withFunding)).toEqual(['fundingModel']);
  });

  it('незнакомое правило отвергается ВСЕГДА — whitelist, а не список запрещённого', () => {
    // Список запрещённого пропустил бы каждое правило, которого мы сегодня не предвидели, — то
    // есть ровно те, что появятся позже.
    const exotic = { ...base, borrowModel: { kind: 'flat' } } as unknown as ExecutionProfileShape;
    expect(unsupportedExecutionRules(exotic)).toEqual(['borrowModel']);
  });
});

describe('знакомое правило с непригодным ЗНАЧЕНИЕМ тоже отвергается', () => {
  it('чужая модель комиссии: у неё может не быть bps вовсе', () => {
    expect(
      unsupportedExecutionRules({ ...base, feeModel: { kind: 'maker_taker' } }),
    ).toEqual(['feeModel.kind=maker_taker']);
  });

  it('fixed_bps с NaN: каждое сравнение с ним ложно, и стоимость молча выключена', () => {
    // Тот же класс, что `maxPositionNotionalPct: NaN` у риска: `typeof === 'number'` проходит, а
    // арифметика даёт NaN во всём прогоне.
    expect(
      unsupportedExecutionRules({ ...base, slippageModel: { kind: 'fixed_bps', bps: Number.NaN } }),
    ).toEqual(['slippageModel.bps=NaN']);
  });

  it('ПРОВЕРКА ПРОВЕРКИ: годное значение не отвергается', () => {
    // Иначе пробы выше зеленели бы у реализации, отвергающей вообще всё.
    expect(unsupportedExecutionRules({ ...base, slippageModel: { kind: 'fixed_bps', bps: 0 } })).toEqual([]);
  });
});
