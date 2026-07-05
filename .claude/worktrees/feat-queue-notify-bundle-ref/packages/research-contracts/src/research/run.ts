// 017 — самодостаточный запрос прогона и форма его результата (FR-024/FR-025, data-model §11/§12).
// 017 валидирует структуру запроса; не исполняет прогон (D10).
//
// `Ref`, `RunPeriod`, `BacktestRunRequest`, `BacktestEngine` — каноническая wire-форма из корневого
// `../run.js` (сервис + клиент зависят от неё). 017-надмножество влито аддитивно в корневой
// `BacktestRunRequest`, поэтому здесь они просто реэкспортируются — единый источник истины.
export type { Ref, RunPeriod, BacktestRunRequest, BacktestEngine } from '../run.js';

/**
 * Evidence bundle прогона (FR-025). 017 определяет ФОРМУ; не производит (прогон — будущий runner).
 */
export interface BacktestRunResult {
  readonly runId: string;
  readonly summary: object;
  readonly metrics: Readonly<Record<string, number>>;
  readonly trades: readonly object[];
  readonly decisionRecords: readonly object[];
  readonly validationIssues: readonly object[];
  readonly artifactRefs: readonly string[];
  readonly evidence: object;
}
