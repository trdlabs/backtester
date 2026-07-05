// 020 — валидация запроса индикатора (contracts/validation-codes.md, research R5).
//
// Чистая, детерминированная, fail-closed; возвращает ПОЛНЫЙ набор причин (не только первую),
// стабильно отсортированный по (path, code). Форма зеркалит 017 ValidationResult, но с
// собственным IndicatorValidationCode (017 ValidationCode не редактируется — additive).

import type {
  IndicatorCatalog,
  IndicatorIssue,
  IndicatorRequest,
  IndicatorValidationResult,
} from '@trading/research-contracts/research';

import { findDefinition, resolveParams } from './catalog.js';

/**
 * Валидировать запрос против каталога. Чистая функция: один и тот же вход → один и тот же
 * результат. Не зависит от истории/окружения; `period > истории` НЕ ошибка (это warmup).
 */
export function validateIndicatorRequest(
  catalog: IndicatorCatalog,
  request: IndicatorRequest,
): IndicatorValidationResult {
  const issues: IndicatorIssue[] = [];
  const def = findDefinition(catalog, request.name);

  if (def === undefined) {
    issues.push({
      severity: 'error',
      code: 'indicator_unsupported',
      message: `indicator "${request.name}" is not in the catalog`,
      path: '/name',
    });
    // Без схемы валидировать params/source невозможно — возвращаем как есть.
    return { status: 'rejected', issues: sortIssues(issues) };
  }

  // source
  if (request.source !== undefined && !def.sourceFields.includes(request.source)) {
    issues.push({
      severity: 'error',
      code: 'indicator_source_unsupported',
      message: `source "${request.source}" is not supported by "${def.name}"`,
      path: '/source',
    });
  }

  // params: предоставленные значения против схемы
  const provided = request.params ?? {};
  for (const key of Object.keys(provided)) {
    const spec = def.paramsSchema[key];
    if (spec === undefined) {
      issues.push({
        severity: 'error',
        code: 'indicator_params_invalid',
        message: `unknown parameter "${key}" for "${def.name}"`,
        path: `/params/${key}`,
      });
      continue;
    }
    const value = provided[key];
    if (!Number.isFinite(value)) {
      issues.push({
        severity: 'error',
        code: 'indicator_params_invalid',
        message: `parameter "${key}" must be a finite number`,
        path: `/params/${key}`,
      });
      continue; // дальнейшие числовые проверки бессмысленны для NaN/Infinity
    }
    if (spec.type === 'int' && !Number.isInteger(value)) {
      issues.push({
        severity: 'error',
        code: 'indicator_params_invalid',
        message: `parameter "${key}" must be an integer`,
        path: `/params/${key}`,
      });
    }
    if (spec.min !== undefined && value < spec.min) {
      issues.push({
        severity: 'error',
        code: 'indicator_params_invalid',
        message: `parameter "${key}" must be ≥ ${spec.min}`,
        path: `/params/${key}`,
      });
    }
    if (spec.exclusiveMin !== undefined && value <= spec.exclusiveMin) {
      issues.push({
        severity: 'error',
        code: 'indicator_params_invalid',
        message: `parameter "${key}" must be > ${spec.exclusiveMin}`,
        path: `/params/${key}`,
      });
    }
  }

  // Обязательные params без default'а: отсутствие → отказ (иначе формула получит undefined).
  for (const [key, spec] of Object.entries(def.paramsSchema)) {
    if (spec.default === undefined && provided[key] === undefined) {
      issues.push({
        severity: 'error',
        code: 'indicator_params_invalid',
        message: `parameter "${key}" is required for "${def.name}"`,
        path: `/params/${key}`,
      });
    }
  }

  // Кросс-поле: macd требует fast < slow (по разрешённым значениям).
  if (def.name === 'macd') {
    const resolved = resolveParams(def, request.params);
    if (resolved.fast >= resolved.slow) {
      issues.push({
        severity: 'error',
        code: 'indicator_params_invalid',
        message: 'macd requires fast < slow',
        path: '/params/fast',
      });
    }
  }

  return {
    status: issues.length === 0 ? 'accepted' : 'rejected',
    issues: sortIssues(issues),
  };
}

/** Стабильная сортировка причин по (path, code). */
function sortIssues(issues: readonly IndicatorIssue[]): readonly IndicatorIssue[] {
  return [...issues].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    return 0;
  });
}

/** Контекст отказа для диагностики (несётся ошибкой). */
export interface IndicatorValidationErrorContext {
  readonly indicatorName: string;
  readonly params?: Readonly<Record<string, number>>;
  readonly symbol?: string;
  readonly barIndex?: number;
}

/** Fail-closed ошибка: движок бросает её при `rejected` (0 ордеров + диагностика). */
export class IndicatorValidationError extends Error {
  readonly result: IndicatorValidationResult;
  readonly indicatorName: string;
  readonly params?: Readonly<Record<string, number>>;
  readonly symbol?: string;
  readonly barIndex?: number;

  constructor(result: IndicatorValidationResult, context: IndicatorValidationErrorContext) {
    const codes = result.issues.map((i) => i.code).join(', ');
    super(`indicator validation failed for "${context.indicatorName}": ${codes}`);
    this.name = 'IndicatorValidationError';
    this.result = result;
    this.indicatorName = context.indicatorName;
    this.params = context.params;
    this.symbol = context.symbol;
    this.barIndex = context.barIndex;
  }
}
