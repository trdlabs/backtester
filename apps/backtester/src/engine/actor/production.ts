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
  /**
   * Профиль ИСПОЛНЕНИЯ прогона — целиком, а не только вынутые из него bps.
   *
   * Нужен именно целиком: гейт совместимости обязан видеть и те правила, которые путь НЕ
   * применяет. Отдать сюда одни `costs` значило бы показать допуску ровно то подмножество,
   * которое уже исполнимо, и спрашивать его было бы не о чем.
   *
   * Необязателен ради вызывающих, у которых профиля нет (пробы уровня раннера): отсутствие
   * означает «нечего проверять», а не «проверка пройдена».
   */
  readonly executionProfile?: ExecutionProfileShape;
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

/** Профиль исполнения в той форме, в какой его видит допуск: ключи важны все, включая чужие. */
export interface ExecutionProfileShape {
  readonly id: string;
  readonly version: string;
  readonly fillModel?: { readonly kind?: unknown };
  // `bps` объявлен наравне с `kind`, потому что гейт читает ОБА: модель может назваться
  // `fixed_bps` и не нести числа, и это отдельный отказ, а не тот же самый.
  readonly feeModel?: { readonly kind?: unknown; readonly bps?: unknown };
  readonly slippageModel?: { readonly kind?: unknown; readonly bps?: unknown };
  readonly fundingModel?: unknown;
}

/**
 * Правила профиля ИСПОЛНЕНИЯ, которые actor-путь умеет применить. Whitelist — как у риска.
 *
 * ЗАЧЕМ ЭТО ЗАВЕДЕНО. У риск-профиля такой гейт стоял с самого начала и стоял затем, чтобы
 * объявленное, но неисполняемое правило не проехало молча. У профиля ИСПОЛНЕНИЯ его не было, и
 * асимметрия стоила ровно того, чего гейт риска не допускает: в actor-путь из профиля доезжают
 * только `feeModel.bps` и `slippageModel.bps`, а `fillModel` не доезжает вовсе — прогон,
 * объявивший `same_bar_close`, исполнялся по открытию СЛЕДУЮЩЕГО бара. Числа при этом выглядят
 * совершенно законными: расхождение видно только тому, кто сравнит объявленное с исполненным.
 *
 * Дефолтный путь не двигается: `DEFAULT_EXEC` объявляет `next_bar_open` — ровно то, что дорога и
 * делает. Гейт закрывает не поведение, а РАСХОЖДЕНИЕ между объявленным и исполняемым.
 */
const ACTOR_ENFORCEABLE_EXECUTION_RULES = new Set(['id', 'version', 'fillModel', 'feeModel', 'slippageModel']);

/** Единственная fill-модель, которую actor-путь ИСПОЛНЯЕТ, а не только принимает. */
const ACTOR_FILL_MODEL = 'next_bar_open';

export function unsupportedExecutionRules(profile: ExecutionProfileShape): readonly string[] {
  const unsupported: string[] = [];
  const seen = profile as unknown as Readonly<Record<string, unknown>>;

  for (const key of Object.keys(profile)) {
    // `fundingModel` попадает сюда именно так: он объявляет начисление, которого actor-путь не
    // делает (в `ActorExecutionCosts` его нет вовсе). Прогон под ним посчитался бы БЕЗ фандинга,
    // и разница ушла бы прямо в pnl.
    if (!ACTOR_ENFORCEABLE_EXECUTION_RULES.has(key)) unsupported.push(key);
  }

  const fill = seen.fillModel as { readonly kind?: unknown } | undefined;
  if (fill !== undefined && String(fill.kind) !== ACTOR_FILL_MODEL) {
    unsupported.push(`fillModel.kind=${String(fill.kind)}`);
  }
  // Комиссия и проскальзывание читаются как `.bps`, то есть модель обязана быть именно этой:
  // у другой формы поля `bps` может не быть вовсе, и вместо числа приехал бы `undefined`.
  for (const key of ['feeModel', 'slippageModel'] as const) {
    const model = seen[key] as { readonly kind?: unknown; readonly bps?: unknown } | undefined;
    if (model === undefined) continue;
    if (String(model.kind) !== 'fixed_bps') {
      unsupported.push(`${key}.kind=${String(model.kind)}`);
    } else if (typeof model.bps !== 'number' || !Number.isFinite(model.bps)) {
      unsupported.push(`${key}.bps=${String(model.bps)}`);
    }
  }

  return unsupported;
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
  // СТУПЕНЬ 1 MULTI-SYMBOL: N односимвольных акторов. Сплошной отказ снят решением владельца
  // 2026-08-14 («разделить смыслы» `instrument`), ратифицированным по плану cc#395 §5.
  //
  // Здесь исполнена ФИКСИРОВАННАЯ ветвь — та, что и есть сегодняшняя форма требования: требование
  // называет КОНКРЕТНЫЙ инструмент и обслуживает только его. Связанная ветвь («символ приносит
  // актор») требует новой формы в контракте и приедет своей релизной цепочкой; до неё поведение
  // односимвольного прогона не меняется ни на бит.
  //
  // Два отказа ниже стоят ЗДЕСЬ, а не в допуске отдельного актора, потому что оба про ПРОГОН
  // ЦЕЛИКОМ: допуск видит одну ленту и об остальных символах не знает, поэтому «требование на
  // символ вне прогона» он бы назвал «не тот символ», а «символ без требований» не заметил бы
  // вовсе — актор поднялся бы и не получил ничего.
  const requirements =
    (
      input.strategy.manifest as {
        marketData?: readonly { instrument: { symbol?: string }; symbolFrom?: unknown }[];
      }
    ).marketData ?? [];

  // СВЯЗАННАЯ ВЕТВЬ ОБСЛУЖИВАЕТ ЛЮБОЙ СИМВОЛ ПРОГОНА, и оба отказа ниже обязаны это знать.
  //
  // Считать её символом «объявленным» нельзя — у неё символа нет вовсе; считать её отсутствующей
  // тоже нельзя — тогда символ, покрытый ТОЛЬКО связанным требованием, был бы объявлен «без
  // требований» и прогон отвергся бы при полностью законном манифесте. Поэтому она не участвует в
  // множестве объявленных символов, но снимает второй отказ целиком.
  const hasBoundRequirement = requirements.some((r) => r.symbolFrom === 'actor');
  const declaredSymbols = new Set(
    requirements
      .filter((r) => r.symbolFrom !== 'actor')
      .map((r) => r.instrument.symbol)
      .filter((s): s is string => s !== undefined),
  );
  const runSymbols = new Set(input.symbols);

  const orphanRequirements = [...declaredSymbols].filter((s) => !runSymbols.has(s)).sort();
  if (orphanRequirements.length > 0) {
    return {
      refusal: {
        code: 'unsupported_lifecycle',
        path: '',
        message:
          `${input.strategy.manifest.id}@${input.strategy.manifest.version}: требования объявлены на ` +
          `символы вне прогона (${orphanRequirements.join(', ')}); прогон идёт по ` +
          `${[...runSymbols].sort().join(', ')}. Отбросить их молча значило бы запустить стратегию ` +
          'без входа, который она объявила, — а числа такого прогона выглядят как её результат. ' +
          'Чинит АВТОР манифеста: либо расширить прогон, либо убрать требование',
      },
    };
  }

  const symbolsWithoutRequirements = hasBoundRequirement
    ? []
    : [...runSymbols].filter((s) => !declaredSymbols.has(s)).sort();
  if (symbolsWithoutRequirements.length > 0) {
    return {
      refusal: {
        code: 'unsupported_lifecycle',
        path: '',
        message:
          `${input.strategy.manifest.id}@${input.strategy.manifest.version}: прогон запрошен по ` +
          `символам, для которых манифест не объявил ни одного требования ` +
          `(${symbolsWithoutRequirements.join(', ')}). Актор на такой символ поднялся бы и не получил ` +
          'ни одного рыночного события — это не пустой прогон, это прогон без входа. Чинит АВТОР ' +
          'запроса: либо сузить набор символов, либо объявить требования',
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

    // Колонки берутся ОДИН РАЗ на символ, а не на бар: `openInterest(symbol)` строит колонку
    // заново на каждый вызов, и вызов из цикла по барам превратил бы линейный проход в
    // квадратичный на ровном месте.
    const src = input.dataset as Partial<MarketTapeDataset>;
    const oiCol = src.openInterest?.(symbol);
    const liqCol = src.liquidations?.(symbol);
    const takerCol = src.taker?.(symbol);
    const fundCol = src.funding?.(symbol);

    const bars: readonly ActorBar[] = candles.map((c) => {
      // `at()` отвечает снимком либо `undefined` — ровно то различение, которое нужно: ключа нет
      // ⇔ наблюдения не было. Ни один вид не подменяется нулём: у всех четырёх ноль законен
      // (`{0,0}` у ликвидаций значит «бакет закрыт, каскадов не было»), и подстановка сделала бы
      // тишину канала неотличимой от тишины рынка.
      const oi = oiCol?.at(c.ts);
      const liq = liqCol?.at(c.ts);
      const taker = takerCol?.at(c.ts);
      const fund = fundCol?.at(c.ts);
      const aggregates = {
        ...(oi !== undefined ? { openInterest: { oiTotalUsd: oi.oiTotalUsd } } : {}),
        ...(liq !== undefined ? { liquidations: { longUsd: liq.longUsd, shortUsd: liq.shortUsd } } : {}),
        ...(taker !== undefined ? { takerVolume: { buyUsd: taker.buyUsd, sellUsd: taker.sellUsd } } : {}),
        ...(fund !== undefined ? { funding: { fundingRate: fund.fundingRate } } : {}),
      };
      return {
        tsUs: (c.ts * 1000) as ActorBar['tsUs'],
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        // Пустой объект НЕ кладётся: «лента агрегатов не несёт» и «несёт, но в этой минуте
        // наблюдений не было» — разные состояния, и первое обязано быть отсутствием поля.
        ...(Object.keys(aggregates).length > 0 ? { aggregates } : {}),
      };
    });

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
