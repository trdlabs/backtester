// 017 — структурная валидация BacktestRunRequest (FR-024/FR-026/FR-027, US6, research D10,
// data-model §11). 017 stateless и без реестра модулей: семантические коды проверяются
// СТРУКТУРНО (well-formedness ссылок, членство в каталогах, дубликаты, композиция). Само
// применение overlays и резолв ссылок в модули — зона будущего runner'а.

import type {
  ContractContext,
  BacktestRunRequest,
  ValidationIssue,
  ValidationResult,
} from '@trading/research-contracts/research';

import { assemble, makeIssue } from './assemble.js';
import { normalizeRunRequest } from './normalize.js';
import { jsonPointerOf, type SchemaRegistry } from './schema-registry.js';

/** Вход валидации run-request (data-model §13.1). */
export interface RunRequestInput {
  readonly request: BacktestRunRequest;
}

/** Пути, владельцы которых — семантические коды (не дублируем их как schema_invalid). */
function ownedBySemanticCode(path: string): boolean {
  return (
    path === '/moduleRef' ||
    path.startsWith('/moduleRef/') ||
    path === '/metrics' ||
    path.startsWith('/metrics/')
  );
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

/** Ссылка структурно валидна: непустые строковые id и version. */
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

/**
 * Провалидировать самодостаточность и однозначность запроса прогона. Чистая функция.
 * Аккумулирует полный набор причин (FR-022); `normalized` (с сохранённым порядком overlays) —
 * только при отсутствии error.
 */
export function validateRunRequest(
  input: RunRequestInput,
  ctx: ContractContext,
  registry: SchemaRegistry,
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const r = asRecord(input.request);
  if (r === null) {
    issues.push(makeIssue('schema_invalid', 'BacktestRunRequest должен быть объектом', ''));
    return assemble(issues);
  }

  // 0. Базовая schema конверта: обязательные поля (runId/mode/datasetRef/symbols/timeframe/period/
  // seed) + additionalProperties:false → schema_invalid. moduleRef/metrics остаются за
  // семантическими кодами (incomplete_run_request/invalid_module_ref/unknown_metric) — не дублируем.
  for (const e of registry.validateCore('backtest-run-request', input.request)) {
    const path = jsonPointerOf(e);
    if (ownedBySemanticCode(path)) continue;
    issues.push(makeIssue('schema_invalid', e.message ?? 'нарушение схемы запроса', path));
  }

  // 1. Baseline: отсутствует → incomplete; присутствует, но малформед → invalid_module_ref.
  let moduleId: string | undefined;
  if (r.moduleRef === undefined || r.moduleRef === null) {
    issues.push(makeIssue('incomplete_run_request', 'отсутствует baseline moduleRef', '/moduleRef'));
  } else if (!isRef(r.moduleRef)) {
    issues.push(makeIssue('invalid_module_ref', 'moduleRef структурно невалиден (нужны id+version)', '/moduleRef'));
  } else {
    moduleId = (asRecord(r.moduleRef) as { id: string }).id;
  }

  // 2. Метрики: обязательны; каждая — из каталога (FR-026).
  if (!Array.isArray(r.metrics) || r.metrics.length === 0) {
    issues.push(makeIssue('incomplete_run_request', 'отсутствуют метрики', '/metrics'));
  } else {
    r.metrics.forEach((m, i) => {
      if (typeof m !== 'string' || !ctx.metricCatalog.includes(m)) {
        issues.push(makeIssue('unknown_metric', `метрика вне каталога: ${String(m)}`, `/metrics/${i}`));
      }
    });
  }

  // 3. Robustness-проверки: каждая — из каталога robustness.
  if (Array.isArray(r.robustnessChecks)) {
    r.robustnessChecks.forEach((c, i) => {
      if (typeof c !== 'string' || !ctx.robustnessCatalog.includes(c)) {
        issues.push(makeIssue('unknown_metric', `robustness-проверка вне каталога: ${String(c)}`, `/robustnessChecks/${i}`));
      }
    });
  }

  // 4. overlayRefs: структура / дубликаты / композиция / empty-diff (порядок сохраняется как задан).
  const overlayRefs = r.overlayRefs;
  if (overlayRefs === undefined || (Array.isArray(overlayRefs) && overlayRefs.length === 0)) {
    issues.push(
      makeIssue('empty_baseline_variant_diff', 'baseline и variant идентичны: overlays не заданы', '/overlayRefs'),
    );
  } else if (!Array.isArray(overlayRefs)) {
    issues.push(makeIssue('schema_invalid', 'overlayRefs должен быть массивом', '/overlayRefs'));
  } else {
    const seen = new Set<string>();
    overlayRefs.forEach((ref, i) => {
      if (!isRef(ref)) {
        issues.push(makeIssue('invalid_module_ref', 'overlayRef структурно невалиден (нужны id+version)', `/overlayRefs/${i}`));
        return;
      }
      const rr = asRecord(ref) as { id: string; version: string };
      const key = `${rr.id}@${rr.version}`;
      if (seen.has(key)) {
        issues.push(makeIssue('duplicate_overlay_ref', `дубликат overlay ref: ${key}`, `/overlayRefs/${i}`));
      }
      seen.add(key);
      if (moduleId !== undefined && rr.id === moduleId) {
        issues.push(
          makeIssue('overlay_composition_invalid', `baseline-модуль использован как overlay: ${rr.id}`, `/overlayRefs/${i}`),
        );
      }
    });
  }

  // 5. RiskProfile: конфиг способен открыть позицию → riskProfileRef обязателен (FR-027).
  if (r.riskProfileRef === undefined || r.riskProfileRef === null) {
    issues.push(
      makeIssue('missing_risk_profile', 'конфиг способен открыть позицию, но riskProfileRef не привязан', '/riskProfileRef'),
    );
  } else if (!isRef(r.riskProfileRef)) {
    issues.push(makeIssue('schema_invalid', 'riskProfileRef структурно невалиден (нужны id+version)', '/riskProfileRef'));
  }

  const hasError = issues.some((i) => i.severity === 'error');
  return assemble(issues, hasError ? undefined : normalizeRunRequest(input.request));
}
