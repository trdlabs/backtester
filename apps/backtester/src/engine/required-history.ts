// wfo-extended-fixture item 4 (backtester part) — pure required-history sizing for the up-front
// fail-fast that the three advisory resolvers (resolveWalkForward / resolveNovelty /
// resolveHoldoutMarker, worker.ts) run BEFORE each subsystem's HEAVY work (running WFO sandbox folds,
// querying the novelty pool, or computing holdout containment). Today those subsystems degrade
// silently deep in the contour (`insufficient_folds`, `insufficient_overlap`, `coverage_not_found`)
// without ever saying HOW MUCH history was needed or WHICH committed fixture tier provides it — this
// module is the "how much" half; `checkSufficientHistory` is the shared comparison the three resolvers
// each call with their own subsystem-specific `requiredXDays`.
//
// The three resolvers key the comparison on different spans, matched to what each subsystem's
// requirement is actually about: WFO and novelty key on the REQUEST's own period span (they size
// against what the request itself asks to run); holdout keys on the DATASET's coverage span instead
// (fix wave — the holdout marker reports whether the request intrudes into the dataset's reserved
// tail, so a short request against a well-covered dataset is legitimate and must NOT short-circuit —
// only a dataset that is itself too small trips the check). Holdout's check therefore runs AFTER the
// (already-unconditional) coverage fetch, still BEFORE the containment math.
//
// Advisory, NOT part of the hashed result: a caller that can't determine sufficiency (unparseable
// timeframe/period, or a broken tier catalog) gets `null`/`undefined` back — never a throw — so the
// existing deep checks remain the single safety net and a run is NEVER rejected because this module
// couldn't size the requirement.

import type { RunPeriod } from '@trdlabs/backtester-sdk/contracts';
import { findDefinition, INDICATOR_CATALOG, resolveParams } from './indicators/catalog.js';
import { parseTimeframeMs } from './timeframe.js';
import { formatTierHint, loadSnapshotTierCatalog, requiredTierForDays } from '../data/snapshot-tier-catalog.js';

const DAY_MS = 86_400_000;

/**
 * The default indicator-warmup floor the WFO up-front check sizes against: MACD(12,26,9) ⇒
 * slow+signal-1 = 34 bars. Read LIVE from the committed catalog (engine/indicators/catalog.ts) rather
 * than hardcoded, so a catalog change can never silently desync this estimate from the real warmup.
 */
function defaultWarmupBars(): number {
  const macd = findDefinition(INDICATOR_CATALOG, 'macd');
  // Unreachable in practice — INDICATOR_CATALOG always carries 'macd' (the committed 8). Hold the
  // documented default rather than throw if it ever doesn't; this is an advisory size estimate.
  if (!macd) return 34;
  return macd.warmup(resolveParams(macd, undefined));
}

/**
 * Bars needed for `folds` WFO folds — `splitWalkForward` partitions the period into `folds+1` equal
 * segments and every segment must clear one indicator warmup — converted to WALL-CLOCK DAYS at
 * `timeframe`'s cadence. `null` when `timeframe` is unparseable (fail-open: the up-front check is
 * skipped and the deep per-fold execution stays the source of truth).
 */
export function requiredWalkForwardDays(timeframe: string, folds: number): number | null {
  const timeframeMs = parseTimeframeMs(timeframe);
  if (timeframeMs === null) return null;
  const bars = (folds + 1) * defaultWarmupBars();
  return Math.ceil((bars * timeframeMs) / DAY_MS);
}

/**
 * Novelty's requirement IS its configured overlap floor (`noveltyMinOverlapDays`) — no derivation.
 * Kept as a named function for symmetry with the other two subsystems and so call sites read
 * declaratively instead of passing the config value straight through.
 */
export function requiredNoveltyDays(minOverlapDays: number): number {
  return minOverlapDays;
}

/**
 * Holdout has no per-request formula: `minWfoHistoryDays` from the tier catalog is the floor below
 * which neither `(1-holdoutFraction)*span` nor `holdoutFraction*span` is a meaningful split. Compared
 * against the DATASET's coverage span (not the request's — see the module comment), so this is really
 * asking "is this dataset itself big enough to reserve a meaningful holdout tail from". Falls back to
 * the committed default (30) if the catalog can't be read, so an up-front check that can't reach the
 * catalog still uses the INTENDED floor rather than 0 (never a false "sufficient").
 */
export function requiredHoldoutDays(): number {
  try {
    return loadSnapshotTierCatalog().minWfoHistoryDays;
  } catch {
    return 30;
  }
}

export interface InsufficientHistory {
  readonly requiredDays: number;
  readonly requiredTier: string;
}

/** `null` for a missing/unparseable/non-increasing period — NOT this module's concern; submit-time
 *  validation and `periodMs` (worker.ts) already fail-fast on that elsewhere. The explicit `null`/
 *  `undefined` guard is defensive: `RunPeriod` is a required field on `BacktestRunRequest`, but test
 *  doubles built with `as unknown as ...` casts can still omit it at runtime. */
function periodSpanDays(period: RunPeriod | null | undefined): number | null {
  if (period == null) return null;
  const fromMs = Date.parse(period.from);
  const toMs = Date.parse(period.to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return null;
  return (toMs - fromMs) / DAY_MS;
}

/**
 * Compare a period's span against `requiredDays`. The caller decides WHICH period: the run request's
 * own period for WFO/novelty, or the dataset's coverage period for holdout (see the module comment) —
 * this function only does the arithmetic. `undefined` means "not insufficient" — covers the
 * genuinely-sufficient case, "can't tell" (malformed period), AND `requiredDays === null` (the
 * caller's own sizing function — e.g. `requiredWalkForwardDays` on an unparseable timeframe — couldn't
 * size a requirement, so there is nothing to compare against). A broken/missing tier catalog degrades
 * the SAME WAY here too, though `requiredDays` is still reported with a best-effort tier hint. Never
 * throws: a caller (the three worker.ts resolvers) gets an advisory signal, not a new failure mode.
 */
export function checkSufficientHistory(
  period: RunPeriod | null | undefined,
  requiredDays: number | null,
): InsufficientHistory | undefined {
  if (requiredDays === null) return undefined;
  const span = periodSpanDays(period);
  if (span === null || span >= requiredDays) return undefined;
  let requiredTier: string;
  try {
    const hit = requiredTierForDays(requiredDays);
    requiredTier = hit ? formatTierHint(hit.name, hit.tier) : `>= ${requiredDays}d (no committed tier covers it)`;
  } catch {
    requiredTier = `>= ${requiredDays}d`; // catalog unreadable — still report the day count, just no tier name
  }
  return { requiredDays, requiredTier };
}
