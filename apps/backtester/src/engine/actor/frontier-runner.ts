// 083 S3 — горячий цикл одного актора. Срез 1: внутренний раннер, без production-проводки.
//
// ЧТО ЗДЕСЬ КОМПОНУЕТСЯ И ЧТО ЗДЕСЬ НЕ РЕАЛИЗУЕТСЯ ЗАНОВО. Порядок событий (`orderFrontier`),
// нумерация (`nextSeq`), непрерывность (`assertContiguous`), политика отказа батча (`applyBatch`),
// заморозка eligible-набора таймеров (`openFrontierTimers`), матчинг против бара (`matchBar`) и
// бухгалтерия (`applyFill`) принадлежат `@trdlabs/engine`. Здесь нет ни одной их копии: вторая
// реализация того же правила разошлась бы с первой молча, а расхождение в этом слое выглядит как
// другое число в результате, а не как ошибка.
//
// ГРАНИЦА FRONTIER'А — `runFrontierAsync`, И ОНА ЖЕ ВЛАДЕЕТ ГЕЙТОМ. Весь business-момент, включая
// каскад, исполняется внутри одного вызова; пары «открыть/закрыть» у раннера нет, поэтому «забыл
// уведомить гейт» невыразимо. Бросок изнутри возвращает фазу на границу через `finally` движка.
//
// ДРЕНАЖ ДО ПУСТОТЫ. Следующий `U` не открывается, пока очередь текущего не опустела: события,
// порождённые командами, доставляются в ТОМ ЖЕ frontier каскадной фазой. Перенести их на следующий
// бар значило бы дать актору узнать об отказе собственной команды через минуту рыночного времени.

import {
  applyBatch,
  applyFill,
  createCheckpointableRng,
  rngStateFromSeed,
  type CheckpointableRng,
  executeFill,
  matchBar,
  nextSeq,
  openFrontierTimers,
  orderFrontier,
  assertContiguous,
  EMPTY_LEDGER,
  type CascadeBudget,
  type CascadeCounter,
  type Fill,
  type FrontierEvent,
  type Ledger,
  type RiskDecision,
  transition,
  type OrderEvent,
  type OrderState,
  type RestingOrder,
  type Side,
} from '@trdlabs/engine';
import { createActorHost } from '@trdlabs/engine';
import { HOST_SOURCE_DESCRIPTOR, HOST_SUBSCRIPTION_ID } from '@trdlabs/sdk/research-contract';
import type {
  ActorCommand,
  ActorInputEvent,
  ExecutionLedgerEntry,
  OpenOrderView,
  PositionView,
  TimestampUs,
  TradingState,
} from '@trdlabs/sdk/research-contract';
import { derivePositionView } from '@trdlabs/sdk/research-contract';

import { readinessAtBar, type ActorMarketDataAdmitted } from './admission.js';
import {
  actorRejectionEvent,
  createActorBatchCore,
  type ActorEngineState,
  type ActorOpenOrder,
  type ActorOutboxPayload,
  type ActorRiskBinding,
} from './engine-state.js';
import { exposureCeilingOf, orderIntentOf, parseRiskRefusal } from './risk.js';
import type {
  ActorCancelReason,
  ActorCloseAnnotation,
  ActorEquitySample,
  ActorExecutionRecord,
  ActorFrontierRecord,
  ActorJournalEntry,
  ActorOrderRecord,
} from './execution-record.js';
import type { ActorTimelineCommand, ActorTimelineEntry } from './timeline.js';
import type {
  ActorLifecycleExecutor,
  ActorExecutionHandle,
  HostActorContext,
} from './execution-handle.js';

/**
 * Наблюдения агрегированных видов НА ЭТОЙ минуте.
 *
 * ОТСУТСТВИЕ КЛЮЧА — ЭТО «НАБЛЮДЕНИЯ НЕ БЫЛО», и оно НЕ подменяется нулём. У всех четырёх видов
 * ноль — законное наблюдение: `{longUsd: 0, shortUsd: 0}` значит «бакет закрыт, каскадов не было»,
 * а `fundingRate: 0` — что ставка равна нулю. Подставь здесь ноль вместо отсутствия — и стратегия
 * не отличит тишину рынка от тишины канала.
 *
 * Контракт выражает отсутствие ЕДИНСТВЕННЫМ каналом — `market.subscription.status_changed` с
 * `gap`; само событие вида несёт только present-содержимое. Поэтому здесь нет ни `| null`, ни
 * трёхсостоянийного ридинга: есть ключ — было наблюдение, нет ключа — не было.
 */
export interface ActorBarAggregates {
  readonly openInterest?: { readonly oiTotalUsd: number };
  readonly liquidations?: { readonly longUsd: number; readonly shortUsd: number };
  readonly takerVolume?: { readonly buyUsd: number; readonly sellUsd: number };
  readonly funding?: { readonly fundingRate: number };
}

/**
 * Фаза business-момента, в которую подаётся рыночное событие вида (§3.8.1).
 *
 * ЭТО НЕ ОПТИМИЗАЦИЯ ПОРЯДКА, А НОРМАТИВНАЯ КОДИРОВКА. Спека нормирует распад слота «bar» на фазы
 * 3 (`market`) и 4 (`candle`) — решение 2026-08-06, и движок называет это дословно: «обе кодировки
 * дали бы сегодня один и тот же порядок, но фаза — это то, что нормировано, а совпадение
 * результата с альтернативной кодировкой случайно и не обязано пережить следующий вид данных».
 *
 * Отсюда и форма проверки. Пробой НА ПОРЯДОК эти две кодировки НЕ РАЗЛИЧИМЫ: и «агрегат в фазе
 * market», и «агрегат в фазе candle со старшим рангом» дают сегодня одну и ту же
 * последовательность. Различает только сама фаза, поэтому она вынесена сюда и пиннится
 * НАПРЯМУЮ — зелёная проба на порядок доказывает не то, что кажется.
 */
export function marketPhaseFor(kind: string): 'market' | 'candle' {
  return kind === 'candles' ? 'candle' : 'market';
}

/**
 * Событие агрегированного вида для этой минуты, либо `undefined` — наблюдения не было.
 *
 * Одна функция на все четыре вида, а не четыре ветки по месту вызова: форма `ObservedValue`
 * одинакова, и различие только в имени поля значения. Разложи это по месту — и `finality`/`revision`
 * пришлось бы писать четырежды, то есть четырежды иметь возможность написать по-разному.
 *
 * `finality: 'final'` и `revision: 0` — не заглушка: архив несёт ОДНУ строку на `(minute_ts, symbol)`,
 * второй записи с тем же ключом физически негде лежать, и `final_only` — единственная политика,
 * которую допуск принимает.
 */
function aggregateEventFor(
  kind: string,
  frontierUs: TimestampUs,
  aggregates: ActorBarAggregates | undefined,
): ActorInputEvent | undefined {
  const observed = <T>(value: T) => ({ effectiveTsUs: frontierUs, value, finality: 'final' as const, revision: 0 });
  switch (kind) {
    case 'open_interest':
      return aggregates?.openInterest === undefined
        ? undefined
        : { kind: 'market.open_interest.observed', oi: observed(aggregates.openInterest) };
    case 'liquidations':
      return aggregates?.liquidations === undefined
        ? undefined
        : { kind: 'market.liquidations.bucket_closed', liq: observed(aggregates.liquidations) };
    case 'taker_volume':
      return aggregates?.takerVolume === undefined
        ? undefined
        : { kind: 'market.taker_volume.bucket_closed', taker: observed(aggregates.takerVolume) };
    case 'funding':
      return aggregates?.funding === undefined
        ? undefined
        : { kind: 'market.funding.observed', funding: observed(aggregates.funding) };
    default:
      return undefined;
  }
}

/** Бар ленты в форме, которую матчит движок. */
export interface ActorBar {
  readonly tsUs: TimestampUs;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  /**
   * Объём закрытой свечи. Поле ОБЯЗАТЕЛЬНОЕ, потому что до него событие свечи уезжало автору с
   * `volume: 0` — константой, неотличимой от честного нулевого объёма. Дефолт здесь был бы ровно
   * тем законным значением, что скрывает потерю: автор, торгующий по объёму, получал бы «рынок
   * стоял» на каждом баре и не имел бы никакого способа это заметить.
   */
  readonly volume: number;
  /**
   * Наблюдения агрегированных видов этой минуты. Отсутствие поля целиком = лента агрегатов не
   * несёт (OHLCV-путь 018), и это отличается от «несёт, но в этой минуте наблюдения не было».
   */
  readonly aggregates?: ActorBarAggregates;
}

/**
 * Экономические параметры прогона. ОБЯЗАТЕЛЬНЫ и без дефолтов.
 *
 * Дефолт здесь был бы не удобством, а молчаливым экономическим допущением: прогон с забытой
 * комиссией показал бы прибыль, которой нет, и ничем бы себя не выдал. Значения приходят из
 * профиля исполнения прогона — раннер их не выбирает.
 */
export interface ActorExecutionCosts {
  readonly feeBps: number;
  readonly slippageBps: number;
  readonly initialEquity: number;
}

export interface FrontierRunInput {
  readonly executor: ActorLifecycleExecutor;
  readonly handle: ActorExecutionHandle;
  readonly actorId: string;
  readonly symbol: string;
  readonly seed: number;
  readonly admission: ActorMarketDataAdmitted;
  readonly bars: readonly ActorBar[];
  readonly costs: ActorExecutionCosts;
  readonly cascade: CascadeBudget;
  readonly tradingState?: TradingState;
  /**
   * Риск-профиль прогона, привязанный к ядру команд.
   *
   * Обязателен, без дефолта — по той же причине, что и `costs`: прогон с забытым риском отдал бы
   * числа, выглядящие как результат стратегии, хотя это результат стратегии БЕЗ лимитов. Разница
   * не в точности, а в предмете.
   */
  readonly risk: ActorRiskBinding;
}

/** Сторона позиции для `matchBar`: при flat берётся `buy` — «худшее» тогда не определено ничем. */
function positionSideOf(ledger: Ledger): Side {
  return ledger.qty < 0 ? 'sell' : 'buy';
}

function restingOf(orders: readonly ActorOpenOrder[]): readonly RestingOrder[] {
  return orders.map((o) => ({
    orderId: o.clientOrderId,
    kind: o.type === 'stop_market' ? 'stop' : o.type,
    side: o.side,
    ...(o.triggerPrice !== undefined ? { triggerPrice: o.triggerPrice } : {}),
    placedAtTsUs: o.placedAtTsUs,
  }));
}

/** Equity = стартовый капитал + реализованное + нереализованное по цене закрытия бара. */
function equityOf(ledger: Ledger, mark: number, initialEquity: number): number {
  const unrealized = ledger.qty === 0 ? 0 : (mark - ledger.avgPrice) * ledger.qty;
  return initialEquity + ledger.realizedPnl + unrealized;
}

// Намерение заявки (`open`/`add`/`close`) живёт в `risk.ts` — ОДНИМ определением на двоих. Прежде
// оно было объявлено здесь, а риск-контур завёл бы своё: разойдись эти копии — и риск отвергал бы
// как наращивание то, что запись прогона называет закрытием, причём обе стороны были бы «правы».

interface QueuedPayload extends ActorOutboxPayload {
  readonly causedBySeq?: number;
}

/**
 * Запись заявки вместе с её ЖИВЫМ состоянием автомата.
 *
 * Прежняя редакция заводила запись только в момент филла и ставила `terminalState: 'filled'`
 * присваиванием. Из-за этого заявка, отменённая или ни разу не исполнившаяся, исчезала из прогона
 * бесследно: артефакты показывали ровно те ордера, что сработали, и ни одного из тех, что автор
 * подал и снял. Автомат при этом не участвовал вовсе — то есть переход, которого в таблице нет,
 * прошёл бы наравне с законным.
 */
interface TrackedOrder {
  readonly record: ActorOrderRecord;
  readonly state: OrderState;
}

/**
 * Снять ждущую заявку решением РИСКА и записать причину В САМУ ЗАПИСЬ заявки.
 *
 * Причина пишется здесь, а не только в `riskDecisions`, потому что иначе ни одна запись не
 * содержит обоих фактов сразу: у ордера есть идентификатор без причины, у вердикта — причина без
 * идентификатора. Связать их можно было бы лишь сопоставлением двух списков по номеру frontier'а —
 * то есть догадкой, которая ломается на первом же frontier'е с двумя событиями.
 */
function cancelRestingByRisk(
  tracked: Map<string, TrackedOrder>,
  orderId: string,
  reason: ActorCancelReason,
): void {
  advanceOrder(tracked, orderId, { kind: 'cancel_request' });
  advanceOrder(tracked, orderId, { kind: 'cancel_complete' });
  const current = tracked.get(orderId);
  if (current !== undefined) {
    tracked.set(orderId, { ...current, record: { ...current.record, cancelReason: reason } });
  }
}

/** Событие отмены от ХОСТА — то же, что уезжает автору при снятии движком. */
function hostCancelEvent(clientOrderId: string, frontierUs: TimestampUs): FrontierEvent<QueuedPayload> {
  return {
    businessTsUs: frontierUs,
    phase: 'execution',
    stableSubscriptionId: HOST_SUBSCRIPTION_ID,
    sourceSequence: 0,
    payload: {
      subscriptionId: HOST_SUBSCRIPTION_ID,
      event: { kind: 'order.canceled', clientOrderId },
    },
  };
}

/** Двинуть автомат заявки движковым `transition` и обновить её терминальное состояние. */
function advanceOrder(
  tracked: Map<string, TrackedOrder>,
  orderId: string,
  event: OrderEvent,
  intent?: ActorOrderRecord['intent'],
): void {
  const current = tracked.get(orderId);
  if (current === undefined) return;
  const next = transition(current.state, event);
  // Недопустимый переход НЕ бросает и здесь: «отменяю уже исполненный» — штатная гонка, а не
  // поломка. Состояние остаётся прежним, и это видно в записи.
  tracked.set(orderId, {
    record: {
      ...current.record,
      terminalState: next.state,
      ...(intent !== undefined ? { intent } : {}),
    },
    state: next.state,
  });
}

/**
 * Исполнить все frontier'ы одного символа и собрать запись прогона.
 *
 * Вызывается ВНУТРИ `withActorLifecycle`: дескриптор уже получен, освобождение уже гарантировано.
 * Разделение намеренное — цикл не должен уметь создавать и освобождать актора, иначе правило
 * жизненного цикла существовало бы в двух местах.
 */
export async function runActorFrontiers(input: FrontierRunInput): Promise<ActorExecutionRecord> {
  const host = createActorHost();
  const core = createActorBatchCore(input.risk);
  // ГЕНЕРАТОР С ИЗВЛЕКАЕМЫМ СОСТОЯНИЕМ, а не закрытый в замыкании.
  //
  // Последовательность та же (тот же mulberry32 и тот же seed), но состояние теперь ЗНАЧЕНИЕ, а
  // значит его можно передать за границу изолята и принять обратно. Прежний `createSeededRng`
  // прячет положение генератора в замыкании: sandbox-исполнителю оставалось бы завести СВОЙ,
  // засеяв его тем же числом. Это работает ровно до первого расхождения в числе вызовов `next()`
  // и ломается молча — как другое решение стратегии, а не как ошибка.
  const rngSource: CheckpointableRng = createCheckpointableRng(rngStateFromSeed(input.seed));
  const bindings = input.admission.bindings;
  // Разделение по виду ОБЯЗАТЕЛЬНО, а не косметично: свечной цикл ниже шлёт
  // `market.candle.closed` на КАЖДЫЙ элемент, и агрегированная подписка получила бы свечу.
  // Вид берётся у ПРОВЕРЕННОГО требования, а не у дескриптора: у дескриптора в типе есть и
  // хостовый вариант, которого в биндингах не бывает, — сужать пришлось бы приведением, то есть
  // обещанием компилятору вместо проверки.
  const candleBindings = bindings.filter((b) => b.requirement.kind === 'candles');
  const aggregateBindings = bindings.filter((b) => b.requirement.kind !== 'candles');
  // Состояние наблюдаемости ПО ПОДПИСКЕ, живёт через все frontier'ы прогона. Контракт требует
  // ровно одного `status_changed` НА ПЕРЕХОДЕ observed → gap: повтор на каждом пустом frontier
  // превратил бы сигнал об изменении в шум на каждом тике.
  const inGap = new Set<string>();
  const lastObservedTsUs = new Map<string, TimestampUs>();
  const tradingFrom = input.admission.tradingFromBarIndex;

  let state: ActorEngineState = {
    frontierIndex: 0,
    frontierUs: (input.bars[0]?.tsUs ?? 0) as TimestampUs,
    readiness: readinessAtBar(0, tradingFrom),
    tradingState: input.tradingState ?? 'normal',
    ledger: EMPTY_LEDGER,
    openOrders: [],
    timers: [],
    notes: [],
    riskDecisions: [],
  };

  let seqCursor = 0;
  let lastCommittedSeq = -1;
  let fillCounter = 0;

  /**
   * Execution ledger В ФОРМЕ КОНТРАКТА — единственный вход `derivePositionView`.
   *
   * Держится рядом с движковым `Ledger`, а не вместо него: движковый несёт `realizedPnl` и служит
   * якорем сверки проекции, контрактный отвечает на вопрос автора «какая у меня позиция». Совпадение
   * двух свёрток одной и той же последовательности филлов проверяется гейтом, а не предполагается.
   */
  const execLedger: ExecutionLedgerEntry[] = [];
  let positionView: PositionView | undefined;

  const frontiers: ActorFrontierRecord[] = [];
  const timeline: ActorTimelineEntry[] = [];
  const journal: ActorJournalEntry[] = [];
  const closes: ActorCloseAnnotation[] = [];
  const equity: ActorEquitySample[] = [];
  const riskDecisions: RiskDecision[] = [];
  const orderRecords = new Map<string, TrackedOrder>();

  for (let index = 0; index < input.bars.length; index += 1) {
    const bar = input.bars[index]!;
    const frontierUs = bar.tsUs;

    // ВЕСЬ business-момент — внутри одного вызова. Каскад, таймеры, матчинг и запись включительно.
    await host.runFrontierAsync(frontierUs, async () => {
      state = {
        ...state,
        frontierIndex: index,
        frontierUs,
        // Готовность пересчитывается на КАЖДОМ frontier и берётся из допуска: одно значение отсюда
        // уедет и в контекст автора, и в `validate`.
        readiness: readinessAtBar(index, tradingFrom),
      };
      const counter: CascadeCounter = { depth: 0, events: 0 };
      const seed: FrontierEvent<QueuedPayload>[] = [];

      // ── Фаза 1: исполнение. Матчинг стоящих заявок против ЭТОГО бара ──────────
      let match = matchBar(restingOf(state.openOrders), bar, positionSideOf(state.ledger));

      // ── RE-ВАЛИДАЦИЯ РИСКА В МОМЕНТ ИСПОЛНЕНИЯ ──────────────────────────────
      //
      // Проверка на подаче закрывает ТОЛЬКО момент подачи. Заявка, законно принятая при flat,
      // стоит в книге и ждёт свою цену; пока она ждёт, позиция живёт своей жизнью — её может
      // открыть другая заявка. К моменту срабатывания та же самая заявка означает уже другое:
      //
      //   • смотрит В СТОРОНУ появившейся позиции ⇒ она её НАРАЩИВАЕТ, а профиль без add-лимитов
      //     наращивание запрещает;
      //   • смотрит ПРОТИВ позиции и не помечена reduceOnly ⇒ её нотионал может превысить позицию,
      //     пересечь ноль и открыть противоположную — мимо проверок открытия.
      //
      // В обоих случаях правило обходится ЧЕРЕЗ ВРЕМЯ: на подаче оно выполнялось, на исполнении уже
      // нет, а второй проверки не было. Поэтому она здесь, ДО `executeFill`: заявка снимается
      // целиком, филла нет, бухгалтерия не двигается.
      //
      // reduceOnly сюда не попадает НАМЕРЕННО: оба её состояния разбирает движок по знаковому
      // остатку (`reduce_only_flat` / `reduce_only_would_increase`), и вторая проверка того же
      // вопроса завела бы второго судью, который однажды ответит иначе.
      if (match !== null) {
        const resting = state.openOrders.find((o) => o.clientOrderId === match!.orderId)!;
        if (!resting.reduceOnly && state.ledger.qty !== 0) {
          const intent = orderIntentOf(state.ledger.qty, resting.side);
          const reason =
            intent === 'add' ? 'resting_add_not_permitted' : 'resting_opposite_requires_reduce_only';
          state = {
            ...state,
            openOrders: state.openOrders.filter((o) => o.clientOrderId !== resting.clientOrderId),
          };
          cancelRestingByRisk(orderRecords, resting.clientOrderId, reason);
          riskDecisions.push({ barIndex: index, decisionKind: 'resting', action: 'reject', reason });
          seed.push(hostCancelEvent(resting.clientOrderId, frontierUs));
          // Матч снят: исполнять больше нечего, и ни одна строка ниже не выполнится.
          match = null;
        } else if (!resting.reduceOnly) {
          // ── FLAT, НО EQUITY УЖЕ ДРУГАЯ ──────────────────────────────────────
          //
          // Позиции нет, значит ни наращивания, ни пересечения нуля быть не может — и на этом
          // соблазн остановиться велик. Но потолок экспозиции считается ОТ EQUITY, а equity между
          // подачей и срабатыванием меняется: убыточная сделка её уменьшает. Заявка, принятая при
          // equity E1, срабатывает при E2 < E1 со СТАРЫМ нотионалом — то есть открывает позицию
          // больше, чем профиль разрешает СЕЙЧАС.
          //
          // Проверка на подаче этого не ловит по той же причине, что и add/flip: она отвечала на
          // вопрос о другом моменте времени. Поэтому потолок пересчитывается здесь, и вердикт тот
          // же, что у подачи, — accept / clamp / reject.
          // Формула потолка — общая с подачей (`exposureCeilingOf`). Своя копия здесь разошлась бы
          // с той молча, и заявка проходила бы подачу по одному правилу, а исполнялась по другому.
          const ceiling = exposureCeilingOf(input.risk.profile, state, input.risk.initialEquity);
          if (ceiling !== null) {
            if (ceiling <= 0) {
              const reason = 'resting_exposure_ceiling_exhausted';
              state = {
                ...state,
                openOrders: state.openOrders.filter((o) => o.clientOrderId !== resting.clientOrderId),
              };
              cancelRestingByRisk(orderRecords, resting.clientOrderId, reason);
              riskDecisions.push({ barIndex: index, decisionKind: 'resting', action: 'reject', reason });
              seed.push(hostCancelEvent(resting.clientOrderId, frontierUs));
              match = null;
            } else if (resting.qtyUsd > ceiling) {
              // Заявка НЕ снимается: профиль разрешает открыть, но меньше. Клампится ровно так же,
              // как клампилась бы на подаче, — и в книге остаётся уже урезанный размер, потому что
              // исполняться будет он.
              state = {
                ...state,
                openOrders: state.openOrders.map((o) =>
                  o.clientOrderId === resting.clientOrderId ? { ...o, qtyUsd: ceiling } : o,
                ),
              };
              riskDecisions.push({
                barIndex: index,
                decisionKind: 'resting',
                action: 'clamp',
                reason: 'resting_notional_clamped',
                clamped: [{ field: 'qtyUsd', from: resting.qtyUsd, to: ceiling }],
              });
            }
          }
        }
      }

      if (match !== null) {
        const order = state.openOrders.find((o) => o.clientOrderId === match.orderId)!;
        const baseOpen = match.price;

        // ВТОРАЯ ФАЗА ИСПОЛНЕНИЯ — ЦЕЛИКОМ ДВИЖКОВАЯ. Хост НЕ считает здесь ни одной денежной
        // величины и не выбирает ни одной экономической ветки: размер, нотионал, комиссию, цену
        // после проскальзывания и сам факт клампа возвращает `executeFill`. Собственная арифметика
        // в этом месте расходилась бы с бухгалтерией движка в последних разрядах, а расхождение
        // здесь выглядит как движение рынка, а не как ошибка.
        //
        // ОСТАТОК ПОЗИЦИИ ПЕРЕДАЁТСЯ БУКВАЛЬНО И СО ЗНАКОМ. Прежняя редакция считала здесь сама:
        // сравнивала сторону заявки со стороной позиции и при несовпадении подставляла ноль. Тем
        // самым ДВА разных состояния — «позиции нет вовсе» и «позиция есть, но перевернулась и
        // стоит на стороне заявки» — схлопывались в один вход ещё до вызова, и движок отвечал на
        // оба одним словом, которое для второго случая неправда.
        //
        // Ни `Math.abs`, ни инверсии знака, ни вычисления факта сокращения здесь больше НЕТ: знак
        // остатка и есть тот факт, по которому движок сам различает flat, наращивание, полный филл
        // и кламп (0.17.0). Локальная нормализация вернула бы схлопывание под другим именем.
        const outcome = executeFill(
          order.qtyUsd,
          baseOpen,
          input.costs.slippageBps,
          // Сдвиг ПРОТИВ инициатора: покупка исполняется выше, продажа ниже. Проскальзывание,
          // играющее в пользу, — не издержка, а подарок.
          order.side === 'buy' ? 1 : -1,
          order.reduceOnly ? { signedPositionQty: state.ledger.qty } : null,
          input.costs.feeBps,
        );

        if (outcome.kind === 'canceled') {
          // reduce-only заявка не может быть исполнена: либо позиции уже нет, либо она успела
          // перевернуться и стоит на стороне заявки — исполнение НАРАСТИЛО бы её. Оба состояния
          // возникают между подачей заявки и её срабатыванием, и различает их движок, а не хост.
          // Заявка СНИМАЕТСЯ — ни филла, ни движения бухгалтерии. Причина записана словом движка.
          state = {
            ...state,
            openOrders: state.openOrders.filter((o) => o.clientOrderId !== order.clientOrderId),
          };
          advanceOrder(orderRecords, order.clientOrderId, { kind: 'cancel_request' });
          advanceOrder(orderRecords, order.clientOrderId, { kind: 'cancel_complete' });
          // Причина записывается СЛОВОМ ДВИЖКА. Без неё `canceled` в записи неотличимо от отмены
          // по команде автора, а это разные факты: одно — решение стратегии, другое — что рынок
          // ушёл из-под заявки.
          const tracked = orderRecords.get(order.clientOrderId);
          if (tracked !== undefined) {
            orderRecords.set(order.clientOrderId, {
              ...tracked,
              record: { ...tracked.record, cancelReason: outcome.reason },
            });
          }
          seed.push({
            businessTsUs: frontierUs,
            phase: 'execution',
            stableSubscriptionId: HOST_SUBSCRIPTION_ID,
            sourceSequence: 0,
            payload: {
              subscriptionId: HOST_SUBSCRIPTION_ID,
              event: { kind: 'order.canceled', clientOrderId: order.clientOrderId },
            },
          });
        } else {
        const price = outcome.executionPrice;
        const qty = outcome.filledSize;
        const fee = outcome.fee;
        const fillId = `${input.actorId}-fill-${fillCounter}`;
        fillCounter += 1;
        const fill: Fill = {
          fillId,
          tsUs: frontierUs,
          price,
          qty,
          side: order.side,
          fee,
          causedBy: order.clientOrderId,
        };
        const before = state.ledger;
        const intent = orderIntentOf(before.qty, order.side);
        state = {
          ...state,
          ledger: applyFill(before, fill),
          openOrders: state.openOrders.filter((o) => o.clientOrderId !== order.clientOrderId),
        };
        // ТОТ ЖЕ филл — во второй форме, которую требует контракт для `ctx.position()`. Обе записи
        // делаются В ОДНОМ месте из одного объекта: два независимых места записи разошлись бы
        // молча, и автор видел бы одну позицию, а бухгалтерия другую.
        execLedger.push({
          kind: 'fill',
          ts: frontierUs,
          clientOrderId: order.clientOrderId,
          side: order.side,
          price,
          qty,
          fee,
          // Частичных исполнений в этом симуляторе нет: исполненная заявка покидает книгу целиком.
          last: true,
        });
        positionView = derivePositionView(execLedger);
        // Эра закончилась — обе бухгалтерии согласны, что позиции нет. Сброс держит свёртку
        // ограниченной: `derivePositionView` сворачивает ВЕСЬ массив на каждом филле, и без этого
        // цена прогона росла бы квадратично по числу исполнений. Условие — РОВНЫЙ ноль у движка и
        // `undefined` у контракта одновременно: свернуть остаток эры с нуля можно только если этот
        // ноль точен, иначе пыль последнего разряда исчезла бы вместе с историей.
        if (positionView === undefined && state.ledger.qty === 0) execLedger.length = 0;
        journal.push({
          kind: 'fill',
          frontier: index,
          fillId,
          orderId: order.clientOrderId,
          tsUs: frontierUs,
          price,
          baseOpen,
          slippageBps: input.costs.slippageBps,
          qty,
          fee,
          side: order.side,
          fillKind: intent === 'add' ? 'add' : intent === 'close' ? 'close' : 'open',
        });
        // Автомат двигается движковым `transition`, а не присваиванием: состояние 'filled' в
        // обход таблицы прошло бы и из тех состояний, из которых перехода нет.
        advanceOrder(orderRecords, order.clientOrderId, { kind: 'fill', partial: false }, intent);
        if (intent === 'close') {
          // Аннотация нужна КАЖДОМУ сокращающему филлу, а не только обнуляющему позицию: движковая
          // деривация сделок требует причину у любого закрытия — частичного тоже, — потому что
          // причину знает только хост, и подставить её она не вправе.
          //
          // `closeFraction` здесь НЕ передаётся сознательно. Актор посылает НОТИОНАЛ, а не долю
          // позиции; исполненный размер получается из цены и с запрошенной долей побайтово не
          // совпадёт. Аннотация с долей, не равной `mul(размер эры, доля)`, — ровно та
          // противоречивая пара, которую движок отвергает с 0.10.0.
          closes.push({ exitFillId: fillId, closeReason: 'strategy_exit' });
        }
        seed.push({
          businessTsUs: frontierUs,
          phase: 'execution',
          stableSubscriptionId: HOST_SUBSCRIPTION_ID,
          sourceSequence: 0,
          payload: {
            subscriptionId: HOST_SUBSCRIPTION_ID,
            event: {
              kind: 'fill',
              clientOrderId: order.clientOrderId,
              // ЦЕНА ИСПОЛНЕНИЯ, а не цена матча. Прежняя редакция отдавала автору `match.price` —
              // до проскальзывания, — а в журнал и в бухгалтерию клала цену после него. Автор
              // считал свой средний вход по одной цене, хост по другой, и расхождение росло ровно
              // с издержками: чем дороже исполнение, тем оптимистичнее картина у автора.
              price,
              qty,
              fee,
              last: true,
            },
          },
        });
        }
      }

      // ── Фаза 2: таймеры. Набор ЗАМОРАЖИВАЕТСЯ движком ровно один раз на frontier ──
      const timers = openFrontierTimers(state.timers, frontierUs);
      state = { ...state, timers: timers.pending };
      timers.eligible.forEach((t, i) => {
        seed.push({
          businessTsUs: frontierUs,
          phase: 'timers',
          stableSubscriptionId: HOST_SUBSCRIPTION_ID,
          sourceSequence: i,
          payload: {
            subscriptionId: HOST_SUBSCRIPTION_ID,
            event: { kind: 'timer.fired', timerId: t.timerId, dueTsUs: t.dueTsUs },
          },
        });
      });

      // ── Фаза 3: агрегированные виды ───────────────────────────────────────────
      //
      // ПОРЯДОК ВНУТРИ FRONTIER'А ЗАДАЁТ ДВИЖОК, а не этот цикл: `marketKind` уезжает в
      // `orderFrontier`, и §3.8.2 (`MARKET_KIND_RANK` — open_interest первым, свеча последней)
      // применяется там. Своя сортировка здесь была бы второй реализацией нормативного порядка и
      // разошлась бы с движковой при первой же правке ранга — молча, потому что обе «работают».
      //
      // СОБЫТИЕ ВИДА НЕСЁТ ТОЛЬКО PRESENT-СОДЕРЖИМОЕ (контракт, §3.11.2). Отсутствие наблюдения
      // выражается ЕДИНСТВЕННЫМ каналом — `market.subscription.status_changed` с `gap`; событие
      // вида со значением «данных не было» было бы самопротиворечивым высказыванием.
      aggregateBindings.forEach((binding, i) => {
        const sid = binding.descriptor.subscriptionId;
        const event = aggregateEventFor(binding.requirement.kind, frontierUs, bar.aggregates);
        if (event !== undefined) {
          inGap.delete(sid);
          lastObservedTsUs.set(sid, frontierUs);
          seed.push({
            businessTsUs: frontierUs,
            phase: marketPhaseFor(binding.requirement.kind),
            marketKind: binding.requirement.kind,
            stableSubscriptionId: sid,
            sourceSequence: i,
            payload: { subscriptionId: sid, event },
          });
          return;
        }
        // Наблюдения не было. Событие статуса эмитится РОВНО ОДИН РАЗ на переходе: пока подписка
        // уже в разрыве, молчание и есть её состояние.
        if (inGap.has(sid)) return;
        inGap.add(sid);
        const last = lastObservedTsUs.get(sid);
        seed.push({
          businessTsUs: frontierUs,
          phase: marketPhaseFor(binding.requirement.kind),
          marketKind: binding.requirement.kind,
          stableSubscriptionId: sid,
          sourceSequence: i,
          payload: {
            subscriptionId: sid,
            event: {
              kind: 'market.subscription.status_changed',
              status: {
                state: 'gap',
                // Первая ОЖИДАЕМАЯ, но не пришедшая точка, а не момент детекции: у поля намеренно
                // одно прочтение (`expectedTsUs`, не `sinceUs`).
                expectedTsUs: frontierUs,
                // Самый первый разрыв в жизни подписки последнего наблюдения не несёт — и это не
                // «неизвестно», а «его не было». Ключ отсутствует, а не равен нулю.
                ...(last !== undefined ? { lastObservedTsUs: last } : {}),
              },
            },
          },
        });
      });

      // ── Фаза 4: свечи. По одному событию на КАЖДУЮ разрешённую подписку ───────
      candleBindings.forEach((binding, i) => {
        seed.push({
          businessTsUs: frontierUs,
          phase: marketPhaseFor('candles'),
          marketKind: 'candles',
          stableSubscriptionId: binding.descriptor.subscriptionId,
          sourceSequence: i,
          payload: {
            subscriptionId: binding.descriptor.subscriptionId,
            event: {
              kind: 'market.candle.closed',
              candle: {
                effectiveTsUs: frontierUs,
                value: { open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume },
                finality: 'final',
                revision: 0,
              },
            },
          },
        });
      });

      // ── Дренаж до пустоты ─────────────────────────────────────────────────────
      const deliveredSeqs: number[] = [];
      let queue = orderFrontier(seed, seqCursor);
      seqCursor = nextSeq(seqCursor, queue);

      while (queue.length > 0) {
        const cascade: FrontierEvent<QueuedPayload>[] = [];

        for (const scheduled of queue) {
          const envelope = {
            seq: scheduled.seq,
            eventTsUs: frontierUs,
            subscriptionId: scheduled.payload.subscriptionId,
            event: scheduled.payload.event,
          } as ActorTimelineEntry['envelope'];

          const ctx = buildContext(state, frontierUs, rngSource, positionView);
          const commands: readonly ActorCommand[] = await input.executor.executeActorEvent(
            input.handle,
            scheduled.payload.event,
            ctx,
          );

          const riskSeen = state.riskDecisions.length;
          const outcome = applyBatch(commands, state, core, input.cascade, counter, (c, i, reason) =>
            actorRejectionEvent(c, i, reason, frontierUs),
          );
          state = outcome.state;

          // ВЕРДИКТЫ РИСКА СОБИРАЮТСЯ ИЗ ДВУХ МЕСТ, И ЭТО ВЫНУЖДЕННО.
          //
          // `apply` записал в состояние то, что смог, — клампы. Отказы туда попасть не могли:
          // `validate` состояние не пишет по контракту `BatchCore`, а отклонённая команда до
          // `apply` не доходит вовсе. Поэтому отказ восстанавливается здесь, из того же
          // `outcome`, по которому строится timeline, — и ровно для тех причин, которые пометил
          // риск. Структурные отказы (прогрев, занятый номер, отрицательный размер) риску не
          // принадлежат и в его вердикты не попадают.
          riskDecisions.push(...state.riskDecisions.slice(riskSeen));
          if (outcome.rejectedIndex !== null && outcome.rejectedReason !== null) {
            const code = parseRiskRefusal(outcome.rejectedReason);
            if (code !== null) {
              riskDecisions.push({
                barIndex: index,
                decisionKind: 'place',
                action: 'reject',
                reason: code,
              });
            }
          }
          deliveredSeqs.push(scheduled.seq);
          lastCommittedSeq = scheduled.seq;

          timeline.push({
            envelope,
            frontier: index,
            commands: describeCommands(commands, outcome),
            ...(scheduled.payload.causedBySeq !== undefined
              ? { causedBySeq: scheduled.payload.causedBySeq }
              : {}),
          });

          outcome.outbox.forEach((event, i) => {
            const payload = event.payload as ActorOutboxPayload;
            // Заявка попадает в запись прогона в момент ПОДАЧИ, а не исполнения: снятая и
            // неисполнившаяся — такие же факты прогона, как сработавшая, и терять их нельзя.
            const ev = payload.event;
            if (ev.kind === 'order.accepted') {
              const placed = state.openOrders.find((o) => o.clientOrderId === ev.clientOrderId);
              if (placed !== undefined && !orderRecords.has(ev.clientOrderId)) {
                orderRecords.set(ev.clientOrderId, {
                  record: {
                    orderId: ev.clientOrderId,
                    placedAtFrontier: placed.placedAtFrontier,
                    side: placed.side === 'buy' ? 'long' : 'short',
                    intent: orderIntentOf(state.ledger.qty, placed.side),
                    terminalState: 'pending_new',
                  },
                  state: 'pending_new',
                });
                advanceOrder(orderRecords, ev.clientOrderId, { kind: 'accept' });
              }
            } else if (ev.kind === 'order.canceled') {
              advanceOrder(orderRecords, ev.clientOrderId, { kind: 'cancel_request' });
              advanceOrder(orderRecords, ev.clientOrderId, { kind: 'cancel_complete' });
            } else if (ev.kind === 'order.denied') {
              advanceOrder(orderRecords, ev.clientOrderId, { kind: 'reject', reason: 'denied' });
            }
            cascade.push({
              businessTsUs: frontierUs,
              phase: 'cascade',
              stableSubscriptionId: payload.subscriptionId,
              sourceSequence: i,
              payload: { ...payload, causedBySeq: scheduled.seq },
            });
          });

          if (outcome.halt !== null) {
            throw new Error(
              `актор ${input.actorId} остановлен на frontier ${index}: ${outcome.halt.reason}`,
            );
          }
        }

        queue = cascade.length > 0 ? orderFrontier(cascade, seqCursor) : [];
        seqCursor = nextSeq(seqCursor, queue);
      }

      // Непрерывность внутри frontier'а — движковым гардом, а не своей проверкой.
      if (deliveredSeqs.length > 0) assertContiguous(deliveredSeqs, deliveredSeqs[0]!);

      frontiers.push({ index, tsUs: frontierUs, lastCommittedSeq });
      equity.push({ frontier: index, equity: equityOf(state.ledger, bar.close, input.costs.initialEquity) });

    });
  }

  return {
    actorId: input.actorId,
    symbol: input.symbol,
    subscriptions: input.admission.subscriptions,
    frontiers,
    orders: [...orderRecords.values()].map((t) => t.record),
    journal,
    closes,
    equity,
    riskDecisions,
    finalLedger: state.ledger,
    timeline,
  };
}

/**
 * Одна открытая заявка В ФОРМЕ КОНТРАКТА (`OpenOrderView`), разложенная по виду.
 *
 * Вид несёт свою цену: `limit` — `price`, `stop_market` — `stopPrice`, `market` — никакую.
 *
 * ЕДИНИЦА ЗАЯВКИ — НОТИОНАЛ (ADR-0013). `filledQtyUsd: 0` — факт, а не заглушка: частичных
 * исполнений в этом симуляторе нет, заявка либо стоит целиком, либо покидает книгу. Остаток
 * вычисляется как `qtyUsd − filledQtyUsd`, и никакой цены для этого не требуется.
 *
 * `estimatedQty` НЕ ЗАПОЛНЯЕТСЯ намеренно. Оценка базового размера потребовала бы цены пересчёта,
 * а у стоящей заявки такой цены нет: она появится только в момент исполнения. Поле объявлено
 * необязательным ровно для этого случая, и честный ответ здесь — не давать числа вовсе. Прежняя
 * редакция фиксировала размер при подаче по последней увиденной цене — это и была та временная
 * конверсия, которую срез снимает.
 */
function openOrderViewOf(o: ActorOpenOrder): OpenOrderView {
  const base = {
    clientOrderId: o.clientOrderId,
    side: o.side,
    status: 'accepted' as const,
    qtyUsd: o.qtyUsd,
    filledQtyUsd: 0,
    ...(o.reduceOnly ? { reduceOnly: true as const } : {}),
    createdTs: o.placedAtTsUs,
  };
  if (o.type === 'market') return { ...base, type: 'market' };
  if (o.triggerPrice === undefined) {
    // Инвариант хоста: `validate` не пропускает `limit`/`stop_market` без своей цены. Молчаливое
    // `undefined` в обязательном поле контракта уехало бы автору как отсутствующая цена заявки.
    throw new Error(`actor orders.open: заявка '${o.clientOrderId}' вида ${o.type} без цены`);
  }
  return o.type === 'limit'
    ? { ...base, type: 'limit', price: o.triggerPrice }
    : { ...base, type: 'stop_market', stopPrice: o.triggerPrice };
}

/**
 * Контекст автора. `readiness` берётся ИЗ ТОГО ЖЕ состояния, что видит `BatchCore.validate`.
 *
 * КАСТА `as unknown as ActorContext` ЗДЕСЬ БОЛЬШЕ НЕТ, и это главное. Он не «успокаивал компилятор»
 * — он прятал то, что ни одно поле собранной вручную позиции не совпадало с контрактом: `qty` со
 * знаком вместо всегда положительного, `avgPrice` вместо `avgEntryPrice`, `openedAtUs` вместо
 * `openedAt`, лишний `realizedPnl` (которого в `PositionView` нет намеренно) — и ни одного `side`.
 * Автор, читающий документированные поля, получал `undefined` во всех.
 *
 * Позиция приходит из `derivePositionView` — ЕДИНСТВЕННОГО санкционированного источника
 * `PositionView` (бранд `POSITION_VIEW_BRAND` неподделываем снаружи пакета). Свёртка сделана
 * заранее, на филле: контекст строится на каждое событие, а филлов внутри frontier'а не бывает.
 */
function buildContext(
  state: ActorEngineState,
  frontierUs: TimestampUs,
  rng: CheckpointableRng,
  position: PositionView | undefined,
): HostActorContext {
  return {
    clock: { nowUs: () => frontierUs },
    rng,
    readiness: state.readiness,
    tradingState: state.tradingState,
    orders: { open: () => state.openOrders.map(openOrderViewOf) },
    position: () => position,
  };
}

/**
 * Исход КАЖДОЙ команды батча — включая те, что не оставили материального следа.
 *
 * `applyBatch` возвращает `committed`, `rejectedIndex` и `skipped`; отсюда однозначно
 * восстанавливается судьба каждого индекса. Записывается вся команда целиком, а не её вид: таймеры,
 * отмены и аннотации не восстанавливаются ни из журнала, ни из заявок.
 */
function describeCommands(
  commands: readonly ActorCommand[],
  outcome: { readonly committed: number; readonly rejectedIndex: number | null; readonly rejectedReason: string | null; readonly halt: { readonly reason: string } | null },
): readonly ActorTimelineCommand[] {
  return commands.map((command, i) => {
    if (i < outcome.committed) return { command, outcome: { status: 'applied' as const } };
    if (outcome.rejectedIndex === i) {
      return { command, outcome: { status: 'rejected' as const, reason: outcome.rejectedReason ?? 'причина не указана' } };
    }
    const reason =
      outcome.halt !== null
        ? `батч остановлен: ${outcome.halt.reason}`
        : `суффикс оборван после отклонённой команды #${outcome.rejectedIndex ?? '?'}`;
    return { command, outcome: { status: 'skipped' as const, reason } };
  });
}
