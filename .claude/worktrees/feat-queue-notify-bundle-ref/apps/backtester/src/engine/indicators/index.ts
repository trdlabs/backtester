// 020 — публичная поверхность пакета platform-owned Indicator Engine.
//
// Пакет import-closed: runtime-импорты не выходят за пределы `src/research/indicators/`;
// типы из контрактов реэкспортируются через `export type` (стираются при компиляции).

export { createIndicatorEngine } from './engine.js';
export type { IndicatorEngine } from './engine.js';

export { INDICATOR_CATALOG, findDefinition, resolveParams } from './catalog.js';

export { validateIndicatorRequest, IndicatorValidationError } from './validation.js';
export type { IndicatorValidationErrorContext } from './validation.js';

export { canonicalKey } from './key.js';

export { platformNativeAdapter } from './backend/platform-native.js';
export type { IndicatorBackendAdapter, StreamingIndicator } from './backend/adapter.js';

// Контрактные типы (реэкспорт для потребителей; форма — в src/contracts/research/indicators.ts).
export type {
  IndicatorRequest,
  IndicatorValue,
  MacdValue,
  BollingerValue,
  StochasticValue,
  SourceField,
  OutputShape,
  ParamSpec,
  IndicatorDefinition,
  IndicatorCatalog,
  IndicatorValidationCode,
  IndicatorIssue,
  IndicatorValidationResult,
} from '@trading/research-contracts/research';
