// 018 — метрики над equity curve и закрытыми сделками (data-model §6, FR-023). MVP-набор:
// `pnl`/`max_drawdown`/`win_rate`/`sharpe`; расширен в 038: `total_trades`/`profit_factor`/
// `top_trade_contribution_pct`; расширен в E1a: `sortino`/`expectancy`/`sqn`/`cagr`/`calmar` +
// сырьё для DSR (E2) `returns_stddev`/`returns_skew`/`returns_kurtosis`/`returns_count`.
// Вычисляются ТОЛЬКО запрошенные имена (request-gated), результат квантован через `quantize`.
// Comparison deltas — omit-safe (FR-006).

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

/**
 * E1a: метрики, добавленные ПОВЕРХ внешнего kernel-каталога (@trdlabs/sdk/research-contract).
 * Локальное расширение overlay/strategy-словаря: engine их вычисляет (`computeMetrics`), submit-гейт
 * принимает (`VALID_OVERLAY_METRICS`), registry рекламирует (`overlayMetricCatalog`). Каталог kernel
 * не трогаем — продвижение имён в него отдельный cross-repo шаг.
 */
export const E1A_METRIC_CATALOG = [
  'sortino',
  'expectancy',
  'sqn',
  'cagr',
  'calmar',
  'returns_stddev',
  'returns_skew',
  'returns_kurtosis',
  'returns_count',
] as const;

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

/**
 * Статистики ряда per-bar доходностей `r_i = equity[i]/equity[i-1] − 1`, посчитанные ОДИН раз и
 * ОДНИМ правилом — единый источник для sharpe / sortino / returns_stddev / returns_skew /
 * returns_kurtosis / returns_count (E1a). `mean`/`std` популяционные, как в прежнем `sharpe`.
 * Fail-closed: `equity.length<2` или `prev===0` где-либо ⇒ ряд невалиден (`count 0`, моменты 0),
 * что воспроизводит прежний короткий замыкатель `sharpe` (байт-идентичность golden `result_hash`).
 * `count<2` (ровно одна доходность) ⇒ моменты 0, но `count` отражает реально построенный ряд.
 */
interface ReturnsStats {
  readonly count: number;
  readonly mean: number;
  readonly std: number;
  readonly m3: number; // Σ(r−mean)³ / count
  readonly m4: number; // Σ(r−mean)⁴ / count
  readonly downsideStd: number; // sqrt(mean(min(r,0)²))
}

function computeReturnsStats(equity: readonly EquityPoint[]): ReturnsStats {
  const INVALID: ReturnsStats = { count: 0, mean: 0, std: 0, m3: 0, m4: 0, downsideStd: 0 };
  if (equity.length < 2) return INVALID;
  const returns: number[] = [];
  for (let i = 1; i < equity.length; i += 1) {
    const prev = equity[i - 1].equity;
    if (prev === 0) return INVALID;
    returns.push(equity[i].equity / prev - 1);
  }
  const count = returns.length;
  if (count < 2) return { ...INVALID, count };
  // mean/variance — тем же порядком reduce и делителем, что прежний sharpe → sharpe байт-идентичен.
  const mean = returns.reduce((a, b) => a + b, 0) / count;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / count;
  const std = Math.sqrt(variance);
  const m3 = returns.reduce((a, r) => a + (r - mean) ** 3, 0) / count;
  const m4 = returns.reduce((a, r) => a + (r - mean) ** 4, 0) / count;
  const downsideVar = returns.reduce((a, r) => (r < 0 ? a + r * r : a), 0) / count;
  return { count, mean, std, m3, m4, downsideStd: Math.sqrt(downsideVar) };
}

/** `sharpe = mean(r) / std_pop(r)` по per-bar доходностям; 0 при `std=0` или `<2` точек. */
function sharpe(equity: readonly EquityPoint[]): number {
  const s = computeReturnsStats(equity);
  if (s.count < 2 || s.std === 0) return 0;
  return quantize(s.mean / s.std);
}

/** `sortino = mean(r) / downsideStd(r)`; downside deviation ОТНОСИТЕЛЬНО 0 (не MAR/target); 0 при downsideStd=0/<2. */
function sortino(equity: readonly EquityPoint[]): number {
  const s = computeReturnsStats(equity);
  if (s.count < 2 || s.downsideStd === 0) return 0;
  return quantize(s.mean / s.downsideStd);
}

/** Популяционный std ряда доходностей; 0 при <2 точек. */
function returnsStddev(equity: readonly EquityPoint[]): number {
  const s = computeReturnsStats(equity);
  return s.count < 2 ? 0 : quantize(s.std);
}

/** Асимметрия `(Σ(r−μ)³/count) / std³`; 0 при std=0 или <2 точек. */
function returnsSkew(equity: readonly EquityPoint[]): number {
  const s = computeReturnsStats(equity);
  if (s.count < 2 || s.std === 0) return 0;
  return quantize(s.m3 / s.std ** 3);
}

/** Пирсоновский эксцесс `(Σ(r−μ)⁴/count) / std⁴` (НЕ excess; нормальное распределение = 3.0); 0 при std=0/<2. */
function returnsKurtosis(equity: readonly EquityPoint[]): number {
  const s = computeReturnsStats(equity);
  if (s.count < 2 || s.std === 0) return 0;
  return quantize(s.m4 / s.std ** 4);
}

/** Длина реально построенного ряда доходностей (это `T`, длина выборки для DSR в E2). */
function returnsCount(equity: readonly EquityPoint[]): number {
  return quantize(computeReturnsStats(equity).count);
}

/**
 * E2: узкий helper — DSR-входы (sharpe + Пирсоновские skew/kurtosis + T) напрямую из equity curve,
 * НЕЗАВИСИМО от `request.metrics` (реестру они нужны всегда). Переиспользует `computeReturnsStats`
 * (единое правило с метриками). `null` при вырожденном ряде (`count<2` или `std=0`).
 */
export function dsrInputsFromEquity(
  equity: readonly EquityPoint[],
): { sharpe: number; skew: number; kurtosis: number; tCount: number } | null {
  const s = computeReturnsStats(equity);
  if (s.count < 2 || s.std === 0) return null;
  return {
    sharpe: quantize(s.mean / s.std),
    skew: quantize(s.m3 / s.std ** 3),
    kurtosis: quantize(s.m4 / s.std ** 4),
    tCount: s.count,
  };
}

/** `expectancy = mean(realizedPnl)` по закрытым сделкам (абсолютная валюта, как `pnl`); 0 при 0 сделок. */
function expectancy(trades: readonly Trade[]): number {
  if (trades.length === 0) return 0;
  const sum = trades.reduce((a, t) => a + t.realizedPnl, 0);
  return quantize(sum / trades.length);
}

/** `sqn = mean(pnl)/std_pop(pnl) · √N` по сделкам; 0 при <2 сделок или std=0. */
function sqn(trades: readonly Trade[]): number {
  const n = trades.length;
  if (n < 2) return 0;
  const mean = trades.reduce((a, t) => a + t.realizedPnl, 0) / n;
  const variance = trades.reduce((a, t) => a + (t.realizedPnl - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return quantize((mean / std) * Math.sqrt(n));
}

/**
 * `cagr = (eq_last/eq_first)^(1/years) − 1`, `years = context.elapsedYears` (календарное время из
 * `request.period`). Возвращает `null` (⇒ omit ключа, как `profit_factor`) при отсутствии времени
 * или неположительном капитале: значение не определено, а не «0».
 */
function cagr(equity: readonly EquityPoint[], elapsedYears: number | null): number | null {
  if (elapsedYears === null || elapsedYears <= 0) return null;
  if (equity.length === 0) return null;
  const first = equity[0].equity;
  const last = equity[equity.length - 1].equity;
  if (first <= 0 || last <= 0) return null;
  return quantize((last / first) ** (1 / elapsedYears) - 1);
}

/** `calmar = cagr / max_drawdown`; `null` (⇒ omit) при неопределённом cagr или нулевом drawdown. */
function calmar(equity: readonly EquityPoint[], elapsedYears: number | null): number | null {
  const c = cagr(equity, elapsedYears);
  if (c === null) return null;
  const mdd = maxDrawdown(equity);
  if (mdd === 0) return null;
  return quantize(c / mdd);
}

/** Контекст вычисления метрик — расширяемый seam (timeframe/periodsPerYear добавятся сюда позже). */
export interface MetricsContext {
  /** Календарная длительность прогона в годах (из `request.period`); `null` ⇒ cagr/calmar опускаются. */
  readonly elapsedYears: number | null;
}

/** Вычислить запрошенные метрики (имена вне MVP-набора игнорируются — robustness обрабатывается отдельно). */
export function computeMetrics(
  requested: readonly string[],
  equity: readonly EquityPoint[],
  trades: readonly Trade[],
  context: MetricsContext,
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
      case 'sortino':
        out.sortino = sortino(equity);
        break;
      case 'expectancy':
        out.expectancy = expectancy(trades);
        break;
      case 'sqn':
        out.sqn = sqn(trades);
        break;
      case 'cagr': {
        const v = cagr(equity, context.elapsedYears);
        if (v !== null) out.cagr = v;
        break;
      }
      case 'calmar': {
        const v = calmar(equity, context.elapsedYears);
        if (v !== null) out.calmar = v;
        break;
      }
      case 'returns_stddev':
        out.returns_stddev = returnsStddev(equity);
        break;
      case 'returns_skew':
        out.returns_skew = returnsSkew(equity);
        break;
      case 'returns_kurtosis':
        out.returns_kurtosis = returnsKurtosis(equity);
        break;
      case 'returns_count':
        out.returns_count = returnsCount(equity);
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
