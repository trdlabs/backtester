// 083 S3 — ЯВНЫЙ АГРЕГАТ ВХОДНЫХ ДАННЫХ проекции «actor execution → артефакты прогона».
//
// ═══ ЗАЧЕМ ЭТОТ ТИП ВООБЩЕ СУЩЕСТВУЕТ ═══
//
// Напрашивался другой ответ: «проекция читает execution ledger». Ledger объявлен SSOT бухгалтерии
// (§3.7), и казалось, что артефакты прогона — его производная. Сверка форм это ОПРОВЕРГЛА, и
// опровергла по всем семи семействам, которые обязан заполнить прогон.
//
// Артефакты несут факты ЧЕТЫРЁХ разных природ, и журнал исполнений — только одна из них:
//
//   1. бухгалтерские    — экспозиция, avgPrice, realizedPnl. ЭТО ledger даёт, и только это.
//   2. модели исполнения — цена до проскальзывания и сам bps. Существуют в момент матчинга и
//                          нигде не сохраняются: ledger видит уже исполненную цену.
//   3. хостовой политики — вердикты RiskEngine, причина закрытия. Ledger про них не знает по
//                          построению: §3.5 держит RiskEngine на стороне хоста.
//   4. пербарные        — equity как mark-to-market. Журнал разрежен по событиям, кривая обязана
//                          быть на каждом баре.
//
// Вывести (2)–(4) из (1) нельзя. Обратная арифметика вида `baseOpen = price / (1 ± bps/1e4)`
// технически считается, но это ИЗОБРЕТЁННАЯ точность: деление вносит ошибку округления, которой в
// исходных числах не было, и зашивает допущение о мультипликативной модели проскальзывания. Смена
// модели сделала бы восстановление молча неверным — худший из возможных исходов.
//
// Отсюда роль этого типа: он НЕ контейнер для удобства проектора. Он — СПИСОК ОБЯЗАТЕЛЬСТВ
// ГОРЯЧЕГО РАННЕРА: каждое поле называет факт, который раннер обязан записать в тот момент, когда
// факт ещё существует. Что не записано здесь — потеряно навсегда, и проекция это обнаружит отказом,
// а не догадкой.
//
// ═══ ПОЛНЫЙ MAPPING (зафиксирован до реализации, требование владельца 2026-08-12) ═══
//
// | артефакт `RunOutcome`        | источник                          | достаточен ли ledger |
// | ---------------------------- | --------------------------------- | -------------------- |
// | `SimulatedOrder`             | `ActorOrderRecord`                | НЕТ — заявка без филлов не оставляет в журнале следа вовсе |
// | `SimulatedFill`              | `ActorFillRecord`                 | НЕТ — нет `baseOpen`, `slippageBps`, барного индекса |
// | `Trade`                      | `ActorExecutionRecord.trades`     | НЕТ — нет `closeReason`, нет разложения комиссии входа и funding по закрытой доле |
// | `DecisionRecord`             | — (пусто на actor-пути)           | неприменимо — другой словарь, см. ниже |
// | `RiskDecision`               | `ActorExecutionRecord.riskDecisions` | НЕТ — ledger про хостовую политику не знает |
// | `EquityPoint`                | `ActorEquitySample`               | НЕТ — нужна нереализованная часть на КАЖДОМ баре |
// | `FundingLedgerEntry`         | `ActorFundingRecord`              | НЕТ — движковый `applyFunding` складывает `cost` в `realizedPnl` и записи не оставляет; `rate`/`covered` не восстановить |
//
// **`Trade` записывается, а не выводится, и это не лень.** `Portfolio.closePosition` строит сделку
// из состояния, которого у акторного `Ledger` НЕТ: накопленной комиссии входа за текущую эру,
// накопленного funding и счётчика закрытий. Вывести `feePaid = entryFeeClosed + fill.fee` из
// журнала невозможно — журнал знает только сумму комиссий, не их разложение по эрам. Попытка
// вывести дала бы второй, расходящийся с движком счёт — ровно ту двухинтерпретаторную беду, ради
// прекращения которой заведён `@trdlabs/engine`.
//
// **`DecisionRecord` на actor-пути пуст, и это решение, а не пропуск.** У актора `onEvent →
// ActorCommand[]`, у legacy `hook → StrategyDecision`. Это разные словари, и расширение общей формы
// стоило бы дорого: её видят голдены и comparison. Развилка записана в спеке 083 (требование S3
// «проекция предшествует горячему раннеру»); пофронтирная запись актора существует здесь как
// `frontiers` и ждёт решения по адресу, куда её класть.
//
// ═══ ЧЕГО ЗДЕСЬ НЕТ ═══
//
// Ни одного поля «на будущее». Каждое поле обязано быть либо прочитано проекцией, либо проверено
// ею; непрочитанное поле агрегата — это обязательство раннера, которое никто не исполняет и никто
// не ловит.

import type {
  Fill,
  FillSide,
  Ledger,
  OrderState,
  RiskDecision,
  Trade,
} from '@trdlabs/engine';
import type { TimestampUs } from '@trdlabs/sdk/research-contract';

/**
 * Один frontier — один business-момент `U` для одного инстанса актора (§3.8).
 *
 * Играет роль ОСИ всего агрегата: артефакты бэктестера адресуются барным индексом (`barIndex`) и
 * миллисекундной меткой, а актор живёт в µs и в номерах frontier'ов. Хранить у каждого филла свой
 * `barIndex` и свой `ts` значило бы дать двум записям возможность разойтись в том, какой это был
 * бар. Здесь ось одна, и все остальные записи ссылаются на неё номером.
 */
export interface ActorFrontierRecord {
  /** 0-based, монотонно возрастает с шагом 1. Становится `barIndex` артефакта напрямую. */
  readonly index: number;
  /** Business-время `U`. Метка строится ТОЛЬКО через `timestampUsFromMillis` (требование S3). */
  readonly tsUs: TimestampUs;
  /**
   * Последний `seq`, эффекты которого зафиксированы на конец этого frontier'а.
   *
   * Проекция проверяет по нему РОВНО одно: значение не убывает от frontier'а к frontier'у.
   * Убывание означает, что раннер переиграл уже применённые события.
   *
   * Непрерывность actor-local `seq` (§3.5) отсюда НЕ следует и здесь не доказывается: видны только
   * конечные точки, а пропуск внутри frontier'а конечную точку не двигает. Непрерывность —
   * предмет gap/duplicate гарда на стороне раннера, где виден сам поток событий.
   */
  readonly lastCommittedSeq: number;
}

/**
 * Одна поданная заявка — записывается в момент подачи, когда команда актора уже допущена.
 *
 * `terminalState` — состояние ордер-FSM на конец прогона, а не «статус». Сужение семи состояний
 * автомата до трёх статусов артефакта делает ПРОЕКЦИЯ, в одном месте и по таблице, которую видно
 * (см. `ORDER_STATUS_BY_STATE`). Записывать сюда уже суженное значение значило бы потерять
 * различие «отвергнута» и «отменена» до того, как кто-либо решил, что оно не нужно.
 */
export interface ActorOrderRecord {
  readonly orderId: string;
  /** Номер frontier'а, на котором заявка подана. */
  readonly placedAtFrontier: number;
  readonly side: 'long' | 'short';
  readonly intent: 'open' | 'close' | 'add';
  readonly terminalState: OrderState;
  readonly mode?: 'dca' | 'scale_in';
  readonly closeFraction?: number;
  readonly origin?: 'protection';
}

/**
 * Одно исполнение — записывается моделью исполнения в момент матчинга.
 *
 * `baseOpen` и `slippageBps` живут ТОЛЬКО здесь. Это и есть главная причина, по которой ledger'а
 * недостаточно: он видит `price` уже после применения проскальзывания, а обе исходные величины к
 * этому моменту перестали существовать.
 */
export interface ActorFillRecord {
  readonly fillId: string;
  /** Заявка, которую исполняет этот филл («fills by causation», §3.7). */
  readonly orderId: string;
  readonly frontier: number;
  readonly tsUs: TimestampUs;
  /** Цена исполнения — ПОСЛЕ проскальзывания. */
  readonly price: number;
  /** Цена до проскальзывания. Существует только в момент матчинга. */
  readonly baseOpen: number;
  readonly slippageBps: number;
  /** Всегда положительный размер; знак движения позиции несёт `side`. */
  readonly qty: number;
  readonly fee: number;
  readonly side: FillSide;
  readonly kind?: 'open' | 'add' | 'close' | 'protection';
}

/** Один funding-расчёт. `rate` и `covered` не выводимы ни из чего — записываются резолвером. */
export interface ActorFundingRecord {
  readonly frontier: number;
  readonly tsUs: TimestampUs;
  readonly rate: number;
  readonly covered: boolean;
  readonly cost: number;
}

/**
 * Точка equity — ОДНА НА КАЖДЫЙ frontier, без пропусков.
 *
 * Полнота обязательна, и цена её нарушения известна заранее: `effectiveElapsedYears` считает
 * прошедшее время ПО КРИВОЙ EQUITY, а не по запрошенному окну. Пропущенные точки не «немного
 * огрубят график» — они сожмут знаменатель годовой доходности и завысят cagr/calmar молча.
 * Метки времени здесь нет намеренно: она берётся у frontier'а по номеру, и разойтись им негде.
 */
export interface ActorEquitySample {
  readonly frontier: number;
  readonly equity: number;
}

/**
 * Всё, что горячий раннер обязан записать за один прогон одного символа.
 *
 * `finalLedger` — ЯКОРЬ СВЕРКИ, а не удобство. Проекция сворачивает записанные филлы движковым
 * `applyFill` и требует совпадения с этим значением. Без якоря агрегат был бы просто набором
 * списков, про которые никто не проверяет, что они описывают одну и ту же историю: раннер, забывший
 * записать один филл, отдал бы внутренне непротиворечивые артефакты с неверной позицией.
 */
export interface ActorExecutionRecord {
  readonly symbol: string;
  readonly frontiers: readonly ActorFrontierRecord[];
  readonly orders: readonly ActorOrderRecord[];
  readonly fills: readonly ActorFillRecord[];
  readonly funding: readonly ActorFundingRecord[];
  readonly equity: readonly ActorEquitySample[];
  /** Вердикты хостового RiskEngine. `barIndex` каждого — номер frontier'а. */
  readonly riskDecisions: readonly RiskDecision[];
  /** Сделки в том виде, в каком их построил закрывающий их код (см. шапку — почему не выводятся). */
  readonly trades: readonly Trade[];
  readonly finalLedger: Ledger;
}

/** Форма филла для движкового `applyFill` — проекция сворачивает записанное ИМ, а не своей копией. */
export function ledgerFillOf(record: ActorFillRecord): Fill {
  return {
    fillId: record.fillId,
    tsUs: record.tsUs,
    price: record.price,
    qty: record.qty,
    side: record.side,
    fee: record.fee,
    causedBy: record.orderId,
  };
}
