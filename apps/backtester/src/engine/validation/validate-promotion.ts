// 017 — гейт продвижения статуса (FR-029/FR-030/FR-031, US7, data-model §14).
// Forward-only FSM по одному шагу: research_only → reviewed → promoted. Продвижение требует
// evidence + явного review. 017 stateless: текущий статус берётся из fromStatus запроса.

import type {
  ModuleStatus,
  PromotionRequest,
  ValidationIssue,
  ValidationResult,
} from '@trading/research-contracts/research';

import { assemble, makeIssue } from './assemble.js';
import { normalizePromotion } from './normalize.js';

/** Вход валидации продвижения (data-model §13.1). */
export interface PromotionInput {
  readonly promotion: PromotionRequest;
}

/** Порядок forward-only автомата статусов (data-model §14). */
const STATUS_ORDER: Readonly<Record<ModuleStatus, number>> = {
  research_only: 0,
  reviewed: 1,
  promoted: 2,
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

function isRef(v: unknown): boolean {
  const r = asRecord(v);
  return (
    r !== null &&
    typeof r.id === 'string' &&
    r.id.length > 0 &&
    typeof r.version === 'string' &&
    r.version.length > 0
  );
}

function isStatus(v: unknown): v is ModuleStatus {
  return v === 'research_only' || v === 'reviewed' || v === 'promoted';
}

/**
 * Провалидировать запрос продвижения. Чистая функция. `normalized` (с сохранённой ссылкой на
 * evidence) — только при валидном forward-only переходе с evidence+review.
 */
export function validatePromotion(input: PromotionInput): ValidationResult {
  const issues: ValidationIssue[] = [];
  const p = asRecord(input.promotion);
  if (p === null) {
    issues.push(makeIssue('schema_invalid', 'PromotionRequest должен быть объектом', ''));
    return assemble(issues);
  }

  // 1. Ссылка на версию модуля структурно валидна.
  if (!isRef(p.moduleRef)) {
    issues.push(makeIssue('schema_invalid', 'moduleRef структурно невалиден (нужны id+version)', '/moduleRef'));
  }

  // 2. Forward-only переход по одному шагу (data-model §14).
  const { fromStatus, toStatus } = p;
  if (!isStatus(fromStatus)) {
    issues.push(makeIssue('schema_invalid', 'fromStatus вне набора ModuleStatus', '/fromStatus'));
  }
  if (!isStatus(toStatus)) {
    issues.push(makeIssue('schema_invalid', 'toStatus вне набора ModuleStatus', '/toStatus'));
  }
  if (isStatus(fromStatus) && isStatus(toStatus) && STATUS_ORDER[toStatus] !== STATUS_ORDER[fromStatus] + 1) {
    issues.push(
      makeIssue(
        'schema_invalid',
        `недопустимый переход ${fromStatus} → ${toStatus} (forward-only, ровно один шаг)`,
        '/toStatus',
      ),
    );
  }

  // 3. Продвижение требует evidence + явного approved-review (FR-031, US7-AC2).
  const evidenceOk = typeof p.evidenceRef === 'string' && p.evidenceRef.length > 0;
  if (!evidenceOk) {
    issues.push(makeIssue('promotion_requires_review', 'продвижение требует evidenceRef', '/evidenceRef'));
  }
  const review = asRecord(p.reviewDecision);
  if (review === null || review.decision !== 'approved') {
    issues.push(
      makeIssue('promotion_requires_review', 'продвижение требует явного review (decision=approved)', '/reviewDecision'),
    );
  }

  const hasError = issues.some((i) => i.severity === 'error');
  return assemble(issues, hasError ? undefined : normalizePromotion(input.promotion));
}
