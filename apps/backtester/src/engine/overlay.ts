// 018 — композитор overlay'ев (research R7, FR-013/014/015/007). Применяет `OverlayDecision` к
// накопленному решению строго в порядке `overlayRefs`:
//   pass     — без изменений;
//   annotate — только metadata (накопленное решение не меняется → schema-safe);
//   patch    — shallow-merge `patch.patch` поверх решения → РЕВАЛИДАЦИЯ против 017 strategy-decision
//              схемы (DRY, через `createSchemaRegistry().validateRef`) ДО risk/execution; невалидный
//              результат → ошибка композиции (`overlay_composition_invalid`/`decision_schema_invalid`);
//   veto     — terminal: последующие overlay'и НЕ применяются (их `apply` не вызывается).
// Базовый хук отсутствует ⇒ runner передаёт синтетический `{kind:'idle'}`. Каждый эффект → `OverlayEffect`.

import type { OverlayDecision, StrategyDecision } from '@trading/research-contracts/research';
import type { ValidationCode } from '@trading/research-contracts/research';
import { createSchemaRegistry, SCHEMA_IDS, type SchemaRegistry } from './validation/schema-registry.js';

import type { OverlayEffect, ResolvedOverlay } from './artifacts.js';

/** kind решения стратегии → имя ветки в strategy-decision.schema.json (для ревалидации patch). */
const STRATEGY_DECISION_DEFS: Readonly<Record<string, string>> = {
  enter: 'EnterDecision',
  exit: 'ExitDecision',
  add_to_position: 'AddToPositionDecision',
  update_protection: 'UpdateProtectionDecision',
  annotate: 'AnnotateDecision',
  idle: 'IdleDecision',
};

// Реестр схем компилируется один раз (как в 017-валидаторе) и переиспользуется.
let registrySingleton: SchemaRegistry | undefined;
function registry(): SchemaRegistry {
  return (registrySingleton ??= createSchemaRegistry());
}

/** Ошибка композиции (patch ⇒ невалидное решение). */
export interface CompositionError {
  readonly code: ValidationCode;
  readonly message: string;
}

/** Результат композиции overlay'ев в точке перехвата. */
export interface OverlayComposition {
  /** Решение после композиции; `null` при veto или ошибке patch. */
  readonly finalDecision: StrategyDecision | null;
  /** Эффекты по порядку применения. */
  readonly effects: readonly OverlayEffect[];
  /** Присутствует, если patch дал невалидное решение (abort — фиксируется runner'ом). */
  readonly error?: CompositionError;
}

/** Источник `OverlayDecision` для overlay'я (lazy — вызывается до veto). */
export type OverlayDecisionSource = (overlay: ResolvedOverlay) => Promise<OverlayDecision | null>;

/** Композитор overlay'ев (stateless относительно входа; единый schema-registry для ревалидации). */
export class OverlayComposer {
  /**
   * Применить overlay'и к `base` строго в их порядке. `getDecision` вызывается лениво (на veto
   * последующие overlay'и не опрашиваются).
   */
  async compose(
    base: StrategyDecision,
    overlays: readonly ResolvedOverlay[],
    getDecision: OverlayDecisionSource,
  ): Promise<OverlayComposition> {
    let accumulated: StrategyDecision = base;
    const effects: OverlayEffect[] = [];

    for (const overlay of overlays) {
      const overlayRef = { id: overlay.manifest.id, version: overlay.manifest.version };
      const decision = await getDecision(overlay);
      if (decision === null) continue;

      switch (decision.kind) {
        case 'pass':
          effects.push({ overlayRef, effect: 'pass', detail: {} });
          break;

        case 'annotate':
          effects.push({ overlayRef, effect: 'annotate', detail: { tags: decision.tags, notes: decision.notes } });
          break;

        case 'patch': {
          effects.push({ overlayRef, effect: 'patch', detail: decision.patch });
          const patched = { ...accumulated, ...(decision.patch as Record<string, unknown>) };
          const kind = (patched as { kind?: unknown }).kind;
          const branch = typeof kind === 'string' ? STRATEGY_DECISION_DEFS[kind] : undefined;
          if (branch === undefined) {
            return {
              finalDecision: null,
              effects,
              error: { code: 'decision_schema_invalid', message: `patch дал решение с неизвестным kind: ${String(kind)}` },
            };
          }
          const errs = registry().validateRef(`${SCHEMA_IDS['strategy-decision']}#/definitions/${branch}`, patched);
          if (errs.length > 0) {
            return {
              finalDecision: null,
              effects,
              error: {
                code: 'overlay_composition_invalid',
                message: `patched-решение невалидно: ${errs.map((e) => e.message ?? 'schema error').join('; ')}`,
              },
            };
          }
          accumulated = patched as StrategyDecision;
          break;
        }

        case 'veto':
          effects.push({ overlayRef, effect: 'veto', detail: { reasonCode: decision.reasonCode } });
          return { finalDecision: null, effects }; // terminal
      }
    }

    return { finalDecision: accumulated, effects };
  }
}
