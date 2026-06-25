// 018 — формы run-артефактов (data-model §4, research R2). ТОЛЬКО типы (read-only).
//
// Контракт 017 оставил поля `BacktestRunResult` как `readonly object[]` (017 data-model §12);
// конкретные наполненные формы — runner-owned деталь, определяются ЗДЕСЬ, а не в контракте
// (additive, surgical — 017 не модифицируется). 018-форма `BacktestRunResult` структурно
// удовлетворяет 017-интерфейсу (проверяется type-level guard'ом ниже).

import type {
  LifecycleHook,
  HypothesisOverlayModule,
  ModuleManifest,
  StrategyModule,
} from '@trading/research-contracts/research';
import type { StrategyDecision } from '@trading/research-contracts/research';
import type { CoverageModel } from '@trading/research-contracts/research';
import type { BacktestRunResult as ContractBacktestRunResult, Ref } from '@trading/research-contracts/research';
import type { ValidationIssue, ValidationResult } from '@trading/research-contracts/research';

// --- Решения и эффекты (data-model §4.1–4.3) ---

/** Один эффект overlay в точке перехвата (§4.2, FR-015). */
export interface OverlayEffect {
  readonly overlayRef: Ref;
  readonly effect: 'pass' | 'annotate' | 'patch' | 'veto';
  /** patch-содержимое | annotation | `{ reasonCode }` для veto. */
  readonly detail: object;
}

/** Зажатое поле hint'а при clamp (§4.3). */
export interface RiskClamp {
  readonly field: string;
  readonly from: number;
  readonly to: number;
}

/** Решение risk-движка по одному (в т.ч. patched) решению (§4.3, FR-017). */
export interface RiskDecision {
  readonly barIndex: number;
  readonly decisionKind: string;
  readonly action: 'accept' | 'clamp' | 'reject';
  readonly reason: string;
  readonly clamped?: readonly RiskClamp[];
}

/** Запись решения по одному хуку на одном баре (§4.1, FR-022). */
export interface DecisionRecord {
  readonly barIndex: number;
  readonly barTs: number;
  readonly symbol: string;
  readonly hook: LifecycleHook;
  /** Решение модуля (или синтетический `{kind:'idle'}` по умолчанию). */
  readonly baseDecision: StrategyDecision;
  /** Эффекты overlay'ев по порядку применения. */
  readonly overlayEffects: readonly OverlayEffect[];
  /** Решение после композиции; `null` при veto/aborted. */
  readonly finalDecision: StrategyDecision | null;
  /** `null`, если решение не дошло до risk (idle/veto). */
  readonly riskDecision: RiskDecision | null;
}

// --- Ордера, fill'ы, сделки, equity (data-model §4.4–4.7) ---

/** Симулированный ордер (§4.4, FR-022).
 *
 * 024 (additive, data-model §8): `intent` += `'add'` (доливка/scale-in); опц. `mode` (режим add),
 * `closeFraction` (доля частичного выхода 0<p<1), `origin:'protection'` (синтетический
 * runner-owned protection-ордер). Все опц. ключи опускаются на legacy-пути → `canonicalJson`
 * отбрасывает `undefined` → байт-идентичность выходов 018 (SC-001/R5).
 */
export interface SimulatedOrder {
  readonly id: string;
  readonly decisionBarIndex: number;
  readonly side: 'long' | 'short';
  readonly intent: 'open' | 'close' | 'add';
  readonly status: 'pending' | 'filled' | 'expired';
  /** Режим доливки (только `intent:'add'`). */
  readonly mode?: 'dca' | 'scale_in';
  /** Доля частичного закрытия 0<p<1 (только частичный `intent:'close'`). */
  readonly closeFraction?: number;
  /** `'protection'` для синтетического runner-owned protection-ордера. */
  readonly origin?: 'protection';
}

/** Симулированный fill (§4.5, FR-021/022).
 *
 * 024 (additive): опц. `kind` различает источник fill'а; опущен на legacy-пути → байт-идентичность.
 */
export interface SimulatedFill {
  readonly orderId: string;
  readonly fillBarIndex: number;
  readonly fillTs: number;
  readonly fillPrice: number;
  readonly baseOpen: number;
  readonly slippageBps: number;
  readonly feePaid: number;
  readonly size: number;
  /** Источник fill'а (024, опц.): `'open'|'add'|'close'|'protection'`. */
  readonly kind?: 'open' | 'add' | 'close' | 'protection';
}

/** Причина закрытия позиции (§4.6). Принудительное end-of-data → `end_of_data` (семантика `forced_mtm`).
 *
 * 024 (additive, data-model §8): += `'stop_hit'|'take_hit'` — **только** для protection-triggered
 * закрытия (runner-owned intrabar hard-guard). Литерал `partial_exit` **НЕ** вводится: частичность
 * сигнализируется через `Trade.closeKind:'partial'`, а `closeReason` несёт strategy-authored причину
 * (см. правило `closeReason` vs `closeKind`, data-model §8).
 */
export type CloseReason =
  | 'overlay_early_exit'
  | 'end_of_data'
  | 'forced_mtm'
  | 'stop_hit'
  | 'take_hit'
  | (string & {});

/** Закрытая сделка (§4.6, FR-022).
 *
 * 024 (additive, data-model §8): опц. `closeKind:'partial'` (частичный выход; full → ключ опущен),
 * `closeSeq` (per-position 0-based порядковый номер закрытия — несётся только на «богатых» путях для
 * уникальности `Trade.id`). Legacy единственное полное закрытие опускает оба ключа → байт-идентичность.
 */
export interface Trade {
  readonly id: string;
  readonly symbol: string;
  readonly side: 'long' | 'short';
  readonly entryBarIndex: number;
  readonly entryTs: number;
  readonly entryFillPrice: number;
  readonly exitBarIndex: number;
  readonly exitTs: number;
  readonly exitFillPrice: number;
  readonly size: number;
  readonly feePaid: number;
  readonly realizedPnl: number;
  readonly closeReason: CloseReason;
  /** Частичный выход → `'partial'`; полное закрытие опускает ключ (024, data-model §8). */
  readonly closeKind?: 'partial';
  /** Per-position 0-based порядковый номер закрытия (024); опущен на legacy single full-close. */
  readonly closeSeq?: number;
}

/** Точка equity curve (§4.7, FR-022): mark-to-market `cash + unrealized(close)`. */
export interface EquityPoint {
  readonly barIndex: number;
  readonly barTs: number;
  readonly equity: number;
}

// --- Метрики (data-model §4.8/§6) ---

/** Значение одной метрики (квантизованное число). */
export type MetricValue = number;

/** Запрошенные метрики таргета. */
export type MetricsMap = Readonly<Record<string, MetricValue>>;

/** Отложенная robustness-проверка (§4.9, FR-023): валидирована, но не вычислена. */
export interface DeferredRobustness {
  readonly check: string;
  readonly status: 'validated_but_not_computed';
}

// --- Bundle результата прогона (data-model §4.9) ---

/** Сводка прогона. */
export interface RunSummary {
  readonly targetKind: 'baseline' | 'variant';
  readonly moduleRef: Ref;
  readonly overlayRefs: readonly Ref[];
  readonly symbols: readonly string[];
  readonly barsProcessed: number;
  readonly ordersCount: number;
  readonly closedTradesCount: number;
}

/** Evidence bundle прогона. */
export interface RunEvidence {
  readonly seed: number;
  readonly datasetRef: string;
  readonly contractVersion: string;
  readonly moduleVersions: readonly Ref[];
  readonly riskProfileRef: Ref;
  readonly executionProfileRef: Ref;
  readonly simulatedOrders: readonly SimulatedOrder[];
  readonly simulatedFills: readonly SimulatedFill[];
  readonly riskDecisions: readonly RiskDecision[];
  readonly equityCurve: readonly EquityPoint[];
  readonly deferredRobustness: readonly DeferredRobustness[];
  /**
   * 023 (additive, US4/FR-014, R10) — детерминированная coverage-сводка OI/liquidations ленты.
   * `undefined` для OHLCV-only пути (ленты bar_close-only) → `canonicalJson` отбрасывает ключ →
   * байт-идентичность выходов 018 сохраняется (SC-001). Заполняется ТОЛЬКО для мульти-source ленты.
   */
  readonly coverage?: CoverageModel;
  /** 035 (realism) — per-bar funding charges (empty/absent on the default path). */
  readonly fundingLedger?: readonly { readonly barIndex: number; readonly ts: number; readonly rate: number; readonly covered: boolean; readonly cost: number }[];
}

/** Наполненная 018-форма результата прогона (§4.9, FR-024). Структурно удовлетворяет 017. */
export interface BacktestRunResult {
  readonly runId: string;
  readonly summary: RunSummary;
  readonly metrics: MetricsMap;
  readonly trades: readonly Trade[];
  readonly decisionRecords: readonly DecisionRecord[];
  readonly validationIssues: readonly ValidationIssue[];
  readonly artifactRefs: readonly string[];
  readonly evidence: RunEvidence;
}

// Type-level guard (research R2): 018-форма ДОЛЖНА быть присваиваема 017-интерфейсу. Несоответствие
// → ошибка компиляции (additive-дисциплина без изменения контракта).
type Satisfies017<T extends ContractBacktestRunResult> = T;
export type _AssertBacktestRunResultSatisfies017 = Satisfies017<BacktestRunResult>;

// --- Comparison (data-model §4.10) ---

/** Дельта одной метрики: `delta = variant − baseline`. */
export interface MetricDelta {
  readonly baseline: number;
  readonly variant: number;
  readonly delta: number;
}

/** Сводка эффектов overlay'ев варианта. */
export interface OverlayEffectsSummary {
  readonly pass: number;
  readonly annotate: number;
  readonly patch: number;
  readonly veto: number;
}

/** Сравнение одного варианта с baseline. */
export interface ComparisonVariant {
  readonly runId: string;
  readonly overlayRefs: readonly Ref[];
  readonly metricDeltas: Readonly<Record<string, MetricDelta>>;
  readonly tradeOutcomeChanged: boolean;
  readonly overlayEffectsSummary: OverlayEffectsSummary;
}

/** Comparison summary baseline ↔ варианты (§4.10, FR-001/023). */
export interface ComparisonSummary {
  readonly baselineRunId: string;
  readonly variants: readonly ComparisonVariant[];
}

// --- Таргеты и исход прогона (data-model §1.2, §4.11) ---

/** Резолвнутая стратегия из registry. */
export interface ResolvedStrategy {
  readonly module: StrategyModule;
  readonly manifest: ModuleManifest;
}

/** Резолвнутый overlay из registry. */
export interface ResolvedOverlay {
  readonly module: HypothesisOverlayModule;
  readonly manifest: ModuleManifest;
}

/** Таргет прогона (§1.2). `baseline.overlays = []`; `variant.overlays` — в порядке `overlayRefs`. */
export interface RunTarget {
  readonly kind: 'baseline' | 'variant';
  readonly runId: string;
  readonly strategy: ResolvedStrategy;
  readonly overlays: readonly ResolvedOverlay[];
}

/** Исход `BacktestRunner.run` (§4.11). `rejected` ⇒ 0 ордеров/fill'ов/equity (SC-003). */
export type RunOutcome =
  | { readonly status: 'rejected'; readonly validation: ValidationResult }
  | {
      readonly status: 'completed';
      readonly baseline: BacktestRunResult;
      readonly variant: BacktestRunResult | null;
      readonly comparison: ComparisonSummary | null;
    };
