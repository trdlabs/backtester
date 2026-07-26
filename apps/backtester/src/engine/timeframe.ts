// Ф3 (shared-execution-engine, rollout шаг 4) — this module is now an IMPORT of the shared core.
//
// `parseTimeframeMs` moved to `@trdlabs/engine` (`src/core/timeframe.ts`) during the Ф2 extraction,
// ported verbatim from this file. The behaviour is unchanged; the address moved. Do NOT reintroduce
// a local copy: the engine is the single owner of execution semantics (initiative decision
// «one owner of execution semantics»), and a second copy is exactly the two-interpreter drift the
// initiative exists to end.

export { parseTimeframeMs } from '@trdlabs/engine';
