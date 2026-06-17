// 017 — публичный вход валидатора (FR-022, quickstart §«Публичный вход», data-model §13.1).
// Stateless, чистая функция: один и тот же вход + та же contractContext ⇒ идентичный результат
// (SC-004). Дискриминатор `inputKind` — отдельный от ModuleManifest.kind и от kind решений.

import type { ContractContext, ValidationResult } from '@trading/research-contracts/research';

import { createSchemaRegistry, type SchemaRegistry } from './schema-registry.js';
import { validateModule, type ModuleInput } from './validate-module.js';
import { validateRunRequest, type RunRequestInput } from './validate-run-request.js';
import { validatePromotion, type PromotionInput } from './validate-promotion.js';

/** Вход валидатора. Армы: `'module'` (US1/US2), `'run_request'` (US6), `'promotion'` (US7). */
export type ValidationInput =
  | ({ readonly inputKind: 'module' } & ModuleInput)
  | ({ readonly inputKind: 'run_request' } & RunRequestInput)
  | ({ readonly inputKind: 'promotion' } & PromotionInput);

// Реестр схем компилируется один раз (кэш core-схем) и переиспользуется. Чистоту validate()
// это не нарушает: реестр не несёт изменяемого состояния между вызовами для одного входа.
let registrySingleton: SchemaRegistry | undefined;
function registry(): SchemaRegistry {
  return (registrySingleton ??= createSchemaRegistry());
}

/** Провалидировать вход против контракта/каталогов. */
export function validate(input: ValidationInput, contractContext: ContractContext): ValidationResult {
  switch (input.inputKind) {
    case 'module':
      return validateModule(input, contractContext, registry());
    case 'run_request':
      return validateRunRequest(input, contractContext, registry());
    case 'promotion':
      return validatePromotion(input);
    default: {
      const exhaustive: never = input;
      throw new Error(`validate: unsupported inputKind "${String(exhaustive)}"`);
    }
  }
}

export type { ModuleInput } from './validate-module.js';
export type { RunRequestInput } from './validate-run-request.js';
export type { PromotionInput } from './validate-promotion.js';
