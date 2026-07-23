// 017 — рантайм-константы кодов валидации и маппинг code → severity (FR-021, data-model §13.2).
// Единственный источник severity для каждого кода (используется при сборке причин, assemble.ts).

import type { Severity, ValidationCode } from '@trading/research-contracts/research';

/** code → severity. Error блокирует приём; warning — нет (data-model §13.2). */
export const CODE_SEVERITY: Readonly<Record<ValidationCode, Severity>> = {
  schema_invalid: 'error',
  params_schema_invalid: 'error',
  decision_schema_invalid: 'error',
  unsupported_contract_version: 'error',
  unknown_strategy_ref: 'error',
  multi_hook_overlay: 'error',
  lookahead_violation: 'error',
  forbidden_capability: 'error',
  separation_violation: 'error',
  missing_risk_profile: 'error',
  unknown_metric: 'error',
  invalid_module_ref: 'error',
  incomplete_run_request: 'error',
  promotion_requires_review: 'error',
  duplicate_overlay_ref: 'error',
  overlay_composition_invalid: 'error',
  nondeterminism_violation: 'error',
  unsupported_market_data_kind: 'error',
  missing_required_market_data: 'error',
  unsupported_fill_model_kind: 'error',
  // sdk 0.13.0 (Ф1 shared-execution-engine): замкнутые каталоги слотов модели среды.
  unsupported_reality_model_kind: 'error',
  // sdk 0.13.0 (083 E1): соответствие набора хуков объявленной форме стратегии.
  lifecycle_form_invalid: 'error',
  empty_baseline_variant_diff: 'warning',
};

/** Все коды таксономии (для проверок полноты, SC-002). */
export const ALL_VALIDATION_CODES = Object.keys(CODE_SEVERITY) as ValidationCode[];

/** severity заданного кода. */
export function severityOf(code: ValidationCode): Severity {
  return CODE_SEVERITY[code];
}
