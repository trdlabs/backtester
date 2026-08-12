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
// Поэтому здесь два якоря, и оба сравнивают ДВЕ НЕЗАВИСИМО ПОСЧИТАННЫЕ величины:
//
//   • свёртка журнала движковыми `applyFill`/`applyFunding` обязана дать записанный `finalLedger`
//     ЦЕЛИКОМ, включая массив филлов поле в поле;
//   • деривация сделок (`deriveActorTrades`) обязана сойтись с тем же леджером через
//     `reconcileRealizedPnl` — деривация относит комиссию входа к закрытию, леджер реализует её
//     сразу, и ошибка в любой из двух бухгалтерий видна ровно на их равенстве.
//
// Обе величины считает ДВИЖОК. Собственный счёт здесь был бы вторым интерпретатором бухгалтерии —
// ровно тем, ради прекращения чего существует `@trdlabs/engine`, — и доказывал бы лишь то, что две
// мои копии согласны между собой.
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
import {
  EMPTY_LEDGER,
  applyFill,
  applyFunding,
  deriveActorTrades,
  reconcileRealizedPnl,
} from '@trdlabs/engine';
import type {
  AccountingEntry,
  ActorTrade,
  Fill,
  Ledger,
  OrderState,
  RiskDecision,
  Trade,
} from '@trdlabs/engine';

import type { DecisionRecord, EquityPoint, SimulatedFill, SimulatedOrder } from '../artifacts.js';
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
 * Сколько филлов ОБЯЗАНО быть у ордера в каждом состоянии автомата.
 *
 * Ловит рассинхрон двух половин записи. Раннер, записавший филл и не продвинувший FSM, отдаёт ордер
 * в `accepted` с исполнением — артефакт объявит заявку неисполненной, хотя позиция уже поехала.
 * Обратный случай так же нем: `filled` без единого филла.
 *
 * `either` у `canceled` и `cancel_pending` — не лазейка, а факт: отмена после частичного исполнения
 * законна, и требовать здесь определённости значило бы запретить штатный сценарий.
 */
const FILLS_EXPECTED_BY_STATE: Readonly<Record<OrderState, 'none' | 'some' | 'either'>> = {
  pending_new: 'none',
  accepted: 'none',
  partially_filled: 'some',
  cancel_pending: 'either',
  filled: 'some',
  canceled: 'either',
  rejected: 'none',
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
    // Проверяется РОВНО невозрастание конечной точки: `lastCommittedSeq` соседних frontier'ов не
    // убывает. Убывание означает, что раннер переиграл уже применённые события, и выглядит это как
    // нормальная работа.
    //
    // Чего эта проверка НЕ доказывает — непрерывности `seq` из §3.5. Здесь видны только КОНЕЧНЫЕ
    // точки frontier'ов, а дыра внутри frontier'а конечную точку не двигает вовсе; равенство
    // соседних значений так же неотличимо от «в этом frontier'е не зафиксировано ничего».
    // Непрерывность может утверждать только тот, кто видит сам поток событий, — гард
    // gap/duplicate на стороне раннера, а не эта проекция.
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
 * Поля `Fill`, сверяемые побайтово. Список явный и ПОЛНЫЙ по типу — см. утверждение ниже.
 *
 * Перечислять руками пришлось потому, что `Object.keys` работает со значением, а забытое поле надо
 * ловить на СБОРКЕ: ровно так и появилась дыра, которую этот блок закрывает.
 */
const FILL_FIELDS = ['fillId', 'tsUs', 'price', 'qty', 'side', 'fee', 'causedBy'] as const;

/** Новое поле `Fill` красит сборку, а не проезжает несверенным. */
type _AllFillFieldsCompared = Exclude<keyof Fill, (typeof FILL_FIELDS)[number]> extends never
  ? true
  : never;
const _fillFieldsCovered: _AllFillFieldsCompared = true;
void _fillFieldsCovered;

/**
 * Сверить филлы якоря со свёрнутыми ПОЛНОСТЬЮ и ПО ПОРЯДКУ.
 *
 * Сравнение по длине было настоящей дырой, а не недостающей строгостью про запас. Арифметика
 * леджера не читает ни `fillId`, ни `causedBy` вовсе: филл, приписанный чужой заявке, не двигает ни
 * экспозицию, ни `avgPrice`, ни `realizedPnl` — то есть проходил все скалярные проверки насквозь.
 * А `causedBy` и есть «fills by causation» (§3.7): по нему `fillsCausedBy` отвечает, чем исполнена
 * конкретная заявка. Подмена делала бы этот ответ ложным при полностью сошедшейся бухгалтерии.
 *
 * Порядок сверяется позиционно по той же причине: две перестановленные записи дают ту же сумму и
 * ту же позицию, но другую историю, а история — это то, ради чего журнал и ведут.
 */
function assertFillsIdentical(folded: readonly Fill[], anchor: readonly Fill[]): void {
  if (folded.length !== anchor.length) {
    fail(`свёртка журнала не сходится с finalLedger: филлов ${folded.length} против ${anchor.length}`);
  }
  for (let i = 0; i < folded.length; i += 1) {
    const a = folded[i]!;
    const b = anchor[i]!;
    for (const field of FILL_FIELDS) {
      if (!Object.is(a[field], b[field])) {
        fail(
          `finalLedger.fills[${i}].${field}: записано ${String(b[field])}, ` +
            `а из журнала следует ${String(a[field])}`,
        );
      }
    }
  }
}

/**
 * Журнал в форме движка — один к одному, порядок сохранён.
 *
 * Порядок БЕРЁТСЯ ИЗ ЗАПИСИ и здесь не изобретается. Первая редакция агрегата держала филлы и
 * funding двумя списками, и проектору приходилось склеивать их правилом «сперва филлы, потом
 * funding в пределах frontier'а». Правило работало — и было ЛИШНИМ знанием на стороне проектора:
 * раннер применил в одном порядке, проектор склеил в другом, и апорционирование funding по
 * закрываемой доле разъехалось бы в последнем разряде, никого не потревожив.
 */
function journalEntriesFor(record: ActorExecutionRecord): readonly AccountingEntry[] {
  return record.journal.map((entry) =>
    entry.kind === 'fill'
      ? ({ kind: 'fill', fill: ledgerFillOf(entry) } as const)
      : ({ kind: 'funding', settlement: { tsUs: entry.tsUs, cost: entry.cost } } as const),
  );
}

/** Свернуть журнал движковыми функциями. */
function foldJournal(entries: readonly AccountingEntry[]): Ledger {
  let ledger: Ledger = EMPTY_LEDGER;
  for (const entry of entries) {
    ledger =
      entry.kind === 'fill'
        ? applyFill(ledger, entry.fill)
        : applyFunding(ledger, entry.settlement);
  }
  return ledger;
}

function assertLedgerAgrees(folded: Ledger, anchor: Ledger): void {
  const mismatch: string[] = [];
  if (!Object.is(folded.qty, anchor.qty)) mismatch.push(`qty ${folded.qty} против ${anchor.qty}`);
  if (!Object.is(folded.avgPrice, anchor.avgPrice)) {
    mismatch.push(`avgPrice ${folded.avgPrice} против ${anchor.avgPrice}`);
  }
  if (!Object.is(folded.realizedPnl, anchor.realizedPnl)) {
    mismatch.push(`realizedPnl ${folded.realizedPnl} против ${anchor.realizedPnl}`);
  }
  if (!Object.is(folded.openedAtUs, anchor.openedAtUs)) {
    mismatch.push(`openedAtUs ${folded.openedAtUs} против ${anchor.openedAtUs}`);
  }
  if (mismatch.length > 0) {
    fail(`свёртка журнала не сходится с finalLedger: ${mismatch.join('; ')}`);
  }
  assertFillsIdentical(folded.fills, anchor.fills);
}

/**
 * Тождество «сделки ≡ леджер» — ГЕЙТ РЕПИНА, и это надо назвать точно.
 *
 * Он НЕ ловит дефекты раннера: свёртка журнала выше уже сравнила `realizedPnl` с якорем, поэтому к
 * этому месту обе величины сходятся всегда, ЕСЛИ движок держит собственное тождество. Ловит он
 * ровно противоположное — момент, когда движок перестаёт его держать: смена разложения комиссии,
 * funding или границы эры в `deriveActorTrades` без соответствующей смены `applyFill`. Такая правда
 * приезжает к потребителю подъёмом пина и иначе была бы невидима до расхождения чисел в отчёте.
 *
 * Отдельной функцией, потому что вызвать её с расходящимися величинами — единственный способ
 * проверить саму ветку: изнутри проекции она недостижима по построению, а недостижимую ветку
 * покрывают либо ложью в фикстуре, либо вот так.
 */
export function assertTradesReconcile(reconciled: number, anchorRealizedPnl: number): void {
  if (!Object.is(reconciled, anchorRealizedPnl)) {
    fail(
      `сделки и леджер разошлись: сведённый realizedPnl ${reconciled} против ` +
        `${anchorRealizedPnl} в finalLedger. Обе величины считает движок — расхождение означает, ` +
        'что его деривация и его же леджер разъехались, а не что раннер что-то записал не так',
    );
  }
}

/**
 * Идентификатор сделки — по правилу legacy, чтобы прогоны двух lifecycle читались одной меркой.
 *
 * Это НЕ экономика и потому не нарушает запрет на самостоятельный пересчёт в хосте: имя строится из
 * барных индексов и символа, которых у движка нет по построению. «Богатая» форма (с `-c<seq>`)
 * включается ровно там же, где у legacy: частичное закрытие, защита либо не первое закрытие.
 */
function isRichClose(t: ActorTrade): boolean {
  return t.partial || t.closeReason === 'stop_hit' || t.closeReason === 'take_hit' || t.closeSeq > 0;
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
  const barOfTsUs = new Map(frontiers.map((f) => [Number(f.tsUs), f.index]));

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

  // --- Журнал: филлы и funding в ОДНОМ порядке ---
  const seenFillId = new Set<string>();
  const fillsPerOrder = new Map<string, number>();
  const fills: SimulatedFill[] = [];
  const fundingLedger: FundingLedgerEntry[] = [];
  for (let i = 0; i < record.journal.length; i += 1) {
    const entry = record.journal[i]!;
    const frontier = frontierAt(frontiers, entry.frontier, `журнал[${i}]`);
    // Один frontier — один business-момент (§3.8). Запись, чья метка не равна метке своего
    // frontier'а, означает, что раннер склеил два момента в один; числа при этом остаются
    // правдоподобными, а порядок событий — уже нет.
    if (Number(entry.tsUs) !== Number(frontier.tsUs)) {
      fail(
        `журнал[${i}]: метка ${Number(entry.tsUs)} не равна business-времени своего frontier'а ${Number(frontier.tsUs)}`,
      );
    }
    const ts = msOf(Number(entry.tsUs), `журнал[${i}]`);

    if (entry.kind === 'funding') {
      fundingLedger.push({
        barIndex: entry.frontier,
        ts,
        rate: entry.rate,
        covered: entry.covered,
        cost: entry.cost,
      });
      continue;
    }

    if (seenFillId.has(entry.fillId)) fail(`филл ${entry.fillId} записан дважды`);
    seenFillId.add(entry.fillId);
    if (!seenOrderId.has(entry.orderId)) {
      fail(`филл ${entry.fillId} ссылается на незаписанный ордер ${entry.orderId}`);
    }
    fillsPerOrder.set(entry.orderId, (fillsPerOrder.get(entry.orderId) ?? 0) + 1);
    fills.push({
      orderId: entry.orderId,
      fillBarIndex: entry.frontier,
      fillTs: ts,
      fillPrice: entry.price,
      baseOpen: entry.baseOpen,
      slippageBps: entry.slippageBps,
      feePaid: entry.fee,
      size: entry.qty,
      ...(entry.fillKind !== undefined ? { kind: entry.fillKind } : {}),
    });
  }
  assertNonDecreasing(
    record.journal.map((e) => e.frontier),
    'журнал',
  );

  // Состояние автомата обязано соответствовать наличию исполнений — иначе две половины записи
  // рассказывают разные истории про одну заявку, и артефакт унаследует ту, что неверна.
  for (const o of record.orders) {
    const count = fillsPerOrder.get(o.orderId) ?? 0;
    const expected = FILLS_EXPECTED_BY_STATE[o.terminalState];
    if (expected === 'none' && count > 0) {
      fail(`ордер ${o.orderId} в состоянии ${o.terminalState}, но у него ${count} исполнений`);
    }
    if (expected === 'some' && count === 0) {
      fail(`ордер ${o.orderId} в состоянии ${o.terminalState}, но исполнений у него нет`);
    }
  }

  // Аннотация, указывающая в пустоту, — тихая потеря причины: движок просто не найдёт её у своего
  // закрывающего филла и отвергнет запись как неаннотированную, назвав НЕ ТУ причину отказа.
  for (const c of record.closes) {
    if (!seenFillId.has(c.exitFillId)) {
      fail(`аннотация закрытия ссылается на незаписанный филл ${c.exitFillId}`);
    }
  }

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

  // --- Вердикты риска: своя форма уже артефактная, проверяется адресация ---
  for (const rd of record.riskDecisions) {
    frontierAt(frontiers, rd.barIndex, `вердикт риска (${rd.decisionKind})`);
  }
  assertNonDecreasing(
    record.riskDecisions.map((rd) => rd.barIndex),
    'вердикты риска',
  );

  // --- Бухгалтерия: два независимых счёта обязаны сойтись ---
  const entries = journalEntriesFor(record);
  assertLedgerAgrees(foldJournal(entries), record.finalLedger);

  // --- Сделки: считает ДВИЖОК, хост принёс только причины ---
  const forcedExit =
    record.forcedExit === undefined
      ? undefined
      : {
          tsUs: frontierAt(frontiers, record.forcedExit.frontier, 'forcedExit').tsUs,
          price: record.forcedExit.price,
        };

  let derivation;
  try {
    derivation = deriveActorTrades(entries, {
      closes: record.closes,
      ...(forcedExit !== undefined ? { forcedExit } : {}),
    });
  } catch (cause) {
    // Отказ движка — заявление о записи, и вызывающему он нужен целиком: «нет аннотации причины у
    // филла X» чинится адресно, «проекция упала» — нет.
    fail(`деривация сделок отвергла запись: ${(cause as Error).message}`);
  }

  assertTradesReconcile(reconcileRealizedPnl(derivation), record.finalLedger.realizedPnl);

  const trades: Trade[] = derivation.trades.map((t) => {
    const entryBarIndex = barOfTsUs.get(Number(t.openedAtUs));
    const exitBarIndex = barOfTsUs.get(Number(t.closedAtUs));
    if (entryBarIndex === undefined || exitBarIndex === undefined) {
      fail(`сделка эры ${t.era}: метка входа либо выхода не попадает ни в один frontier`);
    }
    const base = `trade-${record.symbol}-${entryBarIndex}-${exitBarIndex}`;
    return {
      id: isRichClose(t) ? `${base}-c${t.closeSeq}` : base,
      symbol: record.symbol,
      side: t.side,
      entryBarIndex,
      entryTs: msOf(Number(t.openedAtUs), `сделка эры ${t.era} (вход)`),
      entryFillPrice: t.entryPrice,
      exitBarIndex,
      exitTs: msOf(Number(t.closedAtUs), `сделка эры ${t.era} (выход)`),
      exitFillPrice: t.exitPrice,
      size: t.size,
      feePaid: t.feePaid,
      realizedPnl: t.realizedPnl,
      closeReason: t.closeReason,
      // Опциональные ключи опускаются, когда инертны — идиома байт-идентичности артефактов.
      ...(t.fundingPaid !== 0 ? { fundingPaid: t.fundingPaid } : {}),
      ...(t.synthetic !== undefined ? { synthetic: t.synthetic } : {}),
      ...(t.partial ? { closeKind: 'partial' as const } : {}),
      ...(isRichClose(t) ? { closeSeq: t.closeSeq } : {}),
    };
  });

  return {
    // Пусто и НЕ по недосмотру: у актора `onEvent → ActorCommand[]`, у legacy
    // `hook → StrategyDecision` — разные словари. ВРЕМЕННО: до раскатки обязателен отдельный
    // actor timeline/artifact, потому что `frontiers` дальше этого слоя сегодня не уезжают.
    decisionRecords: [],
    orders,
    fills,
    riskDecisions: record.riskDecisions,
    trades,
    equityCurve,
    fundingLedger,
    // Отказы допуска случаются ДО прогона и до этого слоя не доезжают: спроецированный прогон по
    // построению состоялся.
    validationIssues: [],
  };
}
