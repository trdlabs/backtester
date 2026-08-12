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

import type {
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
  // ТРЕБОВАНИЕ К СЛЕДУЮЩЕМУ СРЕЗУ, записанное здесь потому, что снимать отказ будут отсюда.
  // Вместе с проекцией обязана появиться проверка `manifest.marketData`: первая итерация подаёт
  // актору только свечное событие, и исполнить манифест с объявленными рыночными требованиями
  // значило бы отдать автору не тот вход, который он объявил, — получив правдоподобные числа. Кода
  // для неё здесь СЕЙЧАС нет намеренно: недостижимая ветка выглядит как работающая защита и
  // читается как уже принятое решение.
  return refuse(
    `lifecycle: 'event_driven' (${id}) совместим со всеми условиями хоста, но actor-путь пока не ` +
      'отдаёт результат: проекция ledger → артефакты не подключена. Успешный прогон с пустыми ' +
      'артефактами хуже отказа — у отказа есть причина и адресат.',
  );
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

/** Что хост может доставить: параметры ленты, против которых сверяется подписка. */
export interface ActorTapeCapabilities {
  readonly symbol: string;
  /** Интервал бара ленты в микросекундах. */
  readonly barIntervalUs: number;
  /** Сколько баров в ленте — верхняя граница `lookback`. */
  readonly barCount: number;
}

export interface ActorMarketDataAdmission {
  readonly refusal: ActorAdmissionRefusal | null;
  /**
   * ФАКТИЧЕСКИЕ дескрипторы подписок, которые уедут в `ActorInit.subscriptions`.
   *
   * Строятся здесь, а не в раннере: `subscriptionId` обязан быть канонической и стабильной ссылкой
   * на элемент этого же списка (контракт, doc у `ActorEnvelope`), и назначать его в двух местах
   * значило бы дать им разойтись.
   */
  readonly subscriptions: readonly ActorSubscriptionDescriptor[];
}

/** Идентификатор подписки выводится из требования — хост его не выбирает произвольно. */
export function subscriptionIdFor(requirementId: string): string {
  return `sub-${requirementId}`;
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
  const none: { readonly subscriptions: readonly ActorSubscriptionDescriptor[] } = { subscriptions: [] };

  if (requirements === undefined || requirements.length === 0) {
    // Контракт 017.4 требует непустой `marketData` у event-driven манифеста и отвергает такой
    // манифест раньше допуска. Ветка оставлена потому, что допуск обязан быть самостоятельным: он
    // не вправе полагаться на то, что кто-то раньше уже проверил.
    return { ...none, refusal: refuse(`${label(strategy)} не объявляет marketData`) };
  }

  const seen = new Set<string>();
  const subscriptions: ActorSubscriptionDescriptor[] = [];

  for (const req of requirements) {
    if (req.kind !== SUPPORTED_KIND) {
      return {
        ...none,
        refusal: refuse(
          `${label(strategy)} требует market data вида «${req.kind}»; в этом срезе поддержаны только ` +
            `«${SUPPORTED_KIND}». Запустить прогон, не доставляя объявленного, значит соврать молча`,
        ),
      };
    }
    if (seen.has(req.id)) {
      return { ...none, refusal: refuse(`${label(strategy)}: требование «${req.id}» объявлено дважды`) };
    }
    seen.add(req.id);

    if (req.instrument.symbol !== tape.symbol) {
      return {
        ...none,
        refusal: refuse(
          `${label(strategy)}: требование «${req.id}» просит ${req.instrument.symbol}, а прогон идёт по ` +
            `${tape.symbol} — этой лентой его не обслужить`,
        ),
      };
    }
    if (Number(req.interval) !== tape.barIntervalUs) {
      return {
        ...none,
        refusal: refuse(
          `${label(strategy)}: требование «${req.id}» просит интервал ${Number(req.interval)} мкс, а ` +
            `лента идёт с шагом ${tape.barIntervalUs} мкс. Агрегация интервалов в этом срезе не делается`,
        ),
      };
    }
    const revisionMode = req.revisionPolicy?.mode;
    if (revisionMode !== undefined && revisionMode !== 'final_only') {
      return {
        ...none,
        refusal: refuse(
          `${label(strategy)}: требование «${req.id}» просит revisionPolicy «${revisionMode}»; лента ` +
            'ревизий не несёт, и обещать их нечем',
        ),
      };
    }
    if (!Number.isInteger(req.lookback) || req.lookback < 0 || req.lookback > tape.barCount) {
      return {
        ...none,
        refusal: refuse(
          `${label(strategy)}: требование «${req.id}» просит lookback ${req.lookback} при ${tape.barCount} ` +
            'барах в ленте — столько истории до первого события не набрать',
        ),
      };
    }

    subscriptions.push({
      subscriptionId: subscriptionIdFor(req.id),
      kind: req.kind,
      requirementId: req.id,
    });
  }

  return { refusal: null, subscriptions };
}
