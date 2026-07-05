// 018 — risk-движок: единственный hard-authority слой перед исполнением (data-model §3.1, research
// R9, FR-016/017/018). accept/clamp/reject каждого решения по `RiskProfile` (portfolio-wide).

import type { AddToPositionDecision, StrategyDecision } from '@trading/research-contracts/research';
import type { Bounds, RiskProfile } from '@trading/research-contracts/research';
import type { RiskClamp, RiskDecision } from './artifacts.js';
import type { AddLimits, ExposureLimits } from './profiles.js';

/**
 * Исход risk-оценки. `accept`/`clamp` → решение исполняется (clamp фиксирует зажатые hint'ы);
 * `reject` → ордер НЕ создаётся (data-model §3.1).
 */
export type RiskOutcome =
  | {
      readonly action: 'accept' | 'clamp';
      readonly decision: StrategyDecision;
      /** Доля equity для sizing (`enter` и `add_to_position`). */
      readonly sizingPct?: number;
      /** Режим доливки (только `add_to_position`); переносится в evidence-ордер (024, R4). */
      readonly mode?: 'dca' | 'scale_in';
      /** Нормализованная доля частичного выхода 0<p<1 (только `exit`, 024, R3); undefined → полный выход. */
      readonly closeFraction?: number;
      /** Нормализованные (после clamp к `*Bounds`) protection-дистанции для `enter`/`update_protection` (024, US3). */
      readonly stop?: number;
      readonly take?: number;
      readonly record: RiskDecision;
    }
  | { readonly action: 'reject'; readonly record: RiskDecision };

/**
 * Контекст открытой позиции для применения add-лимитов (024, R4). equity-базис — cash-прокси
 * `portfolio.cash` (как `computeOpenFill`), НЕ marked-to-market equity.
 */
export interface AddPositionContext {
  readonly size: number;
  readonly entryPrice: number;
  readonly addCount: number;
  readonly cash: number;
}

function clampToBounds(value: number, bounds: Bounds): number {
  return Math.min(Math.max(value, bounds.min), bounds.max);
}

/** Risk-движок portfolio-wide (FR-016). */
export class RiskEngine {
  constructor(private readonly profile: RiskProfile) {}

  private get maxNotionalPct(): number {
    return (this.profile.exposureLimits as ExposureLimits).maxPositionNotionalPct;
  }

  /** Нормализовать одну дистанцию stop/take к границам профиля (024, US3); undefined → undefined. */
  private normHint(value: number | undefined, bounds?: Bounds): number | undefined {
    if (value === undefined) return undefined;
    return bounds !== undefined ? clampToBounds(value, bounds) : value;
  }

  /** Собрать clamp'ы по hint'ам `stop`/`take` относительно границ профиля. */
  private clampHints(decision: { stop?: number; take?: number }): RiskClamp[] {
    const clamps: RiskClamp[] = [];
    if (decision.stop !== undefined && this.profile.stopBounds !== undefined) {
      const to = clampToBounds(decision.stop, this.profile.stopBounds);
      if (to !== decision.stop) clamps.push({ field: 'stop', from: decision.stop, to });
    }
    if (decision.take !== undefined && this.profile.takeBounds !== undefined) {
      const to = clampToBounds(decision.take, this.profile.takeBounds);
      if (to !== decision.take) clamps.push({ field: 'take', from: decision.take, to });
    }
    return clamps;
  }

  /**
   * Оценить решение. `enter`: сторона ∉ `allowedSides` → reject; `openPositions ≥
   * maxConcurrentPositions` (portfolio-wide) → reject; иначе accept + sizing, с clamp out-of-bounds
   * hint'ов. `exit`/закрытие → всегда accept. Прочие kind'ы до risk не доходят (защитный accept).
   */
  evaluate(
    decision: StrategyDecision,
    barIndex: number,
    openPositions: number,
    posCtx?: AddPositionContext,
  ): RiskOutcome {
    if (decision.kind === 'add_to_position') {
      return this.evaluateAdd(decision, barIndex, openPositions, posCtx);
    }
    if (decision.kind === 'enter') {
      if (!this.profile.allowedSides.includes(decision.side)) {
        return {
          action: 'reject',
          record: { barIndex, decisionKind: 'enter', action: 'reject', reason: `side_not_allowed:${decision.side}` },
        };
      }
      if (openPositions >= this.profile.maxConcurrentPositions) {
        return {
          action: 'reject',
          record: { barIndex, decisionKind: 'enter', action: 'reject', reason: 'max_concurrent_positions' },
        };
      }
      const clamps = this.clampHints(decision);
      // 024 (US3): нормализованные protection-дистанции из `enter` (после clamp) → активируются на входе.
      const stop = this.normHint(decision.stop, this.profile.stopBounds);
      const take = this.normHint(decision.take, this.profile.takeBounds);
      const prot = { ...(stop !== undefined ? { stop } : {}), ...(take !== undefined ? { take } : {}) };
      if (clamps.length > 0) {
        return {
          action: 'clamp',
          decision,
          sizingPct: this.maxNotionalPct,
          ...prot,
          record: { barIndex, decisionKind: 'enter', action: 'clamp', reason: 'hints_clamped', clamped: clamps },
        };
      }
      return {
        action: 'accept',
        decision,
        sizingPct: this.maxNotionalPct,
        ...prot,
        record: { barIndex, decisionKind: 'enter', action: 'accept', reason: 'within_risk_profile' },
      };
    }
    if (decision.kind === 'exit') {
      // Нормализация `exit.percent` (R3) — единственный accept/clamp/reject authority.
      const p = decision.percent;
      if (p === undefined) {
        // Полный выход — байт-идентично 018.
        return {
          action: 'accept',
          decision,
          record: { barIndex, decisionKind: 'exit', action: 'accept', reason: 'exit_always_allowed' },
        };
      }
      if (!Number.isFinite(p) || p <= 0) {
        return {
          action: 'reject',
          record: { barIndex, decisionKind: 'exit', action: 'reject', reason: 'invalid_exit_percent' },
        };
      }
      if (p >= 100) {
        // `≥100` → clamp к полному выходу (эквивалент полного закрытия, FR-005).
        return {
          action: 'clamp',
          decision,
          record: {
            barIndex,
            decisionKind: 'exit',
            action: 'clamp',
            reason: 'exit_percent_clamped',
            clamped: [{ field: 'percent', from: p, to: 100 }],
          },
        };
      }
      // `0<p<100` → частичный выход доли `p/100`.
      return {
        action: 'accept',
        decision,
        closeFraction: p / 100,
        record: { barIndex, decisionKind: 'exit', action: 'accept', reason: 'exit_partial_allowed' },
      };
    }
    if (decision.kind === 'update_protection') {
      // 024 (US3): clamp stop/take к `*Bounds` (переиспользует `clampHints`); flat → reject.
      if (openPositions === 0) {
        return {
          action: 'reject',
          record: { barIndex, decisionKind: 'update_protection', action: 'reject', reason: 'update_without_position' },
        };
      }
      const clamps = this.clampHints(decision);
      const stop = this.normHint(decision.stop, this.profile.stopBounds);
      const take = this.normHint(decision.take, this.profile.takeBounds);
      const prot = { ...(stop !== undefined ? { stop } : {}), ...(take !== undefined ? { take } : {}) };
      const action = clamps.length > 0 ? 'clamp' : 'accept';
      return {
        action,
        decision,
        ...prot,
        record: {
          barIndex,
          decisionKind: 'update_protection',
          action,
          reason: clamps.length > 0 ? 'hints_clamped' : 'protection_updated',
          ...(clamps.length > 0 ? { clamped: clamps } : {}),
        },
      };
    }
    return {
      action: 'accept',
      decision,
      record: { barIndex, decisionKind: decision.kind, action: 'accept', reason: 'no_op' },
    };
  }

  /**
   * Применение add-лимитов (R4, data-model §7). По `mode` выбирается `dcaLimits`/`scaleInLimits`:
   * отсутствие → reject `{dca,scale_in}_not_permitted`; `maxAdds` исчерпан/нулевой допустимый прирост →
   * reject `{dca,scale_in}_limit_exceeded`; нотионал сверх `maxAddNotionalPct`/`maxTotalNotionalPct` →
   * clamp `add_notional_clamped`. equity-базис — cash-прокси (R4). При flat → reject `add_without_position`.
   */
  private evaluateAdd(
    decision: AddToPositionDecision,
    barIndex: number,
    openPositions: number,
    posCtx?: AddPositionContext,
  ): RiskOutcome {
    const mode = decision.mode;
    const reject = (reason: string): RiskOutcome => ({
      action: 'reject',
      record: { barIndex, decisionKind: 'add_to_position', action: 'reject', reason },
    });

    if (openPositions === 0 || posCtx === undefined) return reject('add_without_position');

    const limits = (mode === 'dca' ? this.profile.dcaLimits : this.profile.scaleInLimits) as
      | AddLimits
      | undefined;
    if (limits === undefined) {
      return reject(mode === 'dca' ? 'dca_not_permitted' : 'scale_in_not_permitted');
    }
    const limitExceeded = mode === 'dca' ? 'dca_limit_exceeded' : 'scale_in_limit_exceeded';
    if (posCtx.addCount >= limits.maxAdds) return reject(limitExceeded);

    // Sizing-clamp нотионала к одиночному и кумулятивному потолкам (доля cash-прокси).
    const requestedPct = decision.sizingHint ?? limits.maxAddNotionalPct;
    const currentPct = posCtx.cash > 0 ? (posCtx.size * posCtx.entryPrice) / posCtx.cash : Infinity;
    const totalRemainingPct = Math.max(0, limits.maxTotalNotionalPct - currentPct);
    const allowedPct = Math.min(requestedPct, limits.maxAddNotionalPct, totalRemainingPct);
    if (allowedPct <= 0) return reject(limitExceeded);

    if (allowedPct < requestedPct) {
      return {
        action: 'clamp',
        decision,
        mode,
        sizingPct: allowedPct,
        record: {
          barIndex,
          decisionKind: 'add_to_position',
          action: 'clamp',
          reason: 'add_notional_clamped',
          clamped: [{ field: 'addNotionalPct', from: requestedPct, to: allowedPct }],
        },
      };
    }
    return {
      action: 'accept',
      decision,
      mode,
      sizingPct: allowedPct,
      record: { barIndex, decisionKind: 'add_to_position', action: 'accept', reason: 'add_within_limits' },
    };
  }
}
