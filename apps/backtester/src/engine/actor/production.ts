// 083 S3 — продовая точка вызова actor-пути: от датасета до `RunAccumulators`.
//
// ЧТО ЗДЕСЬ НЕ РЕШАЕТСЯ. Формат результата прогона принадлежит `assembleResult` — единственному
// владельцу `BacktestRunResult` и `RunEvidence`. Здесь собирается ровно `RunAccumulators`, то есть
// тот же вход, который ему подаёт legacy-путь. Собрать результат «по-своему» значило бы завести
// вторую форму evidence, которая совпадает с первой сегодня и разойдётся завтра.
//
// ОДНА СЕМАНТИКА НА ОБА ТРАНСПОРТА. direct и thread различаются ИСПОЛНИТЕЛЕМ (`router.forStrategy`),
// а не путём: обе ветки проходят через эту функцию и через `assembleResult`. Развилки «если thread,
// то иначе» здесь нет и быть не должно — она и есть тот способ, которым транспорты расходятся.

import type { RiskDecision } from '@trdlabs/engine';

import type { MarketTapeDataset } from '@trading/research-contracts/research';

import type { CandleDataset } from '../dataset.js';
import type { ResolvedStrategy } from '../artifacts.js';
import type { RunAccumulators } from '../runner.js';
import {
  admitActorMarketData,
  proveCandleVenue,
  type ActorAdmissionRefusal,
  type ActorTapeCapabilities,
} from './admission.js';
import { aggregateActorRuns, type AggregatedActorRun } from './aggregate.js';
import type { ActorBar, ActorExecutionCosts } from './frontier-runner.js';
import { runEventDrivenSymbol } from './run-symbol.js';
import type { ActorLifecycleExecutor } from './execution-handle.js';
import type { ActorExecutionRecord } from './execution-record.js';
import type { ActorRiskProfile } from './risk.js';

export interface ActorProductionInput {
  readonly strategy: ResolvedStrategy;
  readonly executor: ActorLifecycleExecutor;
  readonly dataset: CandleDataset;
  readonly symbols: readonly string[];
  readonly seed: number;
  readonly params: Readonly<Record<string, unknown>>;
  readonly costs: ActorExecutionCosts;
  /** Интервал бара ленты в микросекундах — из таймфрейма прогона, а не угадывается по данным. */
  readonly barIntervalUs: number;
  /** Риск-профиль прогона. Обязателен: без него нечем проверить, что лимиты кто-то соблюдает. */
  readonly riskProfile: RiskProfileShape;
}

/** Риск-профиль прогона в той форме, в какой его видит допуск: ключи важны все, включая чужие. */
export interface RiskProfileShape {
  readonly id: string;
  readonly version: string;
  readonly maxConcurrentPositions?: number;
  readonly exposureLimits?: object;
  readonly allowedSides?: readonly string[];
  readonly stopBounds?: unknown;
  readonly takeBounds?: unknown;
  readonly dcaLimits?: unknown;
  readonly scaleInLimits?: unknown;
}

/**
 * Правила профиля, ИСПОЛНИМЫЕ actor-путём. Whitelist, а не blacklist, и это принципиально.
 *
 * `DEFAULT_RISK` не навсегда единственный профиль: за ним придут пользовательские. Список
 * запрещённого пропустил бы каждое правило, которого мы сегодня не предвидели, — то есть ровно те,
 * что появятся позже. Список разрешённого отвергает незнакомое по построению.
 */
const ACTOR_ENFORCEABLE_RULES = new Set([
  'id',
  'version',
  'maxConcurrentPositions',
  'exposureLimits',
  'allowedSides',
]);

/**
 * Правила, у которых на actor-пути НЕТ ПРЕДМЕТА, — и потому их отсутствие не является ослаблением.
 *
 * `stopBounds`/`takeBounds` клампят защитные ХИНТЫ решения (`enter.stop`, `update_protection`).
 * У сырой заявки актора таких хинтов нет вовсе: `stop_market` несёт абсолютную цену и может быть
 * подан до входа, когда базовой цены не существует. Толковать его как protection значило бы
 * ВЫВЕСТИ защитную семантику из косвенных признаков — прямо запрещено решением владельца
 * 2026-08-14. Поэтому такие правила не блокируют прогон, но и поддержанными не объявляются:
 * применимость записана матрицей в дизайне, а не подразумевается.
 */
const ACTOR_INAPPLICABLE_RULES = new Set(['stopBounds', 'takeBounds']);

/**
 * Правила профиля, которые actor-путь НЕ УМЕЕТ исполнить.
 *
 * Критерий ровно один: **у правила есть предмет в actor-языке, а путь его не исполняет**. Такое
 * правило — тихое ослабление контроля, и прогон под ним отвергается до создания акторов.
 *
 * Не путать с правилом, у которого предмета нет вовсе (`stopBounds`/`takeBounds`): его отсутствие
 * ничего не ослабляет, потому что ослаблять нечего, и оно записано applicability matrix'ей.
 *
 * Незнакомый ключ отвергается ВСЕГДА. Профиль — не только `DEFAULT_RISK`; пользовательские правила
 * придут, и правило, о котором этот код никогда не слышал, обязано остановить прогон, а не
 * проехать молча под видом «наверное, неважное».
 */
export function unsupportedRiskRules(profile: RiskProfileShape): readonly string[] {
  const unsupported: string[] = [];

  const seen = profile as unknown as Readonly<Record<string, unknown>>;

  // ── Верхний уровень: имена ────────────────────────────────────────────────────
  for (const key of Object.keys(profile)) {
    if (ACTOR_ENFORCEABLE_RULES.has(key) || ACTOR_INAPPLICABLE_RULES.has(key)) continue;
    // Долив — предмет, у которого носитель ЕСТЬ (`orderIntentOf`), но исполнение отсутствует:
    // режим (`dca` против `scale_in`) командой не сообщается, и выводить его запрещено.
    unsupported.push(key);
  }

  // ── ЗНАЧЕНИЯ И ВЛОЖЕННЫЕ ИМЕНА ────────────────────────────────────────────────
  //
  // Whitelist по верхнеуровневым именам закрывает «пришло правило, которого мы не знаем». Он НЕ
  // закрывает «пришло знакомое правило с бессмысленным значением», а это тот же класс дефекта:
  // `maxPositionNotionalPct: NaN` проходит `typeof === 'number'`, и дальше КАЖДОЕ сравнение с ним
  // ложно — потолок молча выключен. Профиль при этом выглядит строгим, а прогон идёт без лимита.
  const exposure = seen.exposureLimits;
  if (exposure !== undefined) {
    if (typeof exposure !== 'object' || exposure === null) {
      unsupported.push('exposureLimits (не объект)');
    } else {
      // Вложенные ключи проверяются ТАК ЖЕ: `{ maxPositionNotionalPct: 1, maxLeverage: 10 }`
      // объявляет плечо, которого actor-путь не исполняет, и молчаливое согласие здесь ничем не
      // лучше молчаливого согласия наверху.
      for (const key of Object.keys(exposure)) {
        if (key !== 'maxPositionNotionalPct') unsupported.push(`exposureLimits.${key}`);
      }
      const pct = (exposure as { readonly maxPositionNotionalPct?: unknown }).maxPositionNotionalPct;
      if (typeof pct !== 'number' || !Number.isFinite(pct)) {
        unsupported.push(`exposureLimits.maxPositionNotionalPct=${String(pct)}`);
      } else if (pct <= 0) {
        // Ноль и отрицательное — не «строжайший лимит», а профиль, под которым нельзя открыть
        // ничего. Отвергать такой прогон надо на входе, а не отказом каждой заявке по отдельности.
        unsupported.push(`exposureLimits.maxPositionNotionalPct=${pct} (должен быть > 0)`);
      }
    }
  }

  const maxPositions = seen.maxConcurrentPositions;
  if (maxPositions !== undefined) {
    if (typeof maxPositions !== 'number' || !Number.isInteger(maxPositions) || maxPositions < 0) {
      unsupported.push(`maxConcurrentPositions=${String(maxPositions)}`);
    }
  }

  const sides = seen.allowedSides;
  if (sides !== undefined) {
    if (!Array.isArray(sides) || sides.length === 0) {
      unsupported.push(`allowedSides=${JSON.stringify(sides)}`);
    } else {
      // ENUM, а не произвольные строки. `allowedSides: ['both']` не совпало бы ни с одной
      // результирующей стороной и отвергало бы КАЖДОЕ открытие — поведение, неотличимое от
      // «профиль запрещает торговать», хотя автор профиля имел в виду обратное.
      for (const side of sides) {
        if (side !== 'long' && side !== 'short') unsupported.push(`allowedSides[]=${String(side)}`);
      }
    }
  }

  return unsupported;
}

/**
 * Профиль, ДОКАЗАННО исполнимый actor-путём.
 *
 * Возвращает тот же объект, суженный до формы, которую ядро команд умеет применять. Бросок здесь —
 * нарушение инварианта, а не пользовательский отказ: форму уже проверил `unsupportedRiskRules`, и
 * попасть сюда с неподходящим профилем можно только миновав гейт. Отдельная функция существует
 * ровно для того, чтобы «проверено» и «применено» относились к одному объекту: пересборка профиля
 * на входе в раннер позволила бы проверить одно, а исполнить другое.
 */
export function provenActorRiskProfile(profile: RiskProfileShape): ActorRiskProfile {
  const exposure = profile.exposureLimits as { readonly maxPositionNotionalPct: number } | undefined;
  if (exposure !== undefined && typeof exposure.maxPositionNotionalPct !== 'number') {
    throw new Error(
      `provenActorRiskProfile: профиль ${profile.id}@${profile.version} миновал гейт совместимости ` +
        'с непригодным exposureLimits — это нарушение инварианта допуска, а не отказ прогона',
    );
  }
  return {
    id: profile.id,
    version: profile.version,
    ...(profile.maxConcurrentPositions !== undefined
      ? { maxConcurrentPositions: profile.maxConcurrentPositions }
      : {}),
    ...(exposure !== undefined ? { exposureLimits: exposure } : {}),
    ...(profile.allowedSides !== undefined ? { allowedSides: profile.allowedSides } : {}),
  };
}

/**
 * Portfolio-wide лимит позиций против нескольких акторов.
 *
 * Профиль объявляет `maxConcurrentPositions` для ПОРТФЕЛЯ, а актор видит только свой символ:
 * соседний во время `validate` не существует, записи сводятся лишь после прогона. Per-actor
 * трактовка запрещена решением владельца — она тихо превратила бы «1 позиция на портфель» в «до N
 * позиций», и результат выглядел бы законным.
 *
 * Сегодня эту проверку опережает отказ многосимвольного прогона по `marketData[].instrument`, и
 * потому в проде она недостижима. Она стоит здесь не «на будущее», а потому что снятие того
 * блокера иначе тихо открыло бы этот: обе причины независимы, и закрывать их одной строкой нельзя.
 */
export function portfolioLimitUnsupported(
  profile: RiskProfileShape,
  actorCount: number,
): boolean {
  return (
    actorCount > 1 &&
    profile.maxConcurrentPositions !== undefined &&
    Number.isFinite(profile.maxConcurrentPositions)
  );
}

export interface ActorProductionOutcome {
  readonly refusal: ActorAdmissionRefusal | null;
  readonly accumulators?: RunAccumulators;
  readonly barsProcessed?: number;
  readonly aggregate?: AggregatedActorRun;
  readonly records?: readonly ActorExecutionRecord[];
}

/** Идентификатор инстанса: один актор на символ в этом срезе, и это видно из имени. */
export function actorIdFor(symbol: string): string {
  return `actor-${symbol.toLowerCase()}`;
}

/**
 * Исполнить actor-путь для всех символов прогона.
 *
 * Fail-closed целиком: отказ ЛЮБОГО символа отменяет прогон, а не исключает символ. Частичный
 * прогон вернул бы результат, посчитанный по подмножеству запрошенного, и ничем бы об этом не
 * сообщил — числа получились бы правдоподобные.
 */
export async function runActorProduction(
  input: ActorProductionInput,
): Promise<ActorProductionOutcome> {
  // РАЗВИЛКА, КОТОРУЮ НЕ ЗАКРЫВАЕТ СПЕКА, И ПОТОМУ ЗДЕСЬ ОТКАЗ, А НЕ ДОГАДКА.
  //
  // У event-driven манифеста `marketData[].instrument` называет КОНКРЕТНЫЙ инструмент. При прогоне
  // на нескольких символах на каждый поднимается свой актор — и непонятно, что означают требования
  // манифеста для КАЖДОГО из них:
  //
  //   • «применять только совпавшие по символу» — тогда требование на символ вне прогона исчезает
  //     молча, и актор объявил вход, которого не получил;
  //   • «подставлять символ актора вместо объявленного» — тогда `instrument` в манифесте перестаёт
  //     что-либо значить, и стратегия, написанная под BTC, молча исполнится на ETH.
  //
  // Оба чтения меняют смысл публичного поля контракта. Выбор за владельцем спеки; до него
  // многосимвольный event-driven прогон отвергается целиком.
  if (input.symbols.length > 1) {
    return {
      refusal: {
        code: 'unsupported_lifecycle',
        path: '',
        message:
          `${input.strategy.manifest.id}@${input.strategy.manifest.version}: прогон запрошен на ` +
          `${input.symbols.length} символах, а lifecycle: 'event_driven' поднимает по актору на символ. ` +
          'Что означают объявленные `marketData[].instrument` для каждого из акторов, контракт не ' +
          'фиксирует: и «применять только совпавшие», и «подставлять символ актора» меняют смысл ' +
          'поля. Пока правило не выбрано, многосимвольный actor-прогон отвергается — молча выбрать ' +
          'одно из чтений значило бы отдать стратегии не тот вход, который она объявила',
      },
    };
  }

  // СОВМЕСТИМОСТЬ ПРОФИЛЯ С ВОЗМОЖНОСТЯМИ АКТОРА — fail-closed, до создания акторов.
  //
  // Риск-контур у actor-пути ЕСТЬ (`risk.ts`), но он исполняет не всякое правило. Профиль,
  // объявляющий правило, которого путь не умеет, отвергается здесь — а не исполняется молча в
  // усечённом виде. Разница не в точности, а в предмете: прогон без объявленного лимита — это
  // другой прогон, и числа его выглядят как результат стратегии.
  const unsupported = unsupportedRiskRules(input.riskProfile);
  if (unsupported.length > 0) {
    return {
      refusal: {
        code: 'unsupported_lifecycle',
        path: '',
        message:
          `${input.strategy.manifest.id}@${input.strategy.manifest.version}: профиль риска ` +
          `${input.riskProfile.id}@${input.riskProfile.version} объявляет правила, которых actor-путь ` +
          `не исполняет (${unsupported.join(', ')}). Поддержаны: ` +
          `${[...ACTOR_ENFORCEABLE_RULES].join(', ')}; неприменимы за отсутствием предмета: ` +
          `${[...ACTOR_INAPPLICABLE_RULES].join(', ')}. Исполнить прогон молча значило бы посчитать ` +
          'его свободнее, чем разрешил профиль',
      },
    };
  }

  if (portfolioLimitUnsupported(input.riskProfile, input.symbols.length)) {
    return {
      refusal: {
        code: 'unsupported_lifecycle',
        path: '',
        message:
          `${input.strategy.manifest.id}@${input.strategy.manifest.version}: профиль риска ` +
          `${input.riskProfile.id}@${input.riskProfile.version} объявляет ` +
          `maxConcurrentPositions=${input.riskProfile.maxConcurrentPositions} для ПОРТФЕЛЯ, а прогон ` +
          `поднимает ${input.symbols.length} акторов, каждый из которых видит только свой символ. ` +
          'Применить лимит к каждому по отдельности значило бы разрешить до ' +
          `${input.symbols.length} одновременных позиций там, где профиль разрешает ` +
          `${input.riskProfile.maxConcurrentPositions} — и результат выглядел бы законным. ` +
          'Portfolio-wide гарантия требует координатора над акторами, которого в этом срезе нет',
      },
    };
  }

  const records: ActorExecutionRecord[] = [];
  let barsProcessed = 0;

  for (const symbol of input.symbols) {
    const candles = input.dataset.candles(symbol);
    const tape: ActorTapeCapabilities = {
      // Происхождение берётся у ДАТАСЕТА и доказывается прувером. Строка от вызывающего здесь
      // недопустима: она доказывала бы лишь то, что вызывающий её написал.
      candleVenue: proveCandleVenue({
        datasetRef: input.dataset.datasetRef,
        ...(input.dataset.candleVenue !== undefined ? { candleVenue: input.dataset.candleVenue } : {}),
      }),
      symbol,
      barIntervalUs: input.barIntervalUs,
      barCount: candles.length,
      // СОСТАВ ленты, а не покрытие. Мульти-source лента (`MarketTapeDataset`) отвечает `undefined`
      // на вид, которого не несёт ни одна её строка, и НЕПУСТОЙ колонкой на вид, который несётся
      // хотя бы где-то, — включая случай нулевого покрытия. Это ровно то различение, которое
      // допуску и нужно: «нечего доставлять» против «доставлять нечего в этой минуте».
      //
      // OHLCV-лента 018 (`CandleDataset`) агрегатов не несёт вовсе и методов для них не имеет,
      // поэтому отвечает `false` на все четыре — не дефолтом, а по факту отсутствия метода.
      carries: (kind) => {
        const src = input.dataset as Partial<MarketTapeDataset>;
        switch (kind) {
          case 'open_interest':
            return src.openInterest?.(symbol) !== undefined;
          case 'liquidations':
            return src.liquidations?.(symbol) !== undefined;
          case 'taker_volume':
            return src.taker?.(symbol) !== undefined;
          case 'funding':
            return src.funding?.(symbol) !== undefined;
        }
      },
    };

    const admission = admitActorMarketData(input.strategy, tape);
    if (admission.refusal !== null) return { refusal: admission.refusal };

    const bars: readonly ActorBar[] = candles.map((c) => ({
      tsUs: (c.ts * 1000) as ActorBar['tsUs'],
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));

    records.push(
      await runEventDrivenSymbol({
        executor: input.executor,
        source: { manifest: input.strategy.manifest, module: input.strategy.module },
        actorId: actorIdFor(symbol),
        symbol,
        seed: input.seed,
        params: input.params,
        admission,
        bars,
        costs: input.costs,
        // Профиль едет в ядро команд ТЕМ ЖЕ объектом, который прошёл гейт совместимости выше.
        // Пересобрать его здесь значило бы проверить одно, а исполнить другое.
        risk: { profile: provenActorRiskProfile(input.riskProfile), initialEquity: input.costs.initialEquity },
      }),
    );
    barsProcessed += candles.length;
  }

  const aggregate = aggregateActorRuns(records);

  // Сведение в тот же аккумулятор, который потребляет `assembleResult`. Порядок — по акторам, как
  // они предъявлены: перемешивать записи разных акторов по времени здесь нельзя, у них нет общей оси.
  const acc: RunAccumulators = {
    decisionRecords: [],
    orders: [],
    orderIndex: new Map(),
    fills: [],
    riskDecisions: [],
    trades: [],
    equityCurve: [],
    fundingLedger: [],
    validationIssues: [],
  };
  for (const actor of aggregate.perActor) {
    acc.decisionRecords.push(...actor.artifacts.decisionRecords);
    acc.orders.push(...actor.artifacts.orders);
    acc.fills.push(...actor.artifacts.fills);
    acc.riskDecisions.push(...(actor.artifacts.riskDecisions as RiskDecision[]));
    acc.trades.push(...actor.artifacts.trades);
    acc.equityCurve.push(...actor.artifacts.equityCurve);
    acc.fundingLedger.push(...actor.artifacts.fundingLedger);
    acc.validationIssues.push(...actor.artifacts.validationIssues);
    for (const order of actor.artifacts.orders) acc.orderIndex.set(order.id, order);
  }

  return { refusal: null, accumulators: acc, barsProcessed, aggregate, records };
}
