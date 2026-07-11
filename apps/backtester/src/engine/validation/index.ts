// 017 валидатор — единый источник: делегирует в kernel @trdlabs/sdk/validation (042 FU3).
// Логика validate() (module/run_request/promotion) живёт в kernel; backtester её НЕ дублирует.
// Поведенческая идентичность зафиксирована equivalence-харнессом (validator-kernel-equivalence.test.ts).
// schema-registry / codes / assemble остаются локально — это runtime-утилиты движка
// (decision-revalidator / overlay / errors), не дубль контракта.
export { validate } from '@trdlabs/sdk/validation';
export type {
  ValidationInput,
  ModuleInput,
  RunRequestInput,
  PromotionInput,
} from '@trdlabs/sdk/validation';
