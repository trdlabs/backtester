// 017 — нормализованная репрезентация принятого manifest'а для воспроизводимой передачи
// runner'у (FR-023, data-model §13.1). Детерминирована: стабильный порядок хуков и
// отсортированные списки объявленных capabilities/dataNeeds.

import type {
  CapabilityDeclaration,
  DataNeedsDeclaration,
  LifecycleHook,
  ModuleKind,
  ModuleManifest,
  ModuleStatus,
  PromotionRequest,
  ReviewDecision,
  BacktestRunRequest,
  Ref,
  RunPeriod,
} from '@trading/research-contracts/research';

/** Канонический порядок lifecycle-хуков (data-model §5). */
const HOOK_ORDER: readonly LifecycleHook[] = [
  'init',
  'onBarClose',
  'onPositionBar',
  'onPendingIntentBar',
  'dispose',
  'apply',
];

/**
 * Нормализованный manifest: детерминированная подвыборка полей, пригодная к воспроизводимой
 * передаче будущему runner'у. Конкретный тип слота `ValidationResult.normalized`.
 */
export interface NormalizedManifest {
  readonly id: string;
  readonly version: string;
  readonly kind: ModuleKind;
  readonly name: string;
  readonly contractVersion: string;
  readonly status: ModuleStatus;
  /** Хуки в каноническом порядке. */
  readonly hooks: readonly LifecycleHook[];
  /** Имена объявленных (true) capabilities, отсортированы. */
  readonly capabilities: readonly string[];
  /** Имена объявленных (true) data-needs, отсортированы. */
  readonly dataNeeds: readonly string[];
  readonly paramsSchema: object;
  /** Payload параметров; `{}` если отсутствует. */
  readonly params: object;
  readonly targetStrategyRef?: string;
  readonly interceptionPoint?: string;
}

function declaredFlags(
  decl: CapabilityDeclaration | DataNeedsDeclaration,
): readonly string[] {
  return Object.keys(decl)
    .filter((k) => (decl as Record<string, boolean | undefined>)[k] === true)
    .sort();
}

function canonicalHooks(hooks: readonly LifecycleHook[]): readonly LifecycleHook[] {
  const present = new Set(hooks);
  return HOOK_ORDER.filter((h) => present.has(h));
}

/** Построить детерминированный `NormalizedManifest` из принятого манифеста. */
export function normalizeManifest(manifest: ModuleManifest): NormalizedManifest {
  const base: NormalizedManifest = {
    id: manifest.id,
    version: manifest.version,
    kind: manifest.kind,
    name: manifest.name,
    contractVersion: manifest.contractVersion,
    status: manifest.status,
    hooks: canonicalHooks(manifest.hooks),
    capabilities: declaredFlags(manifest.capabilities),
    dataNeeds: declaredFlags(manifest.dataNeeds),
    paramsSchema: manifest.paramsSchema,
    params: manifest.params ?? {},
  };
  if (manifest.kind === 'overlay') {
    return {
      ...base,
      targetStrategyRef: manifest.targetStrategyRef,
      interceptionPoint: manifest.interceptionPoint,
    };
  }
  return base;
}

/**
 * Нормализованный run-request: детерминированный echo полей с СОХРАНЁННЫМ порядком `overlayRefs`
 * (implicit ordering запрещён, FR-024/US6-AC7). Конкретная форма слота `ValidationResult.normalized`.
 */
export interface NormalizedRunRequest {
  readonly runId: string;
  readonly mode: string;
  readonly moduleRef: Ref;
  readonly overlayRefs: readonly Ref[];
  readonly datasetRef: string;
  readonly symbols: readonly string[];
  readonly timeframe: string;
  readonly period: RunPeriod;
  readonly seed: number;
  readonly metrics: readonly string[];
  readonly robustnessChecks: readonly string[];
  readonly riskProfileRef?: Ref;
  readonly executionProfileRef?: Ref;
}

/** Построить детерминированный `NormalizedRunRequest` из принятого запроса (порядок overlays сохраняется). */
export function normalizeRunRequest(request: BacktestRunRequest): NormalizedRunRequest {
  const base: NormalizedRunRequest = {
    runId: request.runId,
    mode: request.mode,
    moduleRef: request.moduleRef,
    overlayRefs: request.overlayRefs ?? [],
    datasetRef: request.datasetRef,
    symbols: request.symbols,
    timeframe: request.timeframe,
    period: request.period,
    seed: request.seed,
    metrics: request.metrics,
    robustnessChecks: request.robustnessChecks ?? [],
  };
  return {
    ...base,
    ...(request.riskProfileRef !== undefined ? { riskProfileRef: request.riskProfileRef } : {}),
    ...(request.executionProfileRef !== undefined ? { executionProfileRef: request.executionProfileRef } : {}),
  };
}

/**
 * Нормализованный promotion-запрос (data-model §14). Сохраняет ссылку на evidence при валидном
 * forward-only переходе (FR-031). Конкретная форма слота `ValidationResult.normalized`.
 */
export interface NormalizedPromotion {
  readonly moduleRef: Ref;
  readonly fromStatus: ModuleStatus;
  readonly toStatus: ModuleStatus;
  readonly evidenceRef?: string;
  readonly reviewDecision?: ReviewDecision;
}

/** Построить детерминированный `NormalizedPromotion` из принятого запроса продвижения. */
export function normalizePromotion(promotion: PromotionRequest): NormalizedPromotion {
  return {
    moduleRef: promotion.moduleRef,
    fromStatus: promotion.fromStatus,
    toStatus: promotion.toStatus,
    ...(promotion.evidenceRef !== undefined ? { evidenceRef: promotion.evidenceRef } : {}),
    ...(promotion.reviewDecision !== undefined ? { reviewDecision: promotion.reviewDecision } : {}),
  };
}
