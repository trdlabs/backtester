// 018 — метрики над equity curve и закрытыми сделками (data-model §6, FR-023). MVP-набор:
// `pnl`/`max_drawdown`/`win_rate`/`sharpe`; расширен в 038: `total_trades`/`profit_factor`/
// `top_trade_contribution_pct`. Вычисляются ТОЛЬКО запрошенные имена (request-gated), результат
// квантован через `quantize`. Comparison deltas — omit-safe (FR-006).

import type {
  BacktestRunResult,
  ComparisonSummary,
  DecisionRecord,
  EquityPoint,
  MetricDelta,
  OverlayEffectsSummary,
  Trade,
} from './artifacts.js';
import { quantize } from '../determinism/canonical-json.js';

/** Начальный капитал прогона (константа, data-model §6). */
export const INITIAL_EQUITY = 10_000;

/** `pnl = equity[last] − equity[0]`; 0 при пустой кривой. */
function pnl(equity: readonly EquityPoint[]): number {
  if (equity.length === 0) return 0;
  return quantize(equity[equity.length - 1].equity - equity[0].equity);
}

/** `max_drawdown = max_t (peak_{≤t} − equity_t) / peak_{≤t}` — неотрицательная доля; 0 при росте. */
function maxDrawdown(equity: readonly EquityPoint[]): number {
  let peak = -Infinity;
  let maxDd = 0;
  for (const point of equity) {
    if (point.equity > peak) peak = point.equity;
    if (peak > 0) {
      const dd = (peak - point.equity) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return quantize(maxDd);
}

/** `win_rate = winningClosedTrades / closedTrades` ∈ [0,1]; 0 при 0 сделок. */
function winRate(trades: readonly Trade[]): number {
  if (trades.length === 0) return 0;
  const wins = trades.filter((t) => t.realizedPnl > 0).length;
  return quantize(wins / trades.length);
}

/** `total_trades = число закрытых сделок` (счёт, целое неотрицательное). */
function totalTrades(trades: readonly Trade[]): number {
  return quantize(trades.length);
}

/**
 * `profit_factor = grossProfit / absGrossLoss` (безразмерное отношение, ≥0).
 * `grossProfit = Σ realizedPnl` по сделкам с `realizedPnl > 0`.
 * `absGrossLoss = |Σ realizedPnl|` по сделкам с `realizedPnl < 0`.
 * Возвращает `null` при `absGrossLoss === 0` (math undefined / +∞ → fail-closed, FR-002).
 */
function profitFactor(trades: readonly Trade[]): number | null {
  let grossProfit = 0;
  let absGrossLoss = 0;
  for (const t of trades) {
    if (t.realizedPnl > 0) grossProfit += t.realizedPnl;
    else if (t.realizedPnl < 0) absGrossLoss += Math.abs(t.realizedPnl);
  }
  if (absGrossLoss === 0) return null;
  return quantize(grossProfit / absGrossLoss);
}

/**
 * `top_trade_contribution_pct = max(realizedPnl среди прибыльных) / grossProfit × 100` (процент 0..100).
 * При `grossProfit === 0` возвращает `0` — documented convention для «нет прибыльных сделок» (FR-003).
 */
function topTradeContributionPct(trades: readonly Trade[]): number {
  let grossProfit = 0;
  let maxWinner = 0;
  for (const t of trades) {
    if (t.realizedPnl > 0) {
      grossProfit += t.realizedPnl;
      if (t.realizedPnl > maxWinner) maxWinner = t.realizedPnl;
    }
  }
  if (grossProfit === 0) return 0;
  return quantize((maxWinner / grossProfit) * 100);
}

/** `sharpe = mean(r) / std_pop(r)` по per-bar доходностям; 0 при `std=0` или `<2` точек. */
function sharpe(equity: readonly EquityPoint[]): number {
  if (equity.length < 2) return 0;
  const returns: number[] = [];
  for (let i = 1; i < equity.length; i += 1) {
    const prev = equity[i - 1].equity;
    if (prev === 0) return 0;
    returns.push(equity[i].equity / prev - 1);
  }
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length;
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return quantize(mean / std);
}

/** Вычислить запрошенные метрики (имена вне MVP-набора игнорируются — robustness обрабатывается отдельно). */
export function computeMetrics(
  requested: readonly string[],
  equity: readonly EquityPoint[],
  trades: readonly Trade[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of requested) {
    switch (name) {
      case 'pnl':
        out.pnl = pnl(equity);
        break;
      case 'max_drawdown':
        out.max_drawdown = maxDrawdown(equity);
        break;
      case 'win_rate':
        out.win_rate = winRate(trades);
        break;
      case 'sharpe':
        out.sharpe = sharpe(equity);
        break;
      case 'total_trades':
        out.total_trades = totalTrades(trades);
        break;
      case 'profit_factor': {
        const pf = profitFactor(trades);
        if (pf !== null) out.profit_factor = pf;
        break;
      }
      case 'top_trade_contribution_pct':
        out.top_trade_contribution_pct = topTradeContributionPct(trades);
        break;
      default:
        break;
    }
  }
  return out;
}

/** Исход сделки изменился: разное число сделок или различие `(closeReason, exitBarIndex, realizedPnl)`. */
function tradeOutcomeChanged(baseline: readonly Trade[], variant: readonly Trade[]): boolean {
  if (baseline.length !== variant.length) return true;
  for (let i = 0; i < baseline.length; i += 1) {
    const a = baseline[i];
    const b = variant[i];
    if (a.closeReason !== b.closeReason || a.exitBarIndex !== b.exitBarIndex || a.realizedPnl !== b.realizedPnl) {
      return true;
    }
  }
  return false;
}

/** Сводка эффектов overlay'ев по всем decision-records таргета. */
function summariseOverlayEffects(records: readonly DecisionRecord[]): OverlayEffectsSummary {
  const summary = { pass: 0, annotate: 0, patch: 0, veto: 0 };
  for (const record of records) {
    for (const effect of record.overlayEffects) {
      summary[effect.effect] += 1;
    }
  }
  return summary;
}

/**
 * Сравнить variant с baseline (data-model §4.10). `delta = variant − baseline`. Пустой diff
 * (overlay'и ничего не изменили) → нулевые дельты + `tradeOutcomeChanged:false` (валидный результат).
 */
export function computeComparison(baseline: BacktestRunResult, variant: BacktestRunResult): ComparisonSummary {
  const metricDeltas: Record<string, MetricDelta> = {};
  for (const name of Object.keys(baseline.metrics)) {
    // FR-006: сравниваются только метрики, присутствующие у ОБЕИХ сторон.
    // Односторонний omit (напр. profit_factor при absGrossLoss==0) не даёт ложную дельту.
    if (!(name in variant.metrics)) continue;
    const b = baseline.metrics[name];
    const v = variant.metrics[name];
    metricDeltas[name] = { baseline: b, variant: v, delta: quantize(v - b) };
  }

  return {
    baselineRunId: baseline.runId,
    variants: [
      {
        runId: variant.runId,
        overlayRefs: variant.summary.overlayRefs,
        metricDeltas,
        tradeOutcomeChanged: tradeOutcomeChanged(baseline.trades, variant.trades),
        overlayEffectsSummary: summariseOverlayEffects(variant.decisionRecords),
      },
    ],
  };
}
