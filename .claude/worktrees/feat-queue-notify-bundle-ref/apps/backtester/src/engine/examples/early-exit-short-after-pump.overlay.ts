// 018 — worked-overlay для baseline `short_after_pump` (research R7/R12, US2 SC-002). Перехват в
// РОВНО ОДНОЙ точке `post_entry_management` (= `onPositionBar`). У baseline нет `onPositionBar` →
// базовое решение = синтетический `idle`; при подтверждённом неблагоприятном дрейфе для short (цена
// ВЫШЕ входа N баров) overlay возвращает `patch` `idle → exit` → ранний выход. Sizing/exposure НЕ
// несёт (разделение ответственности, FR-015). Существующий `early-exit-long-oi.overlay.ts` не трогаем.

import {
  CONTRACT_VERSION,
  type StrategyContext,
  type OverlayDecision,
  type HypothesisOverlayModule,
} from '@trading/research-contracts/research';

const paramsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['maxAdverseBars'],
  properties: {
    maxAdverseBars: { type: 'number' },
  },
};

export const earlyExitShortAfterPump: HypothesisOverlayModule = {
  manifest: {
    id: 'early_exit_short_after_pump',
    version: '0.1.0',
    kind: 'overlay',
    name: 'Early exit for short_after_pump',
    summary: 'Ранний выход из short-позиции при затяжном неблагоприятном движении (цена выше входа)',
    rationale: 'Если после входа в шорт цена N баров держится выше входа — тезис не подтверждён, выходим раньше.',
    author: 'agent',
    contractVersion: CONTRACT_VERSION,
    status: 'research_only',
    paramsSchema,
    params: { maxAdverseBars: 3 },
    capabilities: { platformSdk: true },
    dataNeeds: { closedCandlesUpToCurrent: true },
    hooks: ['apply'],
    targetStrategyRef: 'short_after_pump',
    interceptionPoint: 'post_entry_management',
  },

  apply(ctx: StrategyContext): OverlayDecision {
    const maxAdverseBars = Number(ctx.params.maxAdverseBars ?? 3);
    const position = ctx.position;
    if (position === null) return { kind: 'pass' };

    // 020: волатильность через платформенный ctx.indicators (НЕ vendor-библиотека).
    const atr = ctx.indicators.query({ name: 'atr', params: { period: 14 } });
    const rsi = ctx.indicators.query({ name: 'rsi', params: { period: 14 } });

    const history = ctx.data.closedCandles(maxAdverseBars);
    if (history.length < maxAdverseBars) return { kind: 'pass' };

    // Неблагоприятно для SHORT = цена держится ВЫШЕ входа все N баров.
    const adverse = history.every((bar) => bar.close > position.entryPrice);
    if (adverse) {
      return {
        kind: 'patch',
        patch: { kind: 'exit', target: 'overlay_early_exit', reason: 'early_exit_adverse_drift' },
      };
    }
    const ind: string[] = [];
    if (typeof rsi === 'number') ind.push(`RSI=${rsi.toFixed(1)}`);
    if (typeof atr === 'number') ind.push(`ATR=${atr.toFixed(4)}`);
    const suffix = ind.length > 0 ? ` (${ind.join(', ')})` : '';
    return { kind: 'annotate', notes: `held: ${maxAdverseBars}-bar adverse drift not confirmed${suffix}` };
  },
};

/** Валидные sample-решения overlay-примера (author-supplied проверка decision-схемы). */
export const earlyExitShortAfterPumpSamples: readonly OverlayDecision[] = [
  { kind: 'pass' },
  { kind: 'annotate', notes: 'held' },
  { kind: 'patch', patch: { kind: 'exit', target: 'overlay_early_exit', reason: 'early_exit_adverse_drift' } },
];
