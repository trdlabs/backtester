// 018 — публичный вход backtest-пакета (quickstart.md §«Публичный вход»).
// Потребители (verify-скрипты, future orchestration) импортируют только отсюда.

export { runBacktest, type RunDeps } from './runner.js';
export { createTrustedRegistry, type TrustedModuleRegistry, type RegistryInput } from './registry.js';
export {
  DEFAULT_RISK,
  DEFAULT_EXEC,
  LONG_ONLY_RISK,
  TIGHT_STOP_RISK,
  DCA_RISK,
  TIGHT_ADD_RISK,
  UNSUPPORTED_FILL_EXEC,
  SUPPORTED_FILL_MODEL_KINDS,
  type AddLimits,
} from './profiles.js';
export { RiskEngine, type RiskOutcome, type AddPositionContext } from './risk.js';
export { InProcessTrustedModuleExecutor, type ModuleExecutor } from './module-executor.js';
export { OverlayComposer, type OverlayComposition } from './overlay.js';
export { canonicalJson } from '../determinism/canonical-json.js';
export { buildMarketTape, marketTapeFromCanonicalRows } from './market-tape.js';
export { pointInTimeMarketApi } from './market-access.js';
export type {
  BacktestRunResult,
  ComparisonSummary,
  RunOutcome,
  Trade,
  DecisionRecord,
  OverlayEffect,
  SimulatedOrder,
  SimulatedFill,
  EquityPoint,
} from './artifacts.js';
