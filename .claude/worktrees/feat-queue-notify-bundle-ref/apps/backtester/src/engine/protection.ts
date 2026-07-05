// 024 — US3: чистый runner-owned детектор protection-триггера (research R0/R2/R7).
//
// Protection — НЕ alpha: это intrabar hard-guard поверх уже принятых risk'ом уровней. stop/take —
// дробные ДИСТАНЦИИ от средней цены входа (R0); уровни срабатывания пересчитываются от текущего `E`.
// Детекция intrabar по `high`/`low` (FR-019); stop-first при одновременной достижимости (FR-020);
// выбор `fillBase` по правилу gap-through (R2). Никакого slippage/fee здесь — это делает
// `ExecutionSimulator.computeProtectionFill` (DRY). Чистая функция: без побочных эффектов и состояния.

import { Decimal } from 'decimal.js';

import { quantize } from '../determinism/canonical-json.js';

/** Уровни срабатывания protection (квантизованные цены), пересчитанные от средней цены входа. */
export interface ProtectionLevels {
  readonly stopLevel?: number;
  readonly takeLevel?: number;
}

/** Результат детекции: тип срабатывания + базовая цена fill (до slippage/fee). */
export interface ProtectionHit {
  readonly kind: 'stop_hit' | 'take_hit';
  readonly fillBase: number;
}

/**
 * Уровни protection из средней цены входа и дробных дистанций (R0):
 * long `stopLevel=E·(1−stop)`, `takeLevel=E·(1+take)`; short зеркально (`E·(1+stop)`, `E·(1−take)`).
 */
export function protectionLevels(
  side: 'long' | 'short',
  entryPrice: number,
  stop?: number,
  take?: number,
): ProtectionLevels {
  const E = new Decimal(entryPrice);
  const stopLevel =
    stop === undefined
      ? undefined
      : quantize((side === 'long' ? E.times(new Decimal(1).minus(stop)) : E.times(new Decimal(1).plus(stop))).toNumber());
  const takeLevel =
    take === undefined
      ? undefined
      : quantize((side === 'long' ? E.times(new Decimal(1).plus(take)) : E.times(new Decimal(1).minus(take))).toNumber());
  return {
    ...(stopLevel !== undefined ? { stopLevel } : {}),
    ...(takeLevel !== undefined ? { takeLevel } : {}),
  };
}

/**
 * Детектировать protection-триггер на баре `t` (R2). Возвращает `null`, если protection не установлен
 * или ни один уровень не достигнут. **stop-first** (FR-020): при достижимости обоих уровней в
 * `[low, high]` возвращается `stop_hit`. `fillBase` — по правилу gap-through (R2): `open`, если бар
 * открылся уже за уровнем в сторону срабатывания (рынок «проскочил»), иначе ровно уровень.
 */
export function detectProtection(
  side: 'long' | 'short',
  entryPrice: number,
  stop: number | undefined,
  take: number | undefined,
  bar: { readonly open: number; readonly high: number; readonly low: number },
): ProtectionHit | null {
  if (stop === undefined && take === undefined) return null;
  const { stopLevel, takeLevel } = protectionLevels(side, entryPrice, stop, take);
  const { open, high, low } = bar;

  // stop-first: проверяется раньше take.
  if (stopLevel !== undefined) {
    const triggered = side === 'long' ? low <= stopLevel : high >= stopLevel;
    if (triggered) {
      const gap = side === 'long' ? open <= stopLevel : open >= stopLevel;
      return { kind: 'stop_hit', fillBase: gap ? open : stopLevel };
    }
  }
  if (takeLevel !== undefined) {
    const triggered = side === 'long' ? high >= takeLevel : low <= takeLevel;
    if (triggered) {
      const gap = side === 'long' ? open >= takeLevel : open <= takeLevel;
      return { kind: 'take_hit', fillBase: gap ? open : takeLevel };
    }
  }
  return null;
}
