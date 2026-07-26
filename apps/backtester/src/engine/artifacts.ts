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

// Ф3 (shared-execution-engine): the risk verdict shapes are PRODUCED by the shared core
// (`RiskEngine.evaluate` returns them), so the engine owns them and the host re-exports. Keeping a
// second local definition is how the two-interpreter drift this initiative ends got started.
import type { RiskClamp, RiskDecision } from '@trdlabs/engine';
export type { RiskClamp, RiskDecision };

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

/**
 * Ф3 (shared-execution-engine): `CloseReason` and `Trade` are PRODUCED by the shared core
 * (`Portfolio.settleClose` / `closePosition` / `forcedMtmClose` return them), so the engine owns
 * them and the host re-exports.
 *
 * Two fields the core added over the donor shape, both prescribed by the SSOT and recorded in the
 * initiative card as Ф3 migration notes:
 *   • `fundingPaid?` — SSOT decision 4: funding is a settlement that adjusts the position's realized
 *     PnL, apportioned to the closed share. Key omitted when zero, so the funding-free default path
 *     stays byte-identical.
 *   • `synthetic?: 'end_of_data'` — SSOT decision 5: the forced MTM close is flagged so metrics and
 *     reconciliation can exclude it instead of inferring it from `closeReason`.
 */
import type { CloseReason, Trade } from '@trdlabs/engine';
export type { CloseReason, Trade };

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

/**
 * Ф3 / run identity — owner decision **(A)** of 2026-07-25 (control-center
 * `docs/delivery/initiatives/shared-execution-engine.md`, «Open question — does run identity need
 * its own format version?»).
 *
 * The version of the SHAPE of `RunEvidence`. Bumped if and ONLY IF the evidence shape changes —
 * never because a research contract moved. The precedent that forced the decision: `017.2 → 017.3`
 * widened the manifest envelope, changed nothing about how a run executes or what its evidence
 * contains, and still invalidated every committed byte-identity golden.
 */
export const EVIDENCE_FORMAT_VERSION = '1';

/** Evidence bundle прогона. */
export interface RunEvidence {
  /**
   * Decision (A): run identity carries its OWN evidence-format version. `contractVersion` below
   * remains an ordinary hashed field — it participates in the hash, but a research-contract bump
   * does not by itself declare a new evidence format.
   */
  readonly evidenceFormatVersion: string;
  /**
   * Which execution core produced this run. Per the initiative's «Contract / API / schema changes»,
   * run and evidence records gain an `engineVersion`: a semantics change IS an engine version
   * change, so a run's identity must record which core executed it.
   */
  readonly engineVersion: string;
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
  /** Bar-major (Slice A) only: how N per-symbol accounts were capitalised + aggregated. Omitted for symbol-major. */
  readonly capitalModel?: {
    readonly model: 'equal_weight_per_symbol';
    readonly perSymbolInitialEquity: number;
    readonly symbolCount: number;
    readonly aggregateBaseline: number;
  };
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
  /**
   * Провенанс (опц.; проставляется 019-registry). Метаданные, НЕ привилегия: sandbox-исполнение
   * гарантирует изоляцию только вместе с bundle-handle (`bundle` ниже) — router уходит в sandbox лишь
   * при `provenance === 'bundle' && bundle !== undefined`. `'trusted'`/undefined ⇒ in-process путь.
   */
  readonly provenance?: 'trusted' | 'bundle';
  /**
   * Опционально: handle sandbox-бандла (`ModuleBundle`; типизирован как `unknown` во избежание цикла
   * artifacts→sandbox). Присутствует ⟺ стратегия реально маршрутизируется в sandbox. Guard (P2-20) и
   * router ДОЛЖНЫ использовать один и тот же predicate `provenance === 'bundle' && bundle !== undefined`.
   */
  readonly bundle?: unknown;
  /**
   * Опционально (trusted): фабрика для СВЕЖЕГО инстанса модуля per-symbol. Когда задана, runner
   * инстанцирует стратегию заново на каждый символ — так module-level FSM-state (в замыкании
   * `createStrategyModule`) НЕ протекает между символами (twin-equivalence с sandbox, где каждый символ
   * получает ОТДЕЛЬНЫЙ per-symbol инстанс — контейнер при этом может быть ОБЩИМ, universe mode). Не
   * задана → переиспользуется `module` (поведение single-symbol неизменно).
   */
  readonly moduleFactory?: (params: unknown) => StrategyModule;
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
