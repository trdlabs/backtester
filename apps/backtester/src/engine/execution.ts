// 018 — симулятор исполнения (data-model §3.2, research R9, FR-019/020/021).
//
// Модель fill по умолчанию — next-bar-open: одобренное на баре `t` решение исполняется по `open(t+1)`.
// Slippage сдвигает цену в неблагоприятную сторону (buy `open·(1+bps/1e4)`, sell `open·(1−bps/1e4)`);
// fee = `notional·bps/1e4`. Вся денежная арифметика — `decimal.js`, квантизация на границе артефакта.
// Истечение при отсутствии next-bar — расширяется в US5.

import { Decimal } from 'decimal.js';

import type { ExecutionProfile } from '@trading/research-contracts/research';
import { quantize } from '../determinism/canonical-json.js';
import { SUPPORTED_FILL_MODEL_KINDS, SUPPORTED_FUNDING_MODEL_KINDS, type FixedBpsModel, type PerMinuteProrateFundingModel } from './profiles.js';

/** Расчёт открывающего fill (next-bar-open): цена, базовый open, slippage bps, fee, размер. */
export interface OpenFillCalc {
  readonly fillPrice: number;
  readonly baseOpen: number;
  readonly slippageBps: number;
  readonly fee: number;
  readonly size: number;
}

/** Расчёт закрывающего fill: цена, базовый open, slippage bps, fee (размер = размер позиции). */
export interface CloseFillCalc {
  readonly fillPrice: number;
  readonly baseOpen: number;
  readonly slippageBps: number;
  readonly fee: number;
}

const BPS_DENOM = 10_000;

function bpsOf(model: object): number {
  return (model as FixedBpsModel).bps;
}

/** Симулятор исполнения по `ExecutionProfile` (фикс. bps fee/slippage, одиночный fill). */
export class ExecutionSimulator {
  private readonly slippageBps: number;
  private readonly feeBps: number;
  private readonly fillKind: string;
  private readonly fundingModel: PerMinuteProrateFundingModel | undefined;

  constructor(private readonly profile: ExecutionProfile) {
    // 024 (US4/R6): защитная сетка — `fillModel.kind` ∈ каталог. Недостижимо после пре-флайт-гейта
    // `runBacktest`; ловит прямое конструирование с неподдержанной моделью (fail-fast, no silent fallback).
    const fillKind = (profile.fillModel as { kind?: unknown }).kind;
    if (typeof fillKind !== 'string' || !(SUPPORTED_FILL_MODEL_KINDS as readonly string[]).includes(fillKind)) {
      throw new Error(`ExecutionSimulator: unsupported fillModel.kind: ${String(fillKind)}`);
    }
    this.fillKind = fillKind;
    // 035 (realism): validate optional fundingModel against the closed catalog (fail-fast, no silent fallback).
    const fm = (profile as { fundingModel?: { kind?: unknown } }).fundingModel;
    if (fm !== undefined) {
      const k = fm.kind;
      if (typeof k !== 'string' || !(SUPPORTED_FUNDING_MODEL_KINDS as readonly string[]).includes(k)) {
        throw new Error(`ExecutionSimulator: unsupported fundingModel.kind: ${String(k)}`);
      }
      this.fundingModel = fm as PerMinuteProrateFundingModel;
    } else {
      this.fundingModel = undefined;
    }
    this.slippageBps = bpsOf(profile.slippageModel);
    this.feeBps = bpsOf(profile.feeModel);
  }

  /** True when fills settle at the decision bar's close (vs deferring to next bar open). */
  settlesSameBar(): boolean {
    return this.fillKind === 'same_bar_close';
  }

  /** True when this profile accrues funding (opt-in: a fundingModel is present). */
  fundingEnabled(): boolean {
    return this.fundingModel !== undefined;
  }

  /** Funding interval (hours) the tape rate is expressed over. Throws if funding is not enabled. */
  fundingIntervalHours(): number {
    if (this.fundingModel === undefined) throw new Error('ExecutionSimulator: funding not enabled');
    return this.fundingModel.intervalHours;
  }

  /** Цена fill с учётом slippage: buy дороже, sell дешевле (неблагоприятно к стороне). */
  private fillPrice(isBuy: boolean, open: number): Decimal {
    const slip = new Decimal(this.slippageBps).div(BPS_DENOM);
    const o = new Decimal(open);
    return isBuy ? o.times(slip.plus(1)) : o.times(new Decimal(1).minus(slip));
  }

  private fee(notional: Decimal): Decimal {
    return notional.times(new Decimal(this.feeBps).div(BPS_DENOM));
  }

  /**
   * Открывающий fill. Сторона позиции `long` → buy, `short` → sell. Sizing из exposure (research R9):
   * `notional = sizingPct · cash`; `size = notional / fillPrice`.
   */
  computeOpenFill(side: 'long' | 'short', open: number, sizingPct: number, cash: number): OpenFillCalc {
    const isBuy = side === 'long';
    const fp = this.fillPrice(isBuy, open);
    const notional = new Decimal(cash).times(sizingPct);
    const size = notional.div(fp);
    return {
      fillPrice: quantize(fp.toNumber()),
      baseOpen: quantize(open),
      slippageBps: this.slippageBps,
      fee: quantize(this.fee(notional).toNumber()),
      size: quantize(size.toNumber()),
    };
  }

  /** Закрывающий fill. Закрытие `long` → sell, `short` → buy; `notional = fillPrice · size`. */
  computeCloseFill(side: 'long' | 'short', open: number, size: number): CloseFillCalc {
    const isBuy = side === 'short';
    const fp = this.fillPrice(isBuy, open);
    const notional = fp.times(size);
    return {
      fillPrice: quantize(fp.toNumber()),
      baseOpen: quantize(open),
      slippageBps: this.slippageBps,
      fee: quantize(this.fee(notional).toNumber()),
    };
  }

  /**
   * Protection-fill (024, US3, R2): тонкая обёртка поверх `computeCloseFill` от gap-aware базовой цены
   * `fillBase` (уровень или open при гэпе, выбран `protection.ts`). slippage в неблагоприятную сторону
   * и fee из `ExecutionProfile` переиспользуются без дублирования (DRY). `baseOpen` несёт `fillBase`.
   */
  computeProtectionFill(side: 'long' | 'short', fillBase: number, size: number): CloseFillCalc {
    return this.computeCloseFill(side, fillBase, size);
  }
}
