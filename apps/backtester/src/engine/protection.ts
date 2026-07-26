// Ф3 (shared-execution-engine, rollout шаг 4) — this module is now an IMPORT of the shared core.
//
// The intrabar protection detector moved to `@trdlabs/engine` (`src/core/protection.ts`) during the
// Ф2 extraction, ported verbatim (behaviour) from this file: fractional stop/take DISTANCES from the
// average entry, intrabar detection on `high`/`low`, stop-first when one bar touches both (SSOT
// decision 10), gap-through `fillBase`. No local copy — the engine owns execution semantics.

export { detectProtection, protectionLevels } from '@trdlabs/engine';
export type { ProtectionHit, ProtectionLevels } from '@trdlabs/engine';
