// 017 — сборка ValidationResult: стабильная сортировка причин, деривация статуса, прикрепление
// normalized при приёме (FR-021/FR-022, research D8).

import type {
  ValidationCode,
  ValidationIssue,
  ValidationResult,
} from '@trading/research-contracts/research';

import { CODE_SEVERITY } from './codes.js';

/** Построить причину; severity выводится из кода (единый источник — CODE_SEVERITY). */
export function makeIssue(
  code: ValidationCode,
  message: string,
  path: string,
): ValidationIssue {
  return { severity: CODE_SEVERITY[code], code, message, path };
}

/** Стабильный компаратор причин по `(path, code)` (детерминизм, D8/SC-004). */
function byPathThenCode(a: ValidationIssue, b: ValidationIssue): number {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  if (a.code !== b.code) return a.code < b.code ? -1 : 1;
  return 0;
}

/**
 * Собрать итоговый результат: стабильно отсортировать причины, вывести статус
 * (`rejected` при любом error; иначе `accepted_with_warnings` при warning; иначе `accepted`) и
 * прикрепить `normalized` при приёме (FR-023). `normalized` ОБЯЗАН передаваться вызывающим при
 * отсутствии error-причин.
 */
export function assemble(
  issues: readonly ValidationIssue[],
  normalized?: object,
): ValidationResult {
  const sorted = [...issues].sort(byPathThenCode);
  const hasError = sorted.some((i) => i.severity === 'error');
  const hasWarning = sorted.some((i) => i.severity === 'warning');
  const status: ValidationResult['status'] = hasError
    ? 'rejected'
    : hasWarning
      ? 'accepted_with_warnings'
      : 'accepted';

  if (status === 'rejected' || normalized === undefined) {
    return { status, issues: sorted };
  }
  return { status, normalized, issues: sorted };
}
