// 018 — детерминированный автомат позиции/портфеля (data-model §5, принцип II, FR-010/022).
//
// Единственный механизм мутации позиции: `flat → pending(open) → open → pending(close) → flat`.
// End-of-data forced MTM закрывает открытую позицию по `close` последнего бара (`end_of_data`,
// семантика `forced_mtm`) — без slippage/fee (mark-to-market, equity непрерывна). Истечение
// pending-ордера при отсутствии следующего бара — расширяется в US5.

import { Decimal } from 'decimal.js';

import type { CloseReason, Trade } from './artifacts.js';
import { quantize } from '../determinism/canonical-json.js';

/** Открытая позиция (внутреннее состояние портфеля).
 *
 * 024 (data-model §1): семантика полей при богатом жизненном цикле —
 * - `size` — **кумулятивный** размер: растёт при `add` (DCA/scale-in), убывает при частичном закрытии;
 * - `entryPrice` — **средневзвешенная** цена входа (пересчитывается при доливке, R0);
 * - `entryFee` — **накопленная** комиссия входа (open + все доливки); апропорционируется при partial close;
 * - `entryBarIndex`/`entryTs` — **первый** вход (для `Trade.id` и периода удержания), не меняется при доливке.
 *
 * Опц. поля (`undefined` на чистом open → форма снимка/артефактов байт-идентична 018):
 * - `stop?`/`take?` — дробные дистанции protection от средней цены входа (R0); protection активен ⟺
 *   `stop!==undefined || take!==undefined` (R1);
 * - `addCount?` — число исполненных доливок (для risk `maxAdds` и evidence); `0`/`undefined` на чистом open.
 */
export interface OpenPosition {
  readonly symbol: string;
  readonly side: 'long' | 'short';
  readonly size: number;
  readonly entryPrice: number;
  readonly entryBarIndex: number;
  readonly entryTs: number;
  readonly entryFee: number;
  readonly stop?: number;
  readonly take?: number;
  readonly addCount?: number;
}

/** Pending-ордер, ожидающий next-bar-open fill. */
export interface PendingOrder {
  readonly id: string;
  readonly symbol: string;
  readonly side: 'long' | 'short';
  readonly intent: 'open' | 'close' | 'add';
  readonly decisionBarIndex: number;
  /** Доля equity для sizing (только intent `open`). */
  readonly sizingPct?: number;
  /** Причина закрытия (только intent `close`); переносится в `Trade.closeReason`. */
  readonly closeReason?: CloseReason;
  /** Доля частичного закрытия 0<p<1 (только частичный intent `close`); 024, наполняется US2. */
  readonly closeFraction?: number;
  /** Режим доливки (только intent `add`); 024, наполняется US1. */
  readonly mode?: 'dca' | 'scale_in';
  /** Protection-stop (дробная дистанция, после risk-clamp) для intent `open`; 024 US3. */
  readonly stop?: number;
  /** Protection-take (дробная дистанция, после risk-clamp) для intent `open`; 024 US3. */
  readonly take?: number;
}

/** Параметры открывающего fill (рассчитаны `ExecutionSimulator`). */
export interface OpenFill {
  readonly fillPrice: number;
  readonly fee: number;
  readonly size: number;
  readonly barIndex: number;
  readonly ts: number;
}

/** Параметры закрывающего fill. */
export interface CloseFill {
  readonly fillPrice: number;
  readonly fee: number;
  readonly barIndex: number;
  readonly ts: number;
}

/** Портфель с единственным механизмом мутации позиции (принцип II). */
export class Portfolio {
  private _cash: number;
  private _position: OpenPosition | null = null;
  private _pending: PendingOrder | null = null;
  /** Per-position 0-based порядковый номер следующего закрытия (024, data-model §8). Сброс на `settleOpen`. */
  private _closeSeq = 0;

  constructor(initialEquity: number) {
    this._cash = quantize(initialEquity);
  }

  get cash(): number {
    return this._cash;
  }
  get position(): OpenPosition | null {
    return this._position;
  }
  get pending(): PendingOrder | null {
    return this._pending;
  }
  get isFlat(): boolean {
    return this._position === null;
  }
  /** Portfolio-wide счётчик открытых позиций (MVP: 0 или 1). */
  get openPositions(): number {
    return this._position === null ? 0 : 1;
  }

  /** Нереализованный gross-PnL при mark-цене (0 если flat). */
  grossUnrealized(mark: number): number {
    if (this._position === null) return 0;
    return this.grossAt(this._position, mark);
  }

  /** Mark-to-market equity: `cash + unrealized(mark)`. */
  equityAt(mark: number): number {
    return quantize(new Decimal(this._cash).plus(this.grossUnrealized(mark)).toNumber());
  }

  /**
   * 035 (realism) — charge funding against cash. `cost > 0` = outflow (paid), `cost < 0` = credit (received).
   * Funding is a holding cost on the portfolio, NOT an execution price → it never touches per-trade
   * realizedPnl/feePaid; it surfaces only through cash (and thus `equityAt`). Quantized like other cash flows.
   */
  chargeFunding(cost: number): void {
    this._cash = quantize(new Decimal(this._cash).minus(cost).toNumber());
  }

  /** Поставить pending-ордер (`flat → pending(open)` или `open → pending(close)`). */
  placePending(order: PendingOrder): void {
    if (this._pending !== null) throw new Error('Portfolio.placePending: pending already exists');
    if (order.intent === 'open' && this._position !== null) {
      throw new Error('Portfolio.placePending: open intent while position is open');
    }
    if (order.intent === 'close' && this._position === null) {
      throw new Error('Portfolio.placePending: close intent while flat');
    }
    if (order.intent === 'add' && this._position === null) {
      throw new Error('Portfolio.placePending: add intent while flat');
    }
    this._pending = order;
  }

  /** Очистить pending (истечение — US5). */
  clearPending(): void {
    this._pending = null;
  }

  /**
   * Истечение pending-ордера при отсутствии следующего бара (FR-020, US5-AC3): `pending → expired`,
   * без сделки и без изменения позиции. Возвращает истёкший ордер (для фиксации статуса) или `null`.
   */
  expirePending(): PendingOrder | null {
    const order = this._pending;
    this._pending = null;
    return order;
  }

  /** Исполнить открывающий fill: `pending(open) → open`. Fee списывается из cash. */
  settleOpen(fill: OpenFill): void {
    const order = this._pending;
    if (order === null || order.intent !== 'open') {
      throw new Error('Portfolio.settleOpen: no open pending');
    }
    this._cash = quantize(new Decimal(this._cash).minus(fill.fee).toNumber());
    this._position = {
      symbol: order.symbol,
      side: order.side,
      size: fill.size,
      entryPrice: fill.fillPrice,
      entryBarIndex: fill.barIndex,
      entryTs: fill.ts,
      entryFee: fill.fee,
      // 024 (US3): protection-уровни из `enter` (после risk-clamp) активируются на входе (R1/R7);
      // отсутствие → ключи опущены → форма позиции/снимка байт-идентична 018.
      ...(order.stop !== undefined ? { stop: order.stop } : {}),
      ...(order.take !== undefined ? { take: order.take } : {}),
    };
    this._closeSeq = 0;
    this._pending = null;
  }

  /**
   * Обновить protection-уровни открытой позиции (024, US3, data-model §2/§4): merge — обновляются
   * только переданные поля (после risk-clamp/normalize). По порядку пер-барового прохода (R7) действует
   * со следующего бара. Прямая мутация `_position` извне запрещена — только через этот chokepoint (FR-015).
   */
  updateProtection(stop?: number, take?: number): void {
    const pos = this._position;
    if (pos === null) throw new Error('Portfolio.updateProtection: no open position');
    this._position = {
      ...pos,
      ...(stop !== undefined ? { stop } : {}),
      ...(take !== undefined ? { take } : {}),
    };
  }

  /**
   * Исполнить доливочный fill (024, data-model §2): `size += fill.size`; `entryPrice` →
   * средневзвешенная `(oldSize·oldEntry + fill.size·fill.fillPrice)/(oldSize+fill.size)`;
   * `entryFee += fill.fee`; `addCount += 1`; `cash -= fill.fee`. Вторая позиция НЕ создаётся.
   * `mode` фиксируется на ордере/evidence (различимость dca/scale_in), на мутацию состояния не влияет.
   */
  settleAdd(fill: OpenFill, _mode: 'dca' | 'scale_in'): void {
    const pos = this._position;
    if (pos === null) throw new Error('Portfolio.settleAdd: no open position');
    const newSize = quantize(new Decimal(pos.size).plus(fill.size).toNumber());
    const newEntry = quantize(
      new Decimal(pos.entryPrice)
        .times(pos.size)
        .plus(new Decimal(fill.fillPrice).times(fill.size))
        .div(newSize)
        .toNumber(),
    );
    this._cash = quantize(new Decimal(this._cash).minus(fill.fee).toNumber());
    this._position = {
      ...pos,
      size: newSize,
      entryPrice: newEntry,
      entryFee: quantize(new Decimal(pos.entryFee).plus(fill.fee).toNumber()),
      addCount: (pos.addCount ?? 0) + 1,
    };
    // Снять исполненный pending (как settleOpen/settleClose) — иначе остаточный pending блокирует
    // последующие lifecycle-решения того же символа (guard `pending===null`).
    this._pending = null;
  }

  /** Исполнить закрывающий fill: `pending(close) → flat`; вернуть закрытую сделку. */
  settleClose(fill: CloseFill, closeReason: CloseReason): Trade {
    const order = this._pending;
    if (order === null || order.intent !== 'close' || this._position === null) {
      throw new Error('Portfolio.settleClose: no close pending/position');
    }
    const trade = this.closePosition(fill, closeReason, 1);
    this._pending = null;
    return trade;
  }

  /**
   * Исполнить частичный закрывающий fill (024, US2, data-model §3): `pending(close) → остаток открыт`.
   * Тонкая обёртка поверх `closePosition` (вся арифметика доли/остатка — там). `closeReason` —
   * strategy-authored причина из `exit`-решения (НЕ `partial_exit`); возвращает partial-`Trade`
   * (`closeKind:'partial'`). `fraction` ∈ (0,1).
   */
  settlePartialClose(fill: CloseFill, fraction: number, closeReason: CloseReason): Trade {
    const order = this._pending;
    if (order === null || order.intent !== 'close' || this._position === null) {
      throw new Error('Portfolio.settlePartialClose: no close pending/position');
    }
    const trade = this.closePosition(fill, closeReason, fraction);
    this._pending = null;
    return trade;
  }

  /**
   * Квантизованный закрываемый размер для доли (024). `fraction ≥ 1` → весь размер; `0<fraction<1` →
   * `quantize(size·fraction)`. Единственный источник истины для закрытого размера — переиспользуется
   * `closePosition` (gross/trade) и оркестратором (fee fill'а), исключая рассинхрон квантизации.
   */
  closedSizeAt(fraction: number): number {
    const pos = this._position;
    if (pos === null) throw new Error('Portfolio.closedSizeAt: no open position');
    return fraction < 1 ? quantize(new Decimal(pos.size).times(fraction).toNumber()) : pos.size;
  }

  /**
   * Ядро закрытия позиции (024, data-model §2/§3/§8) — единственный путь построения `Trade`.
   * Полное при `fraction=1` (позиция → flat); частичное при `0<fraction<1` (остаток остаётся открытым
   * со средней ценой входа). `settleClose`/`forcedMtmClose` (и позже `settlePartialClose`/protection)
   * делегируют ему. Учёт: `closed=quantize(size·fraction)`, `gross` на закрытую долю, `entryFeeClosed=
   * quantize(entryFee·fraction)`, `realizedPnl=gross−entryFeeClosed−fill.fee`, `cash+=gross−fill.fee`;
   * остаток `size−=closed`, `entryFee−=entryFeeClosed`, `entryPrice`/`stop`/`take` без изменений.
   * Ведёт per-position 0-based `closeSeq` и проставляет `Trade.id` по правилу уникальности (§8):
   * единственное полное закрытие (`closeSeq=0`, не partial, не protection) → bare id, **байт-идентичный
   * 018**; иначе суффикс `-c{closeSeq}`. `pending` НЕ трогает (protection закрывает без pending).
   */
  closePosition(fill: CloseFill, closeReason: CloseReason, fraction = 1): Trade {
    const pos = this._position;
    if (pos === null) throw new Error('Portfolio.closePosition: no open position');

    const isPartial = fraction < 1;
    const closedSize = this.closedSizeAt(fraction);
    const entryFeeClosed = isPartial
      ? quantize(new Decimal(pos.entryFee).times(fraction).toNumber())
      : pos.entryFee;
    const gross = this.grossAtSize(pos.side, pos.entryPrice, fill.fillPrice, closedSize);
    this._cash = quantize(new Decimal(this._cash).plus(gross).minus(fill.fee).toNumber());

    const closeSeq = this._closeSeq;
    this._closeSeq = closeSeq + 1;
    const trade = this.buildTrade({
      pos,
      closedSize,
      entryFeeClosed,
      exitBarIndex: fill.barIndex,
      exitTs: fill.ts,
      exitFillPrice: fill.fillPrice,
      exitFee: fill.fee,
      gross,
      closeReason,
      isPartial,
      closeSeq,
    });

    if (isPartial) {
      this._position = {
        ...pos,
        size: quantize(new Decimal(pos.size).minus(closedSize).toNumber()),
        entryFee: quantize(new Decimal(pos.entryFee).minus(entryFeeClosed).toNumber()),
      };
    } else {
      this._position = null;
    }
    return trade;
  }

  /** End-of-data forced MTM: закрыть открытую позицию по `closePrice` без slippage/fee. */
  forcedMtmClose(barIndex: number, ts: number, closePrice: number): Trade | null {
    if (this._position === null) return null;
    return this.closePosition({ fillPrice: closePrice, fee: 0, barIndex, ts }, 'end_of_data', 1);
  }

  private grossAt(pos: OpenPosition, exitPrice: number): number {
    return this.grossAtSize(pos.side, pos.entryPrice, exitPrice, pos.size);
  }

  private grossAtSize(
    side: 'long' | 'short',
    entryPrice: number,
    exitPrice: number,
    size: number,
  ): number {
    const d =
      side === 'long'
        ? new Decimal(exitPrice).minus(entryPrice)
        : new Decimal(entryPrice).minus(exitPrice);
    return quantize(d.times(size).toNumber());
  }

  private buildTrade(p: {
    pos: OpenPosition;
    closedSize: number;
    entryFeeClosed: number;
    exitBarIndex: number;
    exitTs: number;
    exitFillPrice: number;
    exitFee: number;
    gross: number;
    closeReason: CloseReason;
    isPartial: boolean;
    closeSeq: number;
  }): Trade {
    const { pos, closedSize, entryFeeClosed, exitBarIndex, exitTs, exitFillPrice, exitFee, gross } = p;
    const { closeReason, isPartial, closeSeq } = p;
    const feePaid = quantize(new Decimal(entryFeeClosed).plus(exitFee).toNumber());
    const realizedPnl = quantize(new Decimal(gross).minus(entryFeeClosed).minus(exitFee).toNumber());
    // Правило уникальности `Trade.id` (data-model §8): «богатый» путь (partial / protection /
    // closeSeq>0) получает суффикс `-c{closeSeq}`; legacy единственное полное закрытие — bare id.
    const isProtection = closeReason === 'stop_hit' || closeReason === 'take_hit';
    const isRich = isPartial || isProtection || closeSeq > 0;
    const baseId = `trade-${pos.symbol}-${pos.entryBarIndex}-${exitBarIndex}`;
    return {
      id: isRich ? `${baseId}-c${closeSeq}` : baseId,
      symbol: pos.symbol,
      side: pos.side,
      entryBarIndex: pos.entryBarIndex,
      entryTs: pos.entryTs,
      entryFillPrice: pos.entryPrice,
      exitBarIndex,
      exitTs,
      exitFillPrice,
      size: closedSize,
      feePaid,
      realizedPnl,
      closeReason,
      // 024 (data-model §8): опц. ключи опускаются на legacy → байт-идентичность (canonicalJson отбросит undefined).
      ...(isPartial ? { closeKind: 'partial' as const } : {}),
      ...(isRich ? { closeSeq } : {}),
    };
  }
}
