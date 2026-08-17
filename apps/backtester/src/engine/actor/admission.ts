// 083 S3 — допуск на actor-путь. Полностью FAIL-CLOSED в этом срезе.
//
// ДВЕ ОСИ, И ОНИ НЕ ОДНА (решение владельца, спека §3.6):
//   • СЕМАНТИКУ выбирает только `manifest.lifecycle`. `event_driven` — объявленная форма стратегии,
//     часть контракта с 017.3/017.4;
//   • `BACKTESTER_EVENT_DRIVEN_ENABLED` (default off) лишь РАЗРЕШАЕТ раскатку.
//
// Слить их в один флаг значило бы получить конфигурацию, при которой одна стратегия имеет разную
// семантику на разных хостах, причём невидимо: манифест не меняется.
//
// ГЛАВНОЕ ПРАВИЛО СРЕЗА: ни один набор условий НЕ проваливается в legacy. `event_driven`, который
// нельзя исполнить здесь, — это отказ, а не «выполним по-старому». Тихо исполнить его по
// single_position-пути значит подменить объявленную семантику молча: прогон завершится, числа
// получатся, и ничто не скажет, что исполнялось не то, что объявлено.

import { HOST_SOURCE_DESCRIPTOR, findDuplicateSubscriptionIds } from '@trdlabs/sdk/research-contract';
import type {
  ActorReadiness,
  ActorSubscriptionDescriptor,
  MarketDataRequirement,
} from '@trdlabs/sdk/research-contract';

import type { ResolvedStrategy } from '../artifacts.js';
import { supportsActorLifecycle, type ActorLifecycleExecutor } from './execution-handle.js';

/** Причина, по которой actor-путь не открыт. `null` — открыт. */
export interface ActorAdmissionRefusal {
  readonly code: 'unsupported_lifecycle';
  /**
   * Пустой JSON Pointer — НОРМАТИВНАЯ ссылка на запрос целиком (RFC 6901 §5, `@trdlabs/sdk@0.15.0`).
   *
   * Нарушающего узла здесь нет: запрос корректен, манифест безупречен, не совпадает окружение.
   * Указать `/moduleRef` значило бы обвинить валидный узел и отправить автора чинить то, что не
   * сломано.
   */
  readonly path: '';
  readonly message: string;
}

export interface ActorAdmissionInput {
  readonly strategy: ResolvedStrategy;
  /** `BACKTESTER_EVENT_DRIVEN_ENABLED`: разрешение раскатки, НЕ выбор семантики. */
  readonly eventDrivenEnabled: boolean;
  /** `BACKTESTER_BAR_BATCHING`: окно из k МЕТОК ВРЕМЕНИ одного символа. */
  readonly barBatching: boolean;
  /** `BACKTESTER_BAR_MAJOR_BATCH`: k СИМВОЛОВ одной метки, то есть k акторов. */
  readonly barMajorBatch: boolean;
}

/** Объявляет ли манифест event-driven форму. Единственный источник выбора семантики. */
export function isEventDriven(strategy: ResolvedStrategy): boolean {
  return (strategy.manifest as { lifecycle?: unknown }).lifecycle === 'event_driven';
}

const refuse = (message: string): ActorAdmissionRefusal => ({
  code: 'unsupported_lifecycle',
  path: '',
  message,
});

/** Ярлык стратегии для сообщений об отказе. */
const label = (strategy: ResolvedStrategy): string =>
  `${strategy.manifest.id}@${strategy.manifest.version}`;

/**
 * ЧИСТАЯ часть допуска: всё, для чего не нужен исполнитель.
 *
 * Вызывается ДО построения router'а — намеренно. Первая редакция строила router только затем, чтобы
 * спросить у него способность, и на пути отказа выходила из функции `return`ом, минуя
 * `finally { router.closeAll() }`. Созданный router оставался незакрытым: на trusted это безвредно,
 * на sandbox-роутере — оставленные сессии на каждый отклонённый прогон. Дефект внесён мной и найден
 * ревью владельца.
 *
 * Возвращает `null` для не-event-driven стратегий (их ведёт legacy-путь без изменений) и для
 * `event_driven`, прошедшего конфигурационные условия — тогда решение продолжается
 * `admitActorExecutor` уже ВНУТРИ try/finally.
 */
export function admitActorRun(input: ActorAdmissionInput): ActorAdmissionRefusal | null {
  if (!isEventDriven(input.strategy)) return null; // legacy single_position — не наша забота

  const id = label(input.strategy);

  if (!input.eventDrivenEnabled) {
    return refuse(
      `манифест ${id} объявляет lifecycle: 'event_driven', но BACKTESTER_EVENT_DRIVEN_ENABLED ` +
        'выключен. Legacy fallback НЕ применяется: исполнить event_driven по single_position-пути ' +
        'значит подменить объявленную семантику молча.',
    );
  }

  if (input.barBatching) {
    return refuse(
      `BACKTESTER_BAR_BATCHING несовместим с lifecycle: 'event_driven' (${id}). Окно из k баров — ` +
        'это k РАЗНЫХ business-моментов, и батч исполняет хук сразу для всех до последовательных ' +
        'эффектов: авторское состояние продвигается на k моментов вне гейта границы. Это обход ' +
        'семантики, а не транспортная оптимизация. Коалесценция законна только для событий ОДНОГО ' +
        'времени.',
    );
  }

  if (input.barMajorBatch) {
    return refuse(
      `BACKTESTER_BAR_MAJOR_BATCH пока несовместим с lifecycle: 'event_driven' (${id}). Он ` +
        'коалесцирует k СИМВОЛОВ одной метки времени, то есть k независимых акторов, а ActorHost ' +
        'имеет scope actor instance. Требуется отдельная multi-host композиция.',
    );
  }

  return null; // конфигурация допускает — дальше решает `admitActorExecutor`, уже под finally
}

/**
 * ЧАСТЬ ДОПУСКА, ТРЕБУЮЩАЯ ИСПОЛНИТЕЛЯ. Вызывается ВНУТРИ `try`, чтобы созданный router закрылся
 * `finally` при любом исходе.
 *
 * Порядок внутри сохранён: способность исполнителя конкретнее и исправимее, чем отсутствие
 * проекции, поэтому проверяется первой.
 */
export function admitActorExecutor(
  strategy: ResolvedStrategy,
  executor: Partial<ActorLifecycleExecutor>,
): ActorAdmissionRefusal | null {
  if (!isEventDriven(strategy)) return null;

  const id = label(strategy);

  if (!supportsActorLifecycle(executor)) {
    return refuse(
      `исполнитель, выбранный для ${id}, не умеет lifecycle актора (create → execute → dispose). ` +
        'Деградация в onBarClose НЕ применяется: это другая семантика.',
    );
  }

  // ── Отсутствие проекции — ПОСЛЕДНИЙ по конкретности и ПЕРВЫЙ по силе ────────
  //
  // Стоит выше проверки `marketData` НАМЕРЕННО, и порядок здесь не косметика.
  //
  // Контракт 017.4 требует от `event_driven` объявить хотя бы одно требование `marketData`
  // (`validate-module.ts`, код `missing_market_data_requirement`), а модульная валидация в
  // `runBacktest` идёт ДО этого допуска. Значит у КАЖДОГО манифеста, доехавшего сюда,
  // `marketData` непуст — и проверка ниже срабатывала бы всегда, а этот отказ не срабатывал бы
  // никогда. Оператор получал бы «объявлен marketData» и шёл править манифест, которого нечем
  // исполнить в принципе.
  //
  // Пока проекции ledger → артефакты нет, НИЧЕГО не исполняется, поэтому именно это и надо
  // сказать. Отказ снимается в одном месте — здесь, — когда проекция появится; тогда проверка
  // `marketData` ниже станет действующей.
  //
  // Почему не «успешный прогон с пустыми артефактами»: у отказа есть код, причина и адресат, у
  // пустого успеха нет ничего, а обнаружится он у того, кто сравнивает результаты двух lifecycle
  // и видит правдоподобные числа.
  // СТОЯЧИЙ ОТКАЗ СНЯТ ВМЕСТЕ С ПОДКЛЮЧЕНИЕМ ПУТИ. Прежние редакции отказывали здесь всегда: сперва
  // потому, что не было проекции, затем — потому, что не было продовой точки вызова. Оба условия
  // выполнены, и отказ, переживший свою причину, стал бы ложью, отправляющей оператора чинить
  // работающее.
  //
  // FAIL-CLOSED ЭТИМ НЕ ОСЛАБЛЕН, и это существенно. Дальше по пути стоит `admitActorMarketData`:
  // он требует ДОКАЗАННОГО происхождения свечей у датасета и точного candle-only поднабора, и
  // отвергает всё остальное до `createActor` и init. Ни один реальный датасет происхождения не
  // объявляет — значит поведение прода не изменилось ни на один прогон.
  //
  // Разница между «отказать здесь всегда» и «отказать там по проверке» — не стилистическая:
  // первое молчит о причине и не различает случаи, второе называет ровно тот параметр, который не
  // сошёлся, и снимается ровно тогда, когда он сойдётся.
  return null;
}

// ═══ ПОДДЕРЖИВАЕМЫЙ ПОДНАБОР MARKET DATA (срез 1: candle-only) ═══
//
// Поднабор задан ТОЧНО, а не «примерно свечи». Подписка — это обещание: актор, объявивший
// `open_interest` или ревизии, вправе на них рассчитывать, и хост, который их не доставляет, но
// прогон запускает, врёт молча. Числа при этом получаются правдоподобные.
//
// Отказ происходит ДО `createActor` и до init: актор, которому нечего доставлять, не должен быть
// создан вовсе — иначе отказ приезжает посреди прогона, когда закрывать уже есть что.

/** Точный поддерживаемый вид требования в этом срезе. */
const SUPPORTED_KIND = 'candles';

/**
 * Виды, у которых значение кросс-биржевое ПО ПОСТРОЕНИЮ — подтверждено кодом рекордера, а не
 * записью: `buildFinalizedSnapshot` гейтит их валидность СЧЁТОМ ИСТОЧНИКОВ (`oiSourceCount`,
 * `fundingSourceCount`, `takerSourceCount`), а ликвидации приходят списком срезов, типизированных
 * биржей, и складываются. Венью-специфична в каноне ТОЛЬКО свеча
 * (`docs/operations/evidence/2026-08-17-canonical-row-provenance-by-code.md` в control-center).
 *
 * Список закрыт НАЗЫВАНИЕМ венью-специфичного, а не перечислением агрегатов: новый вид с
 * собственным венью обязан объявить это явно, а не попасть под правило по умолчанию.
 */
const AGGREGATE_KINDS = ['open_interest', 'liquidations', 'taker_volume', 'funding'] as const;

function isAggregateKind(kind: string): kind is ActorAggregateKind {
  return (AGGREGATE_KINDS as readonly string[]).includes(kind);
}

/**
 * Единственный ценовой ряд свечей в контракте. Тип замыкает `priceType` на `'trade'`, но манифест
 * приезжает из JSON недоверенного модуля: типом это НЕ проверено ни разу. Сравнение ниже намеренно
 * идёт через `String(...)`, иначе TypeScript сузил бы обе стороны к литералу и выкинул проверку как
 * заведомо истинную — то есть гейта не осталось бы ровно там, где он единственный.
 */
const SUPPORTED_PRICE_TYPE = 'trade';

/**
 * Происхождение СВЕЧЕЙ — доказанное либо никакое. Union, а не строка: у «не доказано» поля `venue`
 * нет вовсе, поэтому недоказанное происхождение нельзя случайно сравнить с требованием и получить
 * совпадение.
 *
 * ИМЯ НАЗЫВАЕТ СВЕЧИ, А НЕ ЛЕНТУ, И ЭТО СУЩЕСТВЕННО. У смешанного датасета общего венью НЕ
 * СУЩЕСТВУЕТ: свечи venue-specific (их пишет один адаптер), а OI, funding и ликвидации агрегированы
 * по нескольким венью. Название `venue` обещало бы происхождение всей ленты — то есть больше, чем
 * доказывается, и ровно в том месте, где следующий вид данных будет молча накрыт чужим
 * доказательством.
 *
 * ПОЧЕМУ ВООБЩЕ ДОКАЗАТЕЛЬСТВО, А НЕ СТРОКА. Строка, которую кладёт вызывающий, доказывает лишь то,
 * что вызывающий её написал. Проверка «требование == объявление хоста» при этом выглядит работающей
 * и зеленеет, а данные за ней могут быть чьи угодно.
 */
export type ActorCandleVenue =
  | { readonly proven: true; readonly venue: string; readonly source: string }
  | {
      readonly proven: false;
      readonly venue?: undefined;
      readonly reason: string;
      /**
       * ПОЧЕМУ не доказано — различение машиночитаемое, а не только текстом.
       *
       * `undeclared` — «мы не знаем»: источник нигде не объявлен.
       * `heterogeneous` — «мы знаем, что источников было НЕСКОЛЬКО»: сутки собраны файлами,
       * назвавшими разные венью (передеплой между ними), и поминутного разбиения нет.
       *
       * Свести их в одну ветку «не доказано» значило бы потерять ДОКАЗАННЫЙ факт: второе — это
       * знание о данных, а не его отсутствие, и чинится оно иначе (пересборкой суток, а не
       * дозаписью метаданных).
       */
      readonly unknownBecause: 'undeclared' | 'heterogeneous';
      /**
       * Венью, ФАКТИЧЕСКИ давшие свечи этим суткам, — только при `heterogeneous` и только если
       * источник их назвал.
       *
       * Поле существует потому, что «источников было несколько, вот они» — это ЗНАНИЕ, а не его
       * отсутствие. Отказ без перечня заставил бы владельца датасета выяснять состав заново, хотя
       * состав уже установлен тем, кто отказ породил. Складывать такое знание в общий «неизвестно»
       * значит терять установленное ровно там, где оно нужно.
       */
      readonly venues?: readonly string[];
    };

/**
 * Единственный прувер происхождения свечей. Источник — метаданные датасета, версионированные ВМЕСТЕ
 * с данными: заявление, лежащее рядом с лентой, переживает её копирование, а боковая карта по имени
 * — нет (она молча начинает отвечать по старой мерке).
 *
 * ЧТО СЕЙЧАС ОТВЕЧАЕТ `proven: false` И ПОЧЕМУ ЭТО НЕ ЛЕНЬ. У реальных данных происхождение свечей
 * НЕ СУЩЕСТВУЕТ ни в одном доступном месте, и это свойство записи, а не пробел бэктестера:
 *
 *   • свечи пишет ОДИН адаптер биржи, выбранный на деплое рекордера переменной окружения
 *     `MARKET_SOURCE_EXCHANGE` (legacy-дефолт `bybit`, `platform/src/config/market_layer.ts`).
 *     В сам ряд этот выбор не попадает: `CanonicalRow` несёт `symbol`, OHLCV и флаги покрытия —
 *     и ни одного поля источника;
 *   • OI, funding и ликвидации, наоборот, АГРЕГИРОВАНЫ по нескольким венью (`oi_total_usd` —
 *     «Aggregated OI», `funding_rate` — «Aggregated funding»). Поэтому доказывать «венью датасета»
 *     нечего: у этих рядов его нет по построению, и вопрос осмыслен только про свечи;
 *   • `DatasetDescriptor` (и у бэктестера, и у mock-platform) поля происхождения не имеет, а
 *     `datasetRef` — свободная строка (`smoke-btc-1m`), в которой оно не закодировано.
 *
 * То есть рекордер знал венью свечей в момент записи и выбросил его. Пока канал не восстановлен,
 * ЛЮБАЯ реальная лента отвечает `proven: false`, и actor-путь на ней отказывает — это и есть
 * требуемое поведение, а не временная заглушка.
 */
export function proveCandleVenue(dataset: {
  readonly datasetRef: string;
  readonly candleVenue?: string;
  /**
   * Однородны ли сутки по источнику свечей. ВЫЧИСЛЯЕТСЯ покрытием из файлов дня, а не заявляется
   * писателем: рекордер сбрасывает много part-файлов за сутки, и передеплой между ними меняет
   * источник, о чём ни один отдельный файл не знает.
   *
   * Отсутствие поля означает «вопрос не задавался» и трактуется как отсутствие возражения —
   * иначе каждая существующая лента стала бы неоднородной от одного добавления параметра.
   */
  readonly candleVenueHomogeneous?: boolean;
  /** Венью, фактически давшие свечи суткам, если источник их перечислил. */
  readonly candleVenues?: readonly string[];
}): ActorCandleVenue {
  // НЕОДНОРОДНОСТЬ ПРОВЕРЯЕТСЯ ПЕРВОЙ и НЕ зависит от наличия имени. По согласованной форме при
  // неоднородности имя не пишется вовсе, но полагаться на дисциплину писателя тут нельзя: если имя
  // всё же приедет, оно будет именем ОДНОГО из источников и совпадёт с чьим-нибудь требованием —
  // то есть докажет происхождение, которого у части минут не было.
  if (dataset.candleVenueHomogeneous === false) {
    const listed = dataset.candleVenues ?? [];
    return {
      proven: false,
      unknownBecause: 'heterogeneous',
      // Перечень едет и в поле, и в текст: поле — потребителю, текст — человеку, который читает
      // отказ и должен понять, ЧТО пересобирать, не выясняя состав заново.
      ...(listed.length > 0 ? { venues: listed } : {}),
      reason:
        `датасет «${dataset.datasetRef}»: источник свечей внутри суток НЕОДНОРОДЕН` +
        (listed.length > 0 ? ` (${[...listed].sort().join(', ')})` : '') +
        ' — файлы дня назвали разные венью, а поминутного разбиения канон не несёт. Это знание о ' +
        'данных, а не его отсутствие: чинится пересборкой суток из однородного источника, а не ' +
        'дозаписью метаданных',
    };
  }
  // `trim`, а не сравнение с пустой строкой: `' '` и `'\t'` — такое же молчание, как отсутствие
  // поля, но выглядят как заполненное значение. Доказательством объявляется ЗНАЧЕНИЕ, а не факт,
  // что в ключе что-то лежит; иначе пробел прошёл бы гейт и дальше сравнивался бы с venue
  // требования, никогда не совпадая, — то есть отказ пришёл бы с неверной причиной.
  const declared = dataset.candleVenue?.trim();
  if (declared !== undefined && declared !== '') {
    return { proven: true, venue: declared, source: `dataset_metadata:${dataset.datasetRef}` };
  }
  return {
    proven: false,
    unknownBecause: 'undeclared',
    reason:
      `датасет «${dataset.datasetRef}» не объявляет происхождение свечей в своих метаданных. ` +
      'Восстановить его по данным нечем: свечи пишет один адаптер, выбранный переменной окружения ' +
      'рекордера и в строку не попадающий, а OI/funding/ликвидации агрегированы по нескольким венью',
  };
}

/** Что хост может доставить: параметры ленты, против которых сверяется подписка. */
export interface ActorTapeCapabilities {
  /**
   * Доказанное происхождение СВЕЧЕЙ. Названо по ряду, а не по датасету: у смешанного датасета
   * общего венью нет (см. `ActorCandleVenue`).
   */
  readonly candleVenue: ActorCandleVenue;
  readonly symbol: string;
  /** Интервал бара ленты в микросекундах. */
  readonly barIntervalUs: number;
  /** Сколько баров в ленте — верхняя граница `lookback`. */
  readonly barCount: number;
  /**
   * НЕСЁТ ЛИ лента этот вид вообще — по составу, а не по покрытию.
   *
   * Состояний ТРИ, и они не сводятся к двум. «Вид не несётся» — отказ: обещать нечем. «Несётся,
   * покрытие нулевое» — ДОПУСК: пустое наблюдение законно (у taker `{0,0}` при
   * `has_taker_flow: true` это наблюдение, а не отсутствие). «Несётся частично» — тоже допуск, а
   * разрывы автор видит по `ObservationStatus`.
   *
   * Слить первое со вторым значило бы либо отвергать законные пустые ленты, либо обещать вид,
   * которого нет, — и второе хуже: стратегия ждала бы событий, которые не придут никогда, а
   * прогон выглядел бы здоровым.
   *
   * Отсутствие функции — не «несёт всё»: вызывающий обязан её дать. Дефолт здесь был бы ровно тем
   * законным значением, что скрывает потерю.
   */
  readonly carries: (kind: ActorAggregateKind) => boolean;
}

/**
 * Одна РАЗРЕШЁННАЯ подписка: дескриптор плюс требование, которым она разрешена.
 *
 * Раннер обязан работать с этим, а не перечитывать манифест: манифест — сырьё, здесь же лежит уже
 * проверенное. Второе чтение того же поля в другом месте рано или поздно разойдётся с первым, и
 * разойдётся молча — «проверено» будет относиться к одному значению, «доставлено» к другому.
 */
export interface ActorSubscriptionBinding {
  /** Ровно то, что уедет в `ActorInit.subscriptions`. */
  readonly descriptor: ActorSubscriptionDescriptor;
  /** Нормализованный СНИМОК проверенного требования — не ссылка на объект манифеста. */
  readonly requirement: ActorRequirement;
  /** Проверенный `lookback` этого требования — в барах ленты. */
  readonly lookback: number;
}

/**
 * Нормализованное требование свечей — то, что допуск ПРОВЕРИЛ, в форме, которой пользуется хост.
 *
 * СНИМОК, А НЕ ССЫЛКА. Объект манифеста приезжает из недоверенного модуля и живёт своей жизнью:
 * оставить на него ссылку значит сделать результат допуска изменяемым ПОСЛЕ проверки — «проверено»
 * относилось бы к одному состоянию объекта, «доставлено» к другому, и никакой отметки об этом не
 * осталось бы. Поэтому поля скопированы, объект заморожен, и мутация исходника ничего здесь не
 * меняет (проба в наборе).
 *
 * НОРМАЛИЗАЦИЯ, а не копирование один-в-один: `instrument` разложен, бранд `DurationUs` сведён к
 * числу микросекунд, а `revisionPolicy` — к одному значению `'final_only'`. Отсутствие политики и
 * явный `final_only` допускаются оба и означают для хоста РОВНО одно; хранить различие, на которое
 * никто не смотрит, — значит рано или поздно на него посмотреть по-разному в двух местах.
 */
export interface ActorCandleRequirement {
  readonly id: string;
  readonly kind: 'candles';
  readonly venue: string;
  readonly symbol: string;
  readonly intervalUs: number;
  readonly lookback: number;
  readonly priceType: 'trade';
  readonly revisions: 'final_only';
}

/** Четыре вида, у которых значение КРОСС-БИРЖЕВОЕ по построению. */
export type ActorAggregateKind = 'open_interest' | 'liquidations' | 'taker_volume' | 'funding';

/**
 * Нормализованное требование агрегированного вида.
 *
 * ДВЕ ОСИ, А НЕ ОДНА, И ЭТО РЕШЕНИЕ КОНТРАКТА, НЕ ХОСТА. `instrument.venue` называет ИНСТРУМЕНТ
 * («BTCUSDT такой-то биржи» — то, чем рынок однозначно идентифицируется), а `scope` говорит, венью
 * ли ЛОКАЛЬНО само значение. Их легко спутать, и путаница стоила бы дорого в обе стороны: сверять
 * venue агрегата с доказанным происхождением свечей значило бы требовать от кросс-биржевой величины
 * того, чего у неё нет по построению, а не сверять вовсе — принять заявление, которого никто не
 * обслуживает.
 *
 * Поэтому здесь venue проверяется как ИДЕНТИЧНОСТЬ (тот ли это инструмент, по которому идёт
 * прогон), и отказ говорит об этом дословно, чтобы его не прочли как проверку происхождения.
 *
 * `scope: 'venue'` отвергается — по-источниковых значений архив не хранит и хранить не будет
 * (решение владельца 2026-08-06). Хост проверяет это САМ, а не полагается на валидатор SDK: гейт,
 * который держит кто-то другой, перестаёт держать ровно тогда, когда этого другого перестают
 * звать.
 */
export interface ActorAggregateRequirement {
  readonly id: string;
  readonly kind: ActorAggregateKind;
  /** Идентичность инструмента, НЕ происхождение значения. */
  readonly venue: string;
  readonly symbol: string;
  readonly intervalUs: number;
  readonly lookback: number;
  /** Единственная область, которую лента может обслужить. */
  readonly scope: 'aggregate';
  /** Только у `open_interest` и `taker_volume`; лента несёт исключительно USD. */
  readonly unit?: 'usd';
  /** Только у `funding`; `settlement` не резолвится — колонки в архиве нет. */
  readonly form?: 'rate';
  readonly revisions: 'final_only';
}

/** Проверенное требование любого допущенного вида. */
export type ActorRequirement = ActorCandleRequirement | ActorAggregateRequirement;

/** Допуск отказал: ничего пригодного к употреблению НЕ отдаётся — этого требует тип, а не дисциплина. */
export interface ActorMarketDataRefused {
  readonly refusal: ActorAdmissionRefusal;
  readonly bindings?: undefined;
  readonly tradingFromBarIndex?: undefined;
}

/** Допуск разрешил: полный разрешённый вход раннера. */
export interface ActorMarketDataAdmitted {
  readonly refusal: null;
  readonly bindings: readonly ActorSubscriptionBinding[];
  /**
   * ТОТ САМЫЙ массив, который уедет в `ActorInit.subscriptions` и в execution record — один
   * экземпляр, замороженный, с теми же объектами дескрипторов, что лежат в `bindings`.
   *
   * ПОЧЕМУ ЭКЗЕМПЛЯР, А НЕ ФУНКЦИЯ-ПРОЕКЦИЯ. Функция отдавала бы КАЖДОМУ вызывающему свой массив:
   * заморозка одного ничего не говорила бы про остальные, а `ActorInit` и запись прогона держали бы
   * разные объекты с одинаковым сейчас содержимым — то есть расхождение стало бы вопросом времени,
   * а не запрещённым состоянием. Заморожен и сам массив: `readonly` в типе не мешает `push`.
   *
   * ГРАНИЦА ЭТОЙ ГАРАНТИИ — ПРОЦЕСС ХОСТА. За сериализацией (sandbox/transport) идентичности
   * объектов не существует по построению: десериализация всегда порождает новые. Требовать её там
   * значило бы написать гейт, который не может пройти, — и он либо был бы отключён, либо доказывал
   * бы не то, что заявлено. За границей проверяется другое: каноническое содержимое, ПОРЯДОК и
   * неизменяемость восстановленного `ActorInit` в рантайме.
   */
  readonly subscriptions: readonly ActorSubscriptionDescriptor[];
  /**
   * Индекс первого ТОРГОВОГО бара — граница готовности (§3.3, требование 6).
   *
   * СЕМАНТИКА `lookback`, И ОНА НЕ «ПРОПУСТИТЬ»: бары `0 … lookback-1` актору ДОСТАВЛЯЮТСЯ, просто
   * при `readiness: 'warming_up'`, и команды `place` в этот период отклоняются. Не доставлять их
   * значило бы сделать первый торговый бар недетерминированным: его решение зависело бы от того,
   * сколько истории актор случайно успел увидеть.
   *
   * Порог — МАКСИМУМ по требованиям: `readiness` у актора одна на всех (`ActorContext.readiness`),
   * и актор готов лишь тогда, когда набрана история КАЖДОГО объявленного требования.
   *
   * Края: `lookback: 0` — торговля с первого же события; `lookback === barCount` — вся лента
   * доставлена, торговых баров ноль.
   */
  readonly tradingFromBarIndex: number;
}

/**
 * Результат допуска подписок. Union, а не запись с обнулёнными полями: на пути отказа полей
 * `bindings`/`tradingFromBarIndex` НЕ СУЩЕСТВУЕТ, и вызывающий, забывший проверить отказ, не
 * скомпилируется. Прежняя редакция отдавала на отказе пустой список и нулевой порог — то есть
 * молча разрешающие значения тому, кто не посмотрел.
 */
export type ActorMarketDataAdmission = ActorMarketDataRefused | ActorMarketDataAdmitted;

/** Идентификатор подписки выводится из требования — хост его не выбирает произвольно. */
export function subscriptionIdFor(requirementId: string): string {
  return `sub-${requirementId}`;
}

/**
 * Готовность на баре с индексом `barIndex`. Живёт рядом с тем, кто вычислил порог: сравнение,
 * оставленное раннеру, — это приглашение перепутать `<` и `<=` и сдвинуть торговлю на бар.
 */
export function readinessAtBar(barIndex: number, tradingFromBarIndex: number): ActorReadiness {
  return barIndex < tradingFromBarIndex ? 'warming_up' : 'ready';
}

/**
 * Допуск подписок: ровно candle-only, каждый параметр проверен.
 *
 * Возвращает и отказ, и дескрипторы: тот, кто проверил подписки, и обязан их назвать — иначе раннер
 * построил бы свой список, и «проверено» относилось бы к одному, а «доставлено» к другому.
 */
export function admitActorMarketData(
  strategy: ResolvedStrategy,
  tape: ActorTapeCapabilities,
): ActorMarketDataAdmission {
  const requirements = (strategy.manifest as { marketData?: readonly MarketDataRequirement[] })
    .marketData;
  const no = (message: string): ActorMarketDataRefused => ({ refusal: refuse(message) });

  // Происхождение свечей — свойство РЯДА, а не отдельного требования, поэтому проверяется один раз
  // и до их разбора: недоказанное происхождение не спасает совпадение строк ни в одном из них.
  if (!tape.candleVenue.proven) {
    return no(
      `${label(strategy)}: происхождение свечей не доказано, а требования называют венью. ` +
        `${tape.candleVenue.reason}. Сверять объявленное венью не с чем, а запустить прогон, сделав ` +
        'вид, что совпало, значит отдать стратегии данные неизвестного происхождения',
    );
  }

  if (requirements === undefined || requirements.length === 0) {
    // Контракт 017.4 требует непустой `marketData` у event-driven манифеста и отвергает такой
    // манифест раньше допуска. Ветка оставлена потому, что допуск обязан быть самостоятельным: он
    // не вправе полагаться на то, что кто-то раньше уже проверил.
    return no(`${label(strategy)} не объявляет marketData`);
  }

  const seen = new Set<string>();
  const bindings: ActorSubscriptionBinding[] = [];
  // ХОСТОВЫЙ ИСТОЧНИК ОБЪЯВЛЯЕТСЯ ПЕРВЫМ И НАРАВНЕ С РЫНОЧНЫМИ (ADR-0012).
  //
  // Половина каталога §3.5 — филл, четыре ордерных события, срабатывание таймера — рождается внутри
  // хоста и подписки не имеет. Пока его не было в списке, автор, сверяющий `subscriptionId` конверта
  // со списком источников, обязан был счесть собственный филл подложным. Дескриптор берётся
  // КАНОНИЧЕСКИЙ, из контракта: значение выбирает он, а не хост, иначе бэктестер, платформа и живая
  // торговля выберут три разных, и один код стратегии поведёт себя в трёх средах по-разному.
  const subscriptions: ActorSubscriptionDescriptor[] = [HOST_SOURCE_DESCRIPTOR];

  for (const req of requirements) {
    if (seen.has(req.id)) {
      return no(`${label(strategy)}: требование «${req.id}» объявлено дважды`);
    }
    seen.add(req.id);

    if (req.kind !== SUPPORTED_KIND && !isAggregateKind(req.kind)) {
      return no(
        `${label(strategy)} требует market data вида «${req.kind}»; поддержаны «${SUPPORTED_KIND}» и ` +
          `${AGGREGATE_KINDS.map((k) => `«${k}»`).join(', ')}. Запустить прогон, не доставляя ` +
          'объявленного, значит соврать молча',
      );
    }

    // ВЕНЬЮ ТРЕБОВАНИЯ — ИДЕНТИЧНОСТЬ ИНСТРУМЕНТА, и проверяется она для ВСЕХ видов, но означает
    // для них разное. У свечей это заявление о происхождении ЗНАЧЕНИЙ, и оно сверяется с
    // доказанным провенансом. У агрегатов значение кросс-биржевое по построению, и venue отвечает
    // только на вопрос «тот ли это инструмент»; сообщение отказа обязано это говорить, иначе его
    // прочтут как проверку происхождения и пойдут чинить не туда.
    if (req.instrument.venue !== tape.candleVenue.venue) {
      return no(
        req.kind === SUPPORTED_KIND
          ? `${label(strategy)}: требование «${req.id}» просит венью ${req.instrument.venue}, а свечи прогона ` +
            `с ${tape.candleVenue.venue} (${tape.candleVenue.source}). Подставить одно вместо другого ` +
            'нельзя: у разных венью различаются и цены, и комиссии, и funding'
          : `${label(strategy)}: требование «${req.id}» (${req.kind}) называет инструмент ` +
            `${req.instrument.venue}, а прогон идёт по ${tape.candleVenue.venue}. Это несовпадение ` +
            'ИНСТРУМЕНТА, а не происхождения: значение этого вида кросс-биржевое по построению, и ' +
            'венью у него нет вовсе — но спрашивать его надо про тот же рынок, по которому идёт прогон',
      );
    }
    if (req.instrument.symbol !== tape.symbol) {
      return no(
        `${label(strategy)}: требование «${req.id}» просит ${req.instrument.symbol}, а прогон идёт по ` +
          `${tape.symbol} — этой лентой его не обслужить`,
      );
    }
    if (Number(req.interval) !== tape.barIntervalUs) {
      return no(
        `${label(strategy)}: требование «${req.id}» просит интервал ${Number(req.interval)} мкс, а ` +
          `лента идёт с шагом ${tape.barIntervalUs} мкс. Агрегация интервалов в этом срезе не делается`,
      );
    }
    const revisionMode = req.revisionPolicy?.mode;
    if (revisionMode !== undefined && revisionMode !== 'final_only') {
      return no(
        `${label(strategy)}: требование «${req.id}» просит revisionPolicy «${revisionMode}»; лента ` +
          'ревизий не несёт, и обещать их нечем',
      );
    }
    // Граница ровно на `barCount`, и стороны от неё разные по смыслу, а не по строгости знака:
    // `lookback === barCount` — прогрев ВЫПОЛНИМ и выполнен, торговых баров после него просто не
    // осталось (допускаем); `lookback > barCount` — объявленная история недостижима в принципе,
    // готовность не наступит никогда. Второе — ошибка конфигурации, и прогон, который структурно
    // не может торговать, лучше назвать отказом, чем отдать как пустой успех.
    if (!Number.isInteger(req.lookback) || req.lookback < 0 || req.lookback > tape.barCount) {
      return no(
        `${label(strategy)}: требование «${req.id}» просит lookback ${req.lookback} при ${tape.barCount} ` +
          'барах в ленте — такой прогрев недостижим, готовность не наступит никогда',
      );
    }

    // ── ВИДОСПЕЦИФИЧНОЕ. Стоит ПОСЛЕ общего и ДО сборки: отказ здесь не должен оставлять за собой
    //    заведённый дескриптор, а общие причины обязаны называться раньше частных, иначе диагност
    //    получит частный диагноз на общей ошибке.
    let requirement: ActorRequirement;
    if (req.kind === SUPPORTED_KIND) {
      // `String(...)` — не украшение: без него TypeScript сузил бы обе стороны к `'trade'` и счёл
      // сравнение заведомо истинным. Значение приезжает из JSON и типом здесь не подтверждено ничем.
      if (String(req.priceType) !== SUPPORTED_PRICE_TYPE) {
        return no(
          `${label(strategy)}: требование «${req.id}» просит priceType «${String(req.priceType)}»; лента ` +
            `несёт только «${SUPPORTED_PRICE_TYPE}» (сделки), и другого ценового ряда у неё нет`,
        );
      }
      requirement = Object.freeze({
        id: req.id,
        kind: SUPPORTED_KIND,
        venue: req.instrument.venue,
        symbol: req.instrument.symbol,
        intervalUs: Number(req.interval),
        lookback: req.lookback,
        priceType: SUPPORTED_PRICE_TYPE,
        revisions: 'final_only',
      } satisfies ActorCandleRequirement);
    } else {
      // `scope: 'venue'` отвергается ХОСТОМ, а не только валидатором SDK. Гейт, который держит
      // кто-то другой, перестаёт держать ровно тогда, когда этого другого перестают звать, — а
      // допуск обязан быть самостоятельным.
      if (String(req.scope) !== 'aggregate') {
        return no(
          `${label(strategy)}: требование «${req.id}» (${req.kind}) просит scope «${String(req.scope)}»; ` +
            'по-источниковых значений архив не хранит и хранить не будет — это свойство записи, а не ' +
            'пробел реализации. Обслуживается только «aggregate»',
        );
      }
      // ТРЕТЬЕ СОСТОЯНИЕ. «Лента не несёт вид» — отказ; «несёт, но пусто» — допуск. Слить их
      // значило бы обещать автору события, которых не будет никогда, а прогон при этом выглядел бы
      // здоровым: стратегия просто не дождалась бы того, чего никто и не собирался слать.
      if (!tape.carries(req.kind)) {
        return no(
          `${label(strategy)}: требование «${req.id}» просит вид «${req.kind}», а лента прогона его не ` +
            'несёт вовсе. Пустое покрытие — законное состояние и отказом не является; отсутствие ' +
            'вида в составе ленты — другое дело: доставлять нечего, и обещать это нельзя',
        );
      }
      if ((req.kind === 'open_interest' || req.kind === 'taker_volume') && String(req.unit) !== 'usd') {
        return no(
          `${label(strategy)}: требование «${req.id}» просит unit «${String(req.unit)}»; лента несёт этот ` +
            'вид только в USD, а пересчёт в базовую валюту требует цены того же момента и вносил бы ' +
            'собственную ошибку в объявленное автором значение',
        );
      }
      if (req.kind === 'funding' && String(req.form) !== 'rate') {
        return no(
          `${label(strategy)}: требование «${req.id}» просит funding form «${String(req.form)}»; колонки ` +
            'settlement в архиве физически нет, и выдать её неоткуда',
        );
      }
      requirement = Object.freeze({
        id: req.id,
        kind: req.kind,
        venue: req.instrument.venue,
        symbol: req.instrument.symbol,
        intervalUs: Number(req.interval),
        lookback: req.lookback,
        scope: 'aggregate',
        ...(req.kind === 'open_interest' || req.kind === 'taker_volume' ? { unit: 'usd' as const } : {}),
        ...(req.kind === 'funding' ? { form: 'rate' as const } : {}),
        revisions: 'final_only',
      } satisfies ActorAggregateRequirement);
    }

    // Дескриптор создаётся ЗДЕСЬ ОДИН РАЗ и кладётся и в binding, и в `subscriptions` — один и тот
    // же объект в обоих местах, а не два одинаковых.
    const descriptor: ActorSubscriptionDescriptor = Object.freeze({
      subscriptionId: subscriptionIdFor(req.id),
      kind: req.kind,
      requirementId: req.id,
    });
    subscriptions.push(descriptor);

    // Заморозка ПОУРОВНЕВАЯ и явная: `Object.freeze` поверхностна, а `Object.isFrozen` истинен и для
    // поверхностно замороженного — то есть проверка на родителе ничего не говорит о детях.
    bindings.push(Object.freeze({ descriptor, requirement, lookback: req.lookback }));
  }

  // Контрактный гейт уникальности (`findDuplicateSubscriptionIds`, doc у `ActorSubscriptionDescriptor`):
  // резолвер ОБЯЗАН гарантировать её fail-closed при сборке `ActorInit`. То, что `subscriptionIdFor`
  // инъективен, а дубли `req.id` отвергнуты выше, — это рассуждение, а не проверка; рассуждение
  // переживёт правку идентификатора молча, а вызов — нет.
  const duplicates = findDuplicateSubscriptionIds(subscriptions);
  if (duplicates.length > 0) {
    return no(
      `${label(strategy)}: подписки получили неуникальные subscriptionId (${duplicates.join(', ')}) — ` +
        'порядок обработки событий стал бы невоспроизводимым',
    );
  }

  // Максимум, а не сумма и не первый: готовность у актора одна, и наступает она, когда набрана
  // история КАЖДОГО требования. Пустым `bindings` быть не может — пустой `marketData` отвергнут выше.
  const tradingFromBarIndex = Math.max(...bindings.map((b) => b.lookback));
  // Замораживаются САМИ массивы, а не только их элементы: `readonly` в типе — обещание компилятору,
  // и `push`/`splice` через любое приведение проходят мимо него беспрепятственно.
  return Object.freeze({
    refusal: null,
    bindings: Object.freeze(bindings),
    subscriptions: Object.freeze(subscriptions),
    tradingFromBarIndex,
  });
}
