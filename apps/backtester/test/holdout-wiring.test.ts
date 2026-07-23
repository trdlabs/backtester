// E4a — worker finalize wiring for the held-out marker (resolveHoldoutMarker). Pins the three
// projection branches: flag OFF ⇒ no field; ON + coverage ⇒ resolved; ON + no coverage ⇒ unknown.
// resultHash invariance is STRUCTURAL: finalizeResult computes `resultHash = contentRef(payload)`
// and the marker is merged onto the summary projection AFTER that — never into `payload` — so the
// hash cannot depend on holdout (the flag-OFF path is additionally pinned by the goldens).
//
// wfo-extended-fixture item 4 added an up-front (BEFORE listDatasets) history check keyed on
// `claimed.request.period`'s OWN span vs `requiredHoldoutDays()` (30, the catalog's `minWfoHistoryDays`
// floor). COVERAGE/RUN_INSIDE below are sized to a 200-day span so RUN_INSIDE can be BOTH >=30 days
// (clears the up-front check) AND fully inside the last-20% holdout window (still exercises the
// pre-existing deep containment/overlap logic unchanged).

import { describe, expect, it } from 'vitest';
import type { DatasetDescriptor } from '@trdlabs/backtester-sdk/contracts';
import type { JobRow } from '../src/jobs/job-store.js';
import { resolveHoldoutMarker, type WorkerDeps } from '../src/jobs/worker.js';

const DAY = 86_400_000;
const COVERAGE_FROM_MS = Date.parse('2023-01-01T00:00:00.000Z');
const COVERAGE = { from: new Date(COVERAGE_FROM_MS).toISOString(), to: new Date(COVERAGE_FROM_MS + 200 * DAY).toISOString() };
// Holdout window (fraction 0.2 of the 200-day coverage) = last 40 days: [day160, day200].
// RUN_INSIDE: a 30-day request period fully inside that window (day165..day195).
const RUN_INSIDE = { from: new Date(COVERAGE_FROM_MS + 165 * DAY).toISOString(), to: new Date(COVERAGE_FROM_MS + 195 * DAY).toISOString() };
// A 7-day request period ⇒ short of the 30-day floor, regardless of dataset coverage.
const RUN_SHORT = { from: new Date(COVERAGE_FROM_MS + 165 * DAY).toISOString(), to: new Date(COVERAGE_FROM_MS + 172 * DAY).toISOString() };

function claimed(datasetRef = 'ds-1', period = RUN_INSIDE): JobRow {
  return { datasetRef, request: { period } } as unknown as JobRow;
}

function deps(over: Partial<WorkerDeps>): WorkerDeps {
  const descriptor: DatasetDescriptor = {
    datasetRef: 'ds-1',
    symbols: ['BTCUSDT'],
    timeframe: '1m',
    period: COVERAGE,
    rowCount: 100,
  };
  return {
    dataPort: { listDatasets: async () => [descriptor], openDataset: async () => undefined },
    ...over,
  } as unknown as WorkerDeps;
}

describe('resolveHoldoutMarker — E4a worker wiring', () => {
  it('flag OFF ⇒ undefined (summary carries no holdout field)', async () => {
    expect(await resolveHoldoutMarker(deps({}), claimed())).toBeUndefined();
  });

  it('flag ON + dataset coverage found ⇒ resolved marker', async () => {
    const m = await resolveHoldoutMarker(deps({ holdout: { enabled: true, fraction: 0.2 } }), claimed());
    expect(m).toMatchObject({
      status: 'resolved',
      policy: 'coverage_fraction',
      fraction: 0.2,
      coverage: COVERAGE,
      overlaps: true,
      containment: 'full',
    });
  });

  it('flag ON + dataset coverage not found ⇒ unknown marker', async () => {
    const m = await resolveHoldoutMarker(
      deps({ holdout: { enabled: true, fraction: 0.2 } }),
      claimed('unmatched-ds'),
    );
    expect(m).toEqual({ status: 'unknown', reason: 'coverage_not_found' });
  });

  it('flag ON + listDatasets throws ⇒ unknown marker (fail-open, no crash)', async () => {
    const d = deps({ holdout: { enabled: true, fraction: 0.2 } });
    (d.dataPort as { listDatasets: () => Promise<DatasetDescriptor[]> }).listDatasets = async () => {
      throw new Error('port down');
    };
    expect(await resolveHoldoutMarker(d, claimed())).toEqual({ status: 'unknown', reason: 'coverage_not_found' });
  });
});

// wfo-extended-fixture item 4 — up-front (BEFORE listDatasets) history sufficiency check.
describe('resolveHoldoutMarker — up-front insufficient_history (before listDatasets is called)', () => {
  it('7-day request period ⇒ unknown:insufficient_history with requiredDays + a T2 hint, listDatasets never called', async () => {
    const d = deps({ holdout: { enabled: true, fraction: 0.2 } });
    let listDatasetsCalls = 0;
    (d.dataPort as { listDatasets: () => Promise<DatasetDescriptor[]> }).listDatasets = async () => {
      listDatasetsCalls += 1;
      return [];
    };
    const m = await resolveHoldoutMarker(d, claimed('ds-1', RUN_SHORT));
    expect(m).toMatchObject({ status: 'unknown', reason: 'insufficient_history', requiredDays: 30 });
    expect((m as { requiredTier?: string }).requiredTier).toContain('T2');
    expect(listDatasetsCalls).toBe(0);
  });

  it('30-day request period (>= the floor) ⇒ passes the up-front check, falls through to the deep coverage lookup as before', async () => {
    const m = await resolveHoldoutMarker(deps({ holdout: { enabled: true, fraction: 0.2 } }), claimed());
    expect(m).toMatchObject({ status: 'resolved', containment: 'full' });
  });
});
