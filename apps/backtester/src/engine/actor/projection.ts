// 083 S3 — проекция «actor execution record → артефакты прогона». ЧИСТАЯ и ПРОВЕРЯЮЩАЯ.
//
// Горячий цикл сюда не подключён и подключается только после того, как этот слой зелен, —
// требование владельца от 2026-08-12. Модуль не знает ни про раннер, ни про песочницу, ни про
// очередь: на вход значение, на выход значение.
//
// ═══ ПОЧЕМУ ПРОЕКЦИЯ ПРОВЕРЯЕТ, А НЕ ПРОСТО ПЕРЕКЛАДЫВАЕТ ═══
//
// Формы двух сторон известны, и большая часть работы здесь — переименование полей и перевод единиц.
// Соблазн написать семь `map` и закончить велик. Он неверен: агрегат приходит от горячего раннера,
// а раннер — единственное место, где факт можно потерять молча. Раннер, забывший записать один
// филл, отдаёт внутренне НЕПРОТИВОРЕЧИВЫЕ списки: ордера на месте, кривая equity непрерывна, сделки
// закрыты. Разойдётся только позиция, и разойдётся тихо.
//
// Поэтому проекция сворачивает записанные филлы ДВИЖКОВЫМ `applyFill` и требует совпадения с
// записанным `finalLedger`. Это не «дополнительная проверка на всякий случай», а единственный
// момент, когда две половины записи можно сличить: дальше по конвейеру якоря уже нет.
//
// Сворачивается движковой функцией, а не своей копией арифметики, намеренно. Собственный счёт был
// бы вторым интерпретатором бухгалтерии — ровно тем, ради прекращения чего существует
// `@trdlabs/engine`. Сверка своей копией доказывала бы лишь то, что две мои копии согласны между
// собой.
//
// ═══ ПОРЯДОК АРТЕФАКТОВ ═══
//
// Проекция НИЧЕГО НЕ СОРТИРУЕТ. Порядок записи и есть порядок исполнения, и пересортировка скрыла
// бы раннер, записывающий не в том порядке, — то есть заменила бы обнаружимый дефект на
// необнаружимый. Вместо сортировки стоит утверждение: номера frontier'ов не убывают вдоль каждого
// списка. Нарушение — отказ.
//
// Отсюда стабильность порядка следует по построению, а не обещанием: выход — та же
// последовательность, что вход, и одинаковый вход даёт побайтово одинаковый выход.

import type { ValidationIssue } from '@trading/research-contracts/research';
import { EMPTY_LEDGER, applyFill, applyFunding } from '@trdlabs/engine';
import type { Ledger, OrderState, RiskDecision, Trade } from '@trdlabs/engine';

import type {
  DecisionRecord,
  EquityPoint,
  SimulatedFill,
  SimulatedOrder,
} from '../artifacts.js';
import type { FundingLedgerEntry } from '../runner.js';
import { ledgerFillOf } from './execution-record.js';
import type { ActorExecutionRecord, ActorFrontierRecord } from './execution-record.js';

/** Микросекунд в миллисекунде. Артефакты бэктестера живут в мс, актор — в µs. */
const US_PER_MS = 1000;

/**
 * Отказ проекции. Отдельный класс, потому что вызывающий обязан отличать его от прикладной ошибки
 * прогона: это заявление о том, что ЗАПИСЬ несамосогласованна, и чинить надо раннер, а не стратегию.
 */
export class ActorProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActorProjectionError';
  }
}

/**
 * Сужение семи состояний ордер-FSM до трёх статусов артефакта.
 *
 * Таблицей, а не цепочкой условий: `Record<OrderState, …>` красит СБОРКУ, когда автомат обзаведётся
 * восьмым состоянием, — тогда как `switch` с `default` молча отнёс бы его к какому-нибудь статусу.
 *
 * Сужение ЛОССИ, и это названо честно. У `SimulatedOrder.status` нет слов «отменена» и «отвергнута»:
 * артефакт различает только «ждёт», «исполнилась» и «не исполнилась». Оба терминальных отказа
 * попадают в `expired` — единственное имеющееся слово для «не исполнилась». Неизбежное различие не
 * теряется: `ActorOrderRecord.terminalState` несёт исходное состояние, и когда артефакту понадобится
 * его различать, расширять придётся артефакт, а не восстанавливать потерянное.
 */
export const ORDER_STATUS_BY_STATE: Readonly<Record<OrderState, SimulatedOrder['status']>> = {
  pending_new: 'pending',
  accepted: 'pending',
  partially_filled: 'pending',
  cancel_pending: 'pending',
  filled: 'filled',
  canceled: 'expired',
  rejected: 'expired',
};

/**
 * Артефакты одного actor-прогона.
 *
 * Поля повторяют `MergedAccumulators` раннера ОДИН В ОДИН — это не совпадение, а условие: конечную
 * сборку (`summary`, метрики, evidence) обязан выполнять тот же `assembleResult`, что и на
 * legacy-пути. Своя сборка у actor-пути означала бы второй владелец формы результата, и разойтись
 * они смогли бы в чём угодно, вплоть до состава evidence.
 */
export interface ActorRunArtifacts {
  readonly decisionRecords: readonly DecisionRecord[];
  readonly orders: readonly SimulatedOrder[];
  readonly fills: readonly SimulatedFill[];
  readonly riskDecisions: readonly RiskDecision[];
  readonly trades: readonly Trade[];
  readonly equityCurve: readonly EquityPoint[];
  readonly fundingLedger: readonly FundingLedgerEntry[];
  readonly validationIssues: readonly ValidationIssue[];
}

function fail(message: string): never {
  throw new ActorProjectionError(message);
}

/**
 * Перевод µs → мс БЕЗ потери.
 *
 * Дробный остаток отвергается, а не округляется. Округление здесь выглядело бы безобидно (метки
 * баров минутные, остатка не бывает) и именно поэтому опасно: первая же метка не с минутной сетки
 * поехала бы в артефакты уже искажённой, и расхождение с лентой обнаружилось бы далеко отсюда.
 */
function msOf(tsUs: number, what: string): number {
  if (!Number.isInteger(tsUs)) fail(`${what}: метка ${tsUs} не целая — µs обязаны быть целыми`);
  if (tsUs % US_PER_MS !== 0) {
    fail(`${what}: метка ${tsUs} мкс не кратна миллисекунде — перевод был бы с потерей`);
  }
  return tsUs / US_PER_MS;
}

/** Ось прогона: номер frontier'а → его запись. Заодно проверяет саму ось. */
function frontierAxis(record: ActorExecutionRecord): readonly ActorFrontierRecord[] {
  const frontiers = record.frontiers;
  if (frontiers.length === 0) fail('frontiers пуст — у прогона нет ни одного business-момента');

  let prevTsUs = -1;
  let prevSeq = -1;
  for (let i = 0; i < frontiers.length; i += 1) {
    const f = frontiers[i]!;
    // Номер обязан совпадать с позицией: он становится `barIndex` артефакта напрямую, и дыра в
    // нумерации сдвинула бы каждый последующий бар, оставив числа правдоподобными.
    if (f.index !== i) fail(`frontier[${i}]: index ${f.index} не совпадает с позицией ${i}`);
    const tsUs = Number(f.tsUs);
    msOf(tsUs, `frontier[${i}]`);
    if (tsUs <= prevTsUs) {
      fail(`frontier[${i}]: business-время ${tsUs} не возрастает (предыдущее ${prevTsUs})`);
    }
    // §3.5: actor-local `seq` непрерывен и монотонен. Убывание означает, что раннер переиграл уже
    // применённые события либо потерял неприменённые — оба исхода выглядят как нормальная работа.
    if (f.lastCommittedSeq < prevSeq) {
      fail(`frontier[${i}]: lastCommittedSeq ${f.lastCommittedSeq} меньше предыдущего ${prevSeq}`);
    }
    prevTsUs = tsUs;
    prevSeq = f.lastCommittedSeq;
  }
  return frontiers;
}

/** Проверить ссылку на frontier и вернуть его. */
function frontierAt(
  frontiers: readonly ActorFrontierRecord[],
  index: number,
  what: string,
): ActorFrontierRecord {
  const f = frontiers[index];
  if (f === undefined || index !== f.index) {
    fail(`${what}: ссылка на frontier ${index}, которого нет (всего ${frontiers.length})`);
  }
  return f;
}

/** Номера frontier'ов вдоль списка не убывают — запись идёт в порядке исполнения. */
function assertNonDecreasing(indices: readonly number[], what: string): void {
  for (let i = 1; i < indices.length; i += 1) {
    if (indices[i]! < indices[i - 1]!) {
      fail(`${what}: порядок записи нарушен — frontier ${indices[i]} после ${indices[i - 1]}`);
    }
  }
}

/**
 * Свернуть записанное движковыми функциями и сличить с записанным якорем.
 *
 * Порядок применения ЗАФИКСИРОВАН: внутри одного frontier'а сперва филлы, затем funding. Порядок
 * не косметический — обе операции копят `realizedPnl` десятичной арифметикой, и перестановка
 * слагаемых способна сдвинуть последний разряд. Раннер обязан применять в том же порядке; равенство
 * ниже это и доказывает.
 */
function assertLedgerAgrees(record: ActorExecutionRecord): void {
  let ledger: Ledger = EMPTY_LEDGER;
  let fillAt = 0;
  let fundingAt = 0;
  for (const f of record.frontiers) {
    while (fillAt < record.fills.length && record.fills[fillAt]!.frontier === f.index) {
      ledger = applyFill(ledger, ledgerFillOf(record.fills[fillAt]!));
      fillAt += 1;
    }
    while (fundingAt < record.funding.length && record.funding[fundingAt]!.frontier === f.index) {
      const entry = record.funding[fundingAt]!;
      ledger = applyFunding(ledger, { tsUs: entry.tsUs, cost: entry.cost });
      fundingAt += 1;
    }
  }

  const anchor = record.finalLedger;
  const mismatch: string[] = [];
  if (!Object.is(ledger.qty, anchor.qty)) mismatch.push(`qty ${ledger.qty} против ${anchor.qty}`);
  if (!Object.is(ledger.avgPrice, anchor.avgPrice)) {
    mismatch.push(`avgPrice ${ledger.avgPrice} против ${anchor.avgPrice}`);
  }
  if (!Object.is(ledger.realizedPnl, anchor.realizedPnl)) {
    mismatch.push(`realizedPnl ${ledger.realizedPnl} против ${anchor.realizedPnl}`);
  }
  if (!Object.is(ledger.openedAtUs, anchor.openedAtUs)) {
    mismatch.push(`openedAtUs ${ledger.openedAtUs} против ${anchor.openedAtUs}`);
  }
  if (ledger.fills.length !== anchor.fills.length) {
    mismatch.push(`филлов ${ledger.fills.length} против ${anchor.fills.length}`);
  }
  if (mismatch.length > 0) {
    fail(`свёртка записанных филлов не сходится с finalLedger: ${mismatch.join('; ')}`);
  }
}

/**
 * Спроецировать запись одного actor-прогона в артефакты.
 *
 * Чистая: одно и то же значение на входе даёт неотличимый результат, ambient-источников нет.
 * Отказывает броском `ActorProjectionError` на первом же несоответствии — частично спроецированные
 * артефакты хуже отсутствующих, потому что выглядят полными.
 */
export function projectActorRun(record: ActorExecutionRecord): ActorRunArtifacts {
  const frontiers = frontierAxis(record);

  // --- Ордера ---
  const seenOrderId = new Set<string>();
  const orders: SimulatedOrder[] = [];
  for (const o of record.orders) {
    if (seenOrderId.has(o.orderId)) fail(`ордер ${o.orderId} записан дважды`);
    seenOrderId.add(o.orderId);
    frontierAt(frontiers, o.placedAtFrontier, `ордер ${o.orderId}`);
    orders.push({
      id: o.orderId,
      decisionBarIndex: o.placedAtFrontier,
      side: o.side,
      intent: o.intent,
      status: ORDER_STATUS_BY_STATE[o.terminalState],
      // Необязательные ключи опускаются, когда их нет: `canonicalJson` отбрасывает `undefined`, и
      // прогон без доливок остаётся побайтово равен прогону, у которого этой возможности не было.
      ...(o.mode !== undefined ? { mode: o.mode } : {}),
      ...(o.closeFraction !== undefined ? { closeFraction: o.closeFraction } : {}),
      ...(o.origin !== undefined ? { origin: o.origin } : {}),
    });
  }
  assertNonDecreasing(
    record.orders.map((o) => o.placedAtFrontier),
    'ордера',
  );

  // --- Филлы ---
  const seenFillId = new Set<string>();
  const fills: SimulatedFill[] = [];
  for (const f of record.fills) {
    if (seenFillId.has(f.fillId)) fail(`филл ${f.fillId} записан дважды`);
    seenFillId.add(f.fillId);
    if (!seenOrderId.has(f.orderId)) {
      fail(`филл ${f.fillId} ссылается на незаписанный ордер ${f.orderId}`);
    }
    const frontier = frontierAt(frontiers, f.frontier, `филл ${f.fillId}`);
    // Один frontier — один business-момент (§3.8). Филл, чья метка не равна метке своего
    // frontier'а, означает, что раннер склеил два момента в один; числа при этом остаются
    // правдоподобными, а порядок событий — уже нет.
    if (Number(f.tsUs) !== Number(frontier.tsUs)) {
      fail(
        `филл ${f.fillId}: метка ${Number(f.tsUs)} не равна business-времени своего frontier'а ${Number(frontier.tsUs)}`,
      );
    }
    fills.push({
      orderId: f.orderId,
      fillBarIndex: f.frontier,
      fillTs: msOf(Number(f.tsUs), `филл ${f.fillId}`),
      fillPrice: f.price,
      baseOpen: f.baseOpen,
      slippageBps: f.slippageBps,
      feePaid: f.fee,
      size: f.qty,
      ...(f.kind !== undefined ? { kind: f.kind } : {}),
    });
  }
  assertNonDecreasing(
    record.fills.map((f) => f.frontier),
    'филлы',
  );

  // --- Кривая equity: ровно одна точка на каждый frontier ---
  if (record.equity.length !== frontiers.length) {
    fail(
      `кривая equity: точек ${record.equity.length} при ${frontiers.length} frontier'ах — ` +
        'пропуск сжимает знаменатель годовой доходности и завышает cagr/calmar молча',
    );
  }
  const equityCurve: EquityPoint[] = record.equity.map((sample, i) => {
    if (sample.frontier !== i) {
      fail(`кривая equity: точка ${i} относится к frontier ${sample.frontier}`);
    }
    return {
      barIndex: sample.frontier,
      barTs: msOf(Number(frontiers[i]!.tsUs), `equity[${i}]`),
      equity: sample.equity,
    };
  });

  // --- Funding ---
  const fundingLedger: FundingLedgerEntry[] = record.funding.map((entry, i) => {
    const frontier = frontierAt(frontiers, entry.frontier, `funding[${i}]`);
    if (Number(entry.tsUs) !== Number(frontier.tsUs)) {
      fail(`funding[${i}]: метка не равна business-времени своего frontier'а`);
    }
    return {
      barIndex: entry.frontier,
      ts: msOf(Number(entry.tsUs), `funding[${i}]`),
      rate: entry.rate,
      covered: entry.covered,
      cost: entry.cost,
    };
  });
  assertNonDecreasing(
    record.funding.map((e) => e.frontier),
    'funding',
  );

  // --- Вердикты риска: своя форма уже артефактная, проверяется адресация ---
  for (const rd of record.riskDecisions) {
    frontierAt(frontiers, rd.barIndex, `вердикт риска (${rd.decisionKind})`);
  }
  assertNonDecreasing(
    record.riskDecisions.map((rd) => rd.barIndex),
    'вердикты риска',
  );

  // --- Сделки ---
  for (const t of record.trades) {
    if (t.symbol !== record.symbol) {
      fail(`сделка ${t.id}: символ ${t.symbol} не совпадает с символом прогона ${record.symbol}`);
    }
    frontierAt(frontiers, t.entryBarIndex, `сделка ${t.id} (вход)`);
    frontierAt(frontiers, t.exitBarIndex, `сделка ${t.id} (выход)`);
    if (t.exitBarIndex < t.entryBarIndex) {
      fail(`сделка ${t.id}: выход на баре ${t.exitBarIndex} раньше входа на ${t.entryBarIndex}`);
    }
  }
  assertNonDecreasing(
    record.trades.map((t) => t.exitBarIndex),
    'сделки',
  );

  assertLedgerAgrees(record);

  return {
    // Пусто и НЕ по недосмотру: у актора `onEvent → ActorCommand[]`, у legacy
    // `hook → StrategyDecision` — разные словари. Расширять общую с legacy форму дорого: её видят
    // голдены и comparison. Развилка записана в спеке 083 и ждёт решения владельца; пофронтирная
    // запись актора существует в агрегате как `frontiers` и никуда не теряется.
    decisionRecords: [],
    orders,
    fills,
    riskDecisions: record.riskDecisions,
    trades: record.trades,
    equityCurve,
    fundingLedger,
    // Отказы допуска случаются ДО прогона и до этого слоя не доезжают: спроецированный прогон по
    // построению состоялся.
    validationIssues: [],
  };
}
