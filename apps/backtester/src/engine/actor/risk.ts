// 083 S3 — риск-контур actor-пути: применение `RiskProfile` к КОМАНДЕ, а не к решению.
//
// ═══ ПОЧЕМУ ЗДЕСЬ НЕ ВЫЗОВ ДВИЖКОВОГО `RiskEngine` ═══
//
// `RiskEngine.evaluate` принимает `StrategyDecision` — `enter` / `exit` / `add_to_position` /
// `update_protection`. Актор не производит ни одного из них: он посылает ЗАЯВКУ (`place`), а
// намерение относительно позиции — производная от знака экспозиции и стороны заявки. Перевод
// «команда → решение» НЕ ТОТАЛЕН, и его непереводимая часть перечислена в applicability matrix
// дизайна (`docs/superpowers/specs/2026-08-14-083-s3-actor-risk-design.md` §4):
//
//   • `stopBounds`/`takeBounds` носителя не имеют вовсе — у сырой заявки нет защитных хинтов;
//   • режим долива (`dca` против `scale_in`) командой не сообщается и из косвенных признаков НЕ
//     выводится (решение владельца 2026-08-14).
//
// Позвать `evaluate`, додумав недостающее, значило бы получить вердикт по решению, которого автор
// не принимал. Поэтому здесь применяются ТЕ И ТОЛЬКО ТЕ поля профиля, у которых носитель есть, а
// форма вердикта берётся движковая (`RiskDecision`), чтобы артефакты обоих путей были одной формы.
//
// ═══ ЧТО ЭТА ФУНКЦИЯ ОБЯЗАНА БЫТЬ ═══
//
// ЧИСТОЙ от пары `(command, state)`. `BatchCore.validate` и `BatchCore.apply` получают ровно эту
// пару и вызывают её независимо: `validate` — чтобы отклонить, `apply` — чтобы построить заявку
// клампнутого размера. Два вызова дают тождественный результат, и это не два источника истины, а
// одна функция, вызванная дважды. Кэш между вызовами завёл бы состояние ровно там, где форма
// `BatchCore` его избегает намеренно.

import type { RiskDecision } from '@trdlabs/engine';
import type { ActorPlaceCommand, OrderSide } from '@trdlabs/sdk/research-contract';

import type { ActorEngineState } from './engine-state.js';

/**
 * Сужение `RiskProfile` до полей, у которых на actor-пути ЕСТЬ носитель.
 *
 * Объявлено сужением, а не псевдонимом полного профиля, намеренно: тип — это и есть заявление о
 * применимости. Поле, отсутствующее здесь, невозможно случайно «учесть»; поле, появившееся в
 * профиле позже, потребует осознанного расширения этого типа, а не проедет молча.
 */
export interface ActorRiskProfile {
  readonly id: string;
  readonly version: string;
  /** Потолок одновременных позиций. У одного актора экспозиция одна, см. `openPositionsOf`. */
  readonly maxConcurrentPositions?: number;
  readonly exposureLimits?: { readonly maxPositionNotionalPct: number };
  /** Стороны ПОЗИЦИИ (`long`/`short`), а не стороны заявки (`buy`/`sell`). Разница существенна. */
  readonly allowedSides?: readonly string[];
}

/** Намерение заявки относительно ТЕКУЩЕЙ экспозиции — выводится из знака, а не объявляется. */
export type ActorOrderIntent = 'open' | 'add' | 'close';

/**
 * Намерение заявки. Единственный источник для обоих потребителей — риска и записи прогона.
 *
 * Вынесено сюда из раннера, чтобы правило «что считается наращиванием» существовало в ОДНОМ месте:
 * разойдись эти две копии — и риск отвергал бы одно, а запись прогона называла бы другое.
 */
export function orderIntentOf(signedQty: number, side: OrderSide): ActorOrderIntent {
  if (signedQty === 0) return 'open';
  return Math.sign(signedQty) === (side === 'buy' ? 1 : -1) ? 'add' : 'close';
}

/** Сторона ПОЗИЦИИ, которую откроет заявка. Именно её сравнивает `allowedSides`. */
function resultingPositionSide(side: OrderSide): 'long' | 'short' {
  return side === 'buy' ? 'long' : 'short';
}

/** Число открытых позиций у ОДНОГО актора: экспозиция одна, поэтому 0 либо 1. */
export function openPositionsOf(signedQty: number): number {
  return signedQty === 0 ? 0 : 1;
}

/**
 * Equity, от которой считаются долевые лимиты профиля (SSOT decision 3).
 *
 * ═══ ПОЧЕМУ ЗДЕСЬ НЕТ MARK-ЦЕНЫ, ХОТЯ ФОРМУЛА MTM ЕЁ ТРЕБУЕТ ═══
 *
 * Проектирование закладывало поле `markPrice` в состояние — цену последнего завершённого
 * frontier'а — и обосновывало, почему нельзя брать закрытие ТЕКУЩЕГО бара (команды на
 * `timer.fired` обрабатываются в фазе 2, а свеча доставляется в фазе 4: риск пользовался бы ценой,
 * которой автор ещё не видел). Реализация показала, что предмета у этого спора нет.
 *
 * Потолок экспозиции применяется ТОЛЬКО при открытии позиции, а открытие возможно только из flat:
 * наращивание запрещено профилем, закрытие экспозицию уменьшает. У flat-портфеля нереализованной
 * части нет по определению — `equity = cash`. Значит mark-цена не входит в вердикт ни при каком
 * состоянии, и хранить её значило бы держать поле, которое выглядит как работающая защита, ничего
 * не защищая. Лукахед при этом исключён не дисциплиной, а отсутствием входа для него.
 *
 * Инвариант проверяется, а не подразумевается: вызов при открытой позиции — ошибка вызывающего.
 */
export function flatEquityOf(state: ActorEngineState, initialEquity: number): number {
  if (state.ledger.qty !== 0) {
    throw new Error(
      `flatEquityOf: позиция открыта (qty=${state.ledger.qty}), а долевой лимит считается только ` +
        'при flat — иначе в базу вошла бы нереализованная часть, требующая цены',
    );
  }
  return initialEquity + state.ledger.realizedPnl;
}

/**
 * Вердикт риска по одной команде.
 *
 * `clamp` несёт ГОТОВОЕ значение, а не коэффициент: считать его дважды (в `validate` и в `apply`)
 * по одному правилу — это то же самое, что считать один раз, а по двум разным — тихое расхождение.
 */
export type ActorRiskVerdict =
  | { readonly kind: 'accept' }
  | { readonly kind: 'clamp'; readonly qtyUsd: number; readonly decision: RiskDecision }
  | { readonly kind: 'reject'; readonly reason: string; readonly decision: RiskDecision };

/**
 * Причина риск-отказа несёт МАШИННЫЙ код, а не только человеческий текст.
 *
 * `BatchCore.validate` возвращает одну строку, и она уезжает автору событием `order.denied`.
 * Раннеру же нужно отличить отказ РИСКА от структурного (прогрев, занятый номер, отрицательный
 * размер), чтобы записать первый в `riskDecisions`, — а `applyBatch` возвращает только текст.
 *
 * Разбирать свободную прозу было бы хрупко: любая правка формулировки тихо перестала бы совпадать,
 * и вердикты риска начали бы теряться, не уронив ни одного теста. Поэтому формат объявлен здесь
 * одной парой функций и проверяется round-trip'ом.
 */
const RISK_REFUSAL_PREFIX = 'risk:';

export function formatRiskRefusal(code: string, human: string): string {
  return `${RISK_REFUSAL_PREFIX}${code}: ${human}`;
}

/** Код риск-отказа, если причина принадлежит риску; `null` для любой другой. */
export function parseRiskRefusal(reason: string): string | null {
  if (!reason.startsWith(RISK_REFUSAL_PREFIX)) return null;
  const rest = reason.slice(RISK_REFUSAL_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  return rest.slice(0, sep);
}

function decisionOf(
  state: ActorEngineState,
  action: RiskDecision['action'],
  reason: string,
  clamped?: RiskDecision['clamped'],
): RiskDecision {
  return {
    barIndex: state.frontierIndex,
    decisionKind: 'place',
    action,
    reason,
    ...(clamped !== undefined ? { clamped } : {}),
  };
}

/**
 * Применить профиль к заявке.
 *
 * Порядок проверок НОРМАТИВЕН и идёт от самого широкого запрета к самому узкому: сначала то, что
 * запрещает саму заявку (наращивание, сторона, число позиций), и только потом размер. Обратный
 * порядок отдал бы `clamp` там, где правильный ответ — `reject`, и запись прогона утверждала бы,
 * что заявка была принята уменьшенной, хотя её не следовало принимать вовсе.
 */
export function evaluateActorPlace(
  command: ActorPlaceCommand,
  state: ActorEngineState,
  profile: ActorRiskProfile,
  initialEquity: number,
): ActorRiskVerdict {
  const intent = orderIntentOf(state.ledger.qty, command.side);

  // ── Наращивание ───────────────────────────────────────────────────────────────
  // Профиль без add-лимитов запрещает долив по построению. Режим (`dca` против `scale_in`) командой
  // не сообщается, и выводить его из косвенных признаков запрещено решением владельца: причина
  // отказа поэтому ОДНА и хостовая, а не выбранная за автора из двух движковых.
  if (intent === 'add') {
    const reason = 'add_not_permitted';
    return {
      kind: 'reject',
      reason: formatRiskRefusal(
        reason,
        `профиль ${profile.id}@${profile.version} не разрешает увеличивать открытую позицию ` +
          `(qty=${state.ledger.qty}, заявка ${command.side})`,
      ),
      decision: decisionOf(state, 'reject', reason),
    };
  }

  // ── Сторона и число позиций — только на ОТКРЫТИИ ──────────────────────────────
  // Сокращение не открывает позицию: ни сторона, ни счётчик к нему не относятся. Проверить их на
  // закрытии значило бы запретить ВЫХОД из позиции, которую сам же профиль разрешил открыть, — и
  // запереть капитал в активе, из которого нет выхода.
  // Сторона, счётчик позиций И РАЗМЕР — всё это относится к ОТКРЫТИЮ.
  //
  // Клампить закрытие по потолку экспозиции было бы прямым дефектом: потолок ограничивает, сколько
  // позиции можно НАБРАТЬ, а урезание выхода заперло бы капитал в активе, из которого нет выхода.
  // Проверять сторону на закрытии — то же самое другими словами: `sell` при длинной позиции это
  // выход, а не short.
  if (intent === 'open') {
    if (profile.allowedSides !== undefined) {
      const resulting = resultingPositionSide(command.side);
      if (!profile.allowedSides.includes(resulting)) {
        const reason = 'side_not_allowed';
        return {
          kind: 'reject',
          reason: formatRiskRefusal(
            reason,
            `профиль ${profile.id}@${profile.version} разрешает стороны ` +
              `[${profile.allowedSides.join(', ')}], а заявка ${command.side} открыла бы ${resulting}`,
          ),
          decision: decisionOf(state, 'reject', reason),
        };
      }
    }

    if (profile.maxConcurrentPositions !== undefined) {
      const open = openPositionsOf(state.ledger.qty);
      if (open >= profile.maxConcurrentPositions) {
        const reason = 'max_concurrent_positions';
        return {
          kind: 'reject',
          reason: formatRiskRefusal(
            reason,
            `профиль ${profile.id}@${profile.version} разрешает ` +
              `${profile.maxConcurrentPositions} одновременных позиций, открыто ${open}`,
          ),
          decision: decisionOf(state, 'reject', reason),
        };
      }
    }
    // ── Размер ──────────────────────────────────────────────────────────────────
    // Потолок экспозиции служит и авторитетом сайзинга (SSOT decision 3), но роль риска здесь иная,
    // чем в legacy: размер НАЗНАЧАЕТ автор, риск может его только урезать. Наращивать заявку до
    // потолка нельзя — это назначило бы размер, которого автор не просил.
    const exposure = profile.exposureLimits;
    if (exposure !== undefined && Number.isFinite(exposure.maxPositionNotionalPct)) {
      const equity = flatEquityOf(state, initialEquity);
      const ceiling = exposure.maxPositionNotionalPct * equity;

      // Нулевой или отрицательный потолок означает, что открывать нечего: equity исчерпана либо
      // профиль запрещает экспозицию вовсе. Кламп до нуля дал бы заявку нулевого размера, которую
      // `validate` и так отвергает, — но с ДРУГОЙ причиной, потерявшей риск как виновника.
      if (ceiling <= 0) {
        const reason = 'exposure_ceiling_exhausted';
        return {
          kind: 'reject',
          reason: formatRiskRefusal(
            reason,
            `потолок экспозиции профиля ${profile.id}@${profile.version} равен ${ceiling} ` +
              `(equity=${equity}) — открывать нечем`,
          ),
          decision: decisionOf(state, 'reject', reason),
        };
      }

      if (command.qtyUsd > ceiling) {
        const reason = 'notional_clamped';
        return {
          kind: 'clamp',
          qtyUsd: ceiling,
          decision: decisionOf(state, 'clamp', reason, [
            { field: 'qtyUsd', from: command.qtyUsd, to: ceiling },
          ]),
        };
      }
    }
  }

  return { kind: 'accept' };
}
