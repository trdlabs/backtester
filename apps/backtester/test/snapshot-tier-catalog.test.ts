// wfo-extended-fixture item 4 (backtester part) — typed, fail-closed reader for the repo-root
// `snapshot-tiers.json`. Two concerns pinned here:
//  1. the MODULE's contract in isolation (missing file / bad JSON / unknown schemaVersion all throw;
//     `requiredTierForDays` picks the minimal sufficient tier; `formatTierHint` renders the hint text)
//     against small inline fixtures — never the committed file.
//  2. the repo-local VALIDITY of the actually-committed `snapshot-tiers.json` (existence,
//     schemaVersion, T2 clears `minWfoHistoryDays`) — the condition control-center's
//     TIER_CATALOG_ADOPTED gate checks for on this side.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatTierHint,
  loadSnapshotTierCatalog,
  requiredTierForDays,
  SnapshotTierCatalogError,
  type SnapshotTierCatalog,
} from '../src/data/snapshot-tier-catalog.js';

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function writeFixture(content: string): string {
  dir = mkdtempSync(join(tmpdir(), 'snapshot-tier-catalog-test-'));
  const path = join(dir, 'snapshot-tiers.json');
  writeFileSync(path, content, 'utf8');
  return path;
}

const VALID: SnapshotTierCatalog = {
  schemaVersion: 'snapshot-tiers.1',
  defaultTier: 'T1',
  minWfoHistoryDays: 30,
  tiers: {
    T0: { ref: 'fixtures/historical-golden', purpose: 'conformance', window: { from: 'a', to: 'b' }, window_minutes: 30, primary_present_minutes: 30, common_present_minutes: 30 },
    T1: { ref: 'fixtures/2026-06-22-to-2026-06-28-vps', purpose: 'demo', window: { from: 'a', to: 'b' }, window_minutes: 10080, primary_present_minutes: 9914, common_present_minutes: 6123 },
    T2: { ref: 'wfo/2026-06-09-to-2026-07-20-vps-wfo42d', purpose: 'wfo', window: { from: 'a', to: 'b' }, window_minutes: 60480, primary_present_minutes: 59893, common_present_minutes: 59893 },
  },
};

describe('loadSnapshotTierCatalog — fail-closed reader', () => {
  it('reads and parses a valid catalog', () => {
    const path = writeFixture(JSON.stringify(VALID));
    expect(loadSnapshotTierCatalog(path)).toEqual(VALID);
  });

  it('throws on a missing file (fail-closed, no silent empty catalog)', () => {
    expect(() => loadSnapshotTierCatalog('/nonexistent/snapshot-tiers.json')).toThrow(SnapshotTierCatalogError);
  });

  it('throws on invalid JSON', () => {
    const path = writeFixture('{ not json');
    expect(() => loadSnapshotTierCatalog(path)).toThrow(SnapshotTierCatalogError);
  });

  it('throws on an unrecognized schemaVersion', () => {
    const path = writeFixture(JSON.stringify({ ...VALID, schemaVersion: 'snapshot-tiers.2' }));
    expect(() => loadSnapshotTierCatalog(path)).toThrow(/schemaVersion/);
  });

  it('throws when required fields are missing', () => {
    const path = writeFixture(JSON.stringify({ schemaVersion: 'snapshot-tiers.1' }));
    expect(() => loadSnapshotTierCatalog(path)).toThrow(SnapshotTierCatalogError);
  });
});

describe('requiredTierForDays — minimal sufficient tier', () => {
  it('30 days ⇒ T2 (only tier clearing the 30d floor)', () => {
    const hit = requiredTierForDays(30, VALID);
    expect(hit?.name).toBe('T2');
  });

  it('4 days ⇒ T1 (smallest tier clearing 4d, not the biggest one available)', () => {
    const hit = requiredTierForDays(4, VALID);
    expect(hit?.name).toBe('T1');
  });

  it('no committed tier clears an absurd requirement ⇒ undefined', () => {
    expect(requiredTierForDays(10_000, VALID)).toBeUndefined();
  });
});

describe('formatTierHint', () => {
  it('renders "<name> (<ref>)"', () => {
    expect(formatTierHint('T2', VALID.tiers.T2)).toBe('T2 (wfo/2026-06-09-to-2026-07-20-vps-wfo42d)');
  });
});

describe('repo-local validity: the COMMITTED snapshot-tiers.json', () => {
  it('exists at repo root and parses under the current schemaVersion', () => {
    const catalog = loadSnapshotTierCatalog();
    expect(catalog.schemaVersion).toBe('snapshot-tiers.1');
  });

  it('T2 clears minWfoHistoryDays (the tier WFO/novelty/holdout up-front checks resolve to)', () => {
    const catalog = loadSnapshotTierCatalog();
    const hit = requiredTierForDays(catalog.minWfoHistoryDays, catalog);
    expect(hit?.name).toBe('T2');
    expect(hit!.tier.common_present_minutes / 1440).toBeGreaterThanOrEqual(catalog.minWfoHistoryDays);
  });
});
