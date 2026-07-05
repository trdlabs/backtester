// 019 — таксономия ошибок sandbox-шлюза (FR-007/025/026/027; data-model §7, contracts/error-taxonomy-019).
//
// Аддитивна поверх закрытого 017-union `ValidationCode`: 017 `codes.ts`/`validation.ts` НЕ
// модифицируются — здесь они только импортируются. `SandboxValidationCode = ValidationCode ∪ 019-коды`.
// Все 019-коды — severity `error`; 017-коды наследуют 017-severity (`CODE_SEVERITY`, реэкспортируется).

import type { Severity, ValidationCode, ValidationStatus } from '@trading/research-contracts/research';
import type { Ref } from '@trading/research-contracts/research';
import type { LifecycleHook } from '@trading/research-contracts/research';
import { CODE_SEVERITY } from '../validation/codes.js';
import { redact } from './redaction.js';

/** Реэкспорт 017-severity-таблицы для общих (017) кодов — единый источник, 017 `codes.ts` не трогается. */
export { CODE_SEVERITY } from '../validation/codes.js';

/**
 * 019-specific коды (вне закрытого 017-union). Рантайм-кортеж — для перечисления/проверок полноты
 * (verify-скрипты) и для типизации `SANDBOX_CODE_SEVERITY`.
 */
export const SANDBOX_ONLY_CODES = [
  // --- bundle-уровень (до build/execution) ---
  'bundle_incomplete',
  'bundle_entrypoint_invalid',
  'bundle_integrity_violation',
  'bundle_load_failed', // синтаксис/загрузка/инстанцирование ESM (нет шага сборки/транспиляции)
  // --- sandbox runtime ---
  'sandbox_timeout',
  'sandbox_memory_exceeded',
  'sandbox_output_overflow',
  'sandbox_output_malformed',
  'sandbox_forbidden_access', // сеть / host-write / env-секреты / процесс / shell
  'sandbox_forbidden_import', // exchange/broker/ccxt/runtime/Postgres/LLM/MCP
  'sandbox_crashed',
] as const;

/** Код, введённый 019 (подмножество `SandboxValidationCode`, не пересекающееся с 017). */
export type SandboxOnlyCode = (typeof SANDBOX_ONLY_CODES)[number];

/**
 * Полная таксономия кодов 019: 017 `ValidationCode` (закрытый union) ∪ 019-коды.
 * Расширение безопасно — 017-union является подмножеством.
 */
export type SandboxValidationCode = ValidationCode | SandboxOnlyCode;

/** code → severity ТОЛЬКО для 019-кодов; все — `error` (блокируют путь/приём). */
export const SANDBOX_CODE_SEVERITY: Readonly<Record<SandboxOnlyCode, Severity>> = {
  bundle_incomplete: 'error',
  bundle_entrypoint_invalid: 'error',
  bundle_integrity_violation: 'error',
  bundle_load_failed: 'error',
  sandbox_timeout: 'error',
  sandbox_memory_exceeded: 'error',
  sandbox_output_overflow: 'error',
  sandbox_output_malformed: 'error',
  sandbox_forbidden_access: 'error',
  sandbox_forbidden_import: 'error',
  sandbox_crashed: 'error',
};

/** severity любого кода таксономии 019: 019-код → `SANDBOX_CODE_SEVERITY`, иначе → 017 `CODE_SEVERITY`. */
export function sandboxSeverityOf(code: SandboxValidationCode): Severity {
  if (code in SANDBOX_CODE_SEVERITY) {
    return SANDBOX_CODE_SEVERITY[code as SandboxOnlyCode];
  }
  return CODE_SEVERITY[code as ValidationCode];
}

/** Одна причина — форма 017 `ValidationIssue`, но с расширенным кодом. */
export interface SandboxIssue {
  readonly severity: Severity;
  readonly code: SandboxValidationCode;
  readonly message: string;
  /** JSON Pointer (RFC 6901) к нарушающему узлу; `""` — корень. */
  readonly path: string;
}

/**
 * Результат acceptance-gate — форма 017 `ValidationResult` (status + полный набор причин).
 * `issues` — ПОЛНЫЙ набор причин (FR-007), стабильно отсортирован. `normalizedManifest`/`bundleHash`
 * присутствуют при приёме (`accepted`/`accepted_with_warnings`).
 */
export interface BundleValidationResult {
  readonly status: ValidationStatus; // 'accepted' | 'accepted_with_warnings' | 'rejected'
  readonly issues: readonly SandboxIssue[];
  readonly normalizedManifest?: object;
  readonly bundleHash?: string;
}

/**
 * Runtime-артефакт ошибки sandbox (data-model §7.2; FR-025/026/027).
 * `detail` — bounded (≤ `maxStderrBytes`) + redacted (0 секретов/env/абсолютных host-путей).
 */
export interface SandboxErrorArtifact {
  readonly code: SandboxValidationCode;
  readonly severity: Severity;
  readonly moduleRef: Ref;
  readonly runId: string;
  readonly hook?: LifecycleHook;
  readonly symbol?: string;
  readonly barIndex?: number;
  readonly detail: string;
}

/**
 * Подготовить `detail` для `SandboxErrorArtifact`: redaction (0 секретов/env/абсолютных host-путей,
 * FR-026/SC-011) + bound до `maxBytes` с truncation-маркером (FR-027). Применяется в точке сборки
 * артефакта (host-сторона).
 */
export function boundedRedactedDetail(detail: string, maxBytes: number): string {
  const r = redact(typeof detail === 'string' ? detail : String(detail ?? ''));
  if (r.length <= maxBytes) return r;
  return `${r.slice(0, Math.max(0, maxBytes))}…[truncated]`;
}
