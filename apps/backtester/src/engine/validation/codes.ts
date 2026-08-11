// 017 — рантайм-константы кодов валидации и маппинг code → severity (FR-021, data-model §13.2).
// Единственный источник severity для каждого кода (используется при сборке причин, assemble.ts).

import type { Severity, ValidationCode } from '@trading/research-contracts/research';

/**
 * code → severity. Error блокирует приём; warning — нет (data-model §13.2).
 *
 * Значения — зеркало авторитетной карты ядра (`CODE_SEVERITY` из `@trdlabs/sdk/validation`),
 * а не независимое суждение: расхождение здесь означало бы, что один и тот же отказ блокирует
 * приём в ядре и не блокирует у нас. Ручная копия держится ради `Record<ValidationCode, …>` —
 * новый код в таксономии ядра ломает сборку и заставляет посмотреть на него, а не молча
 * унаследовать. Сверять при каждом подъёме `@trdlabs/sdk`.
 */
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
  // sdk 0.14.0 (083 S1): закрытый пятивидовой каталог `MarketDataRequirement` + revision/funding-form.
  missing_market_data_requirement: 'error',
  unsupported_market_data_scope: 'error',
  unsupported_revision_policy: 'error',
  unsupported_funding_form: 'error',
  // `error`, а не `warning`, хотя код пока ниоткуда не эмитится: он размечает НЕобъявленный
  // переход через границу `datasetId`. Агрегат восьми бирж и агрегат внешнего провайдера — разные
  // величины, и окно поперёк такого перехода даёт число, которого нет ни на одном источнике
  // по отдельности; пропускать это предупреждением значит принимать выдуманный результат.
  // Отсутствие эмиттера — не долг ядра: проверку исполняет run plan (host), и хост здесь мы.
  dataset_boundary_violation: 'error',
  invalid_market_data_requirement: 'error',
  duplicate_market_data_requirement_id: 'error',
  // sdk 0.14.0 (083 S1): версионирование наблюдений (observation revisions).
  observation_revision_conflict: 'error',
  observation_revision_finalized: 'error',
  observation_revision_skipped: 'error',
  observation_revision_regressed: 'error',
  observation_revision_invalid: 'error',
  observation_revision_key_mismatch: 'error',
  observation_revision_start_invalid: 'error',
  observation_finality_demoted: 'error',
  observation_archive_row_corrupt: 'error',
  // 083 S3 (`@trdlabs/sdk@0.15.0`): хост не может исполнить ОБЪЯВЛЕННУЮ форму стратегии — раскатка
  // не разрешена, режим исполнения несовместим с формой, у исполнителя нет способности. Не путать
  // с `lifecycle_form_invalid`: тот про манифест, противоречащий сам себе (чинит автор), этот про
  // окружение при безупречном манифесте (чинит владелец хоста).
  //
  // Эта строка появилась не по внимательности, а потому что ручная копия карты сломала сборку при
  // подъёме sdk — ровно то, ради чего она здесь и держится.
  unsupported_lifecycle: 'error',
  empty_baseline_variant_diff: 'warning',
};

/** Все коды таксономии (для проверок полноты, SC-002). */
export const ALL_VALIDATION_CODES = Object.keys(CODE_SEVERITY) as ValidationCode[];

/** severity заданного кода. */
export function severityOf(code: ValidationCode): Severity {
  return CODE_SEVERITY[code];
}
