// wfo-extended-fixture item 4 (backtester part) — typed, fail-closed reader for the repo-root
// `snapshot-tiers.json`: the committed manifest of fixture "tiers" (T0 conformance / T1 demo-default /
// T2 the only tier clearing the WFO 30-day floor) that control-center's `pnpm sync` generates from
// `ecosystem-defaults.yaml`. This module ONLY reads it — never edit or reformat the file by hand.
//
// Fail-closed: a missing file, invalid JSON, an unrecognized `schemaVersion`, or a missing required
// field all THROW `SnapshotTierCatalogError` — never a silent empty/partial catalog. Callers that need
// advisory (never-reject) behavior — the up-front history check in `engine/required-history.ts` — are
// responsible for catching and degrading themselves; this module's job is to be loud when the catalog
// itself is broken, not to decide how a caller should cope with that.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// apps/backtester/src/data -> repo root is four levels up (src -> backtester -> apps -> root).
const DEFAULT_CATALOG_PATH = resolve(HERE, '../../../../snapshot-tiers.json');
const SUPPORTED_SCHEMA_VERSION = 'snapshot-tiers.1';

export class SnapshotTierCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotTierCatalogError';
  }
}

export interface SnapshotTierWindow {
  readonly from: string;
  readonly to: string;
}

export interface SnapshotTier {
  readonly ref: string;
  readonly purpose: string;
  readonly window: SnapshotTierWindow;
  readonly window_minutes: number;
  readonly primary_present_minutes: number;
  readonly common_present_minutes: number;
}

export interface SnapshotTierCatalog {
  readonly schemaVersion: string;
  readonly defaultTier: string;
  readonly minWfoHistoryDays: number;
  readonly tiers: Readonly<Record<string, SnapshotTier>>;
}

function isTier(value: unknown): value is SnapshotTier {
  if (typeof value !== 'object' || value === null) return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.ref === 'string' &&
    typeof t.common_present_minutes === 'number' &&
    typeof t.window_minutes === 'number' &&
    typeof t.primary_present_minutes === 'number'
  );
}

function assertShape(parsed: unknown, path: string): asserts parsed is SnapshotTierCatalog {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new SnapshotTierCatalogError(`snapshot-tiers.json at ${path} is not a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    throw new SnapshotTierCatalogError(
      `snapshot-tiers.json at ${path} has unknown schemaVersion ${JSON.stringify(obj.schemaVersion)} ` +
        `(expected ${JSON.stringify(SUPPORTED_SCHEMA_VERSION)})`,
    );
  }
  if (typeof obj.minWfoHistoryDays !== 'number') {
    throw new SnapshotTierCatalogError(`snapshot-tiers.json at ${path} is missing numeric "minWfoHistoryDays"`);
  }
  if (typeof obj.tiers !== 'object' || obj.tiers === null) {
    throw new SnapshotTierCatalogError(`snapshot-tiers.json at ${path} is missing a "tiers" object`);
  }
  for (const [name, tier] of Object.entries(obj.tiers as Record<string, unknown>)) {
    if (!isTier(tier)) {
      throw new SnapshotTierCatalogError(`snapshot-tiers.json at ${path}: tier "${name}" is missing required fields`);
    }
  }
}

/**
 * Read + parse + validate `snapshot-tiers.json`. Fail-closed: throws `SnapshotTierCatalogError` on a
 * missing file, invalid JSON, an unrecognized `schemaVersion`, or a malformed tier — never returns a
 * partial/empty catalog. `path` defaults to the repo root; overridable (tests only).
 */
export function loadSnapshotTierCatalog(path: string = DEFAULT_CATALOG_PATH): SnapshotTierCatalog {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new SnapshotTierCatalogError(`snapshot-tiers.json not found at ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SnapshotTierCatalogError(`snapshot-tiers.json at ${path} is not valid JSON: ${(err as Error).message}`);
  }
  assertShape(parsed, path);
  return parsed;
}

/**
 * The minimal tier whose `common_present_minutes` clears `days` (1440 min/day). `undefined` when no
 * committed tier clears it. "Minimal" = smallest SUFFICIENT coverage, not the largest tier available
 * (e.g. for a 4-day requirement this picks T1 over the much larger T2).
 */
export function requiredTierForDays(
  days: number,
  catalog: SnapshotTierCatalog = loadSnapshotTierCatalog(),
): { name: string; tier: SnapshotTier } | undefined {
  const sufficient = Object.entries(catalog.tiers)
    .filter(([, tier]) => tier.common_present_minutes / 1440 >= days)
    .sort((a, b) => a[1].common_present_minutes - b[1].common_present_minutes);
  const hit = sufficient[0];
  return hit ? { name: hit[0], tier: hit[1] } : undefined;
}

/** Human-readable hint: `T2 (wfo/2026-06-09-to-2026-07-20-vps-wfo42d)`. */
export function formatTierHint(name: string, tier: SnapshotTier): string {
  return `${name} (${tier.ref})`;
}
