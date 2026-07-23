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
// A 7-day request period, still well within COVERAGE and the holdout window — used (fix wave) to
// prove a SHORT REQUEST against a well-covered dataset resolves normally (the marker no longer keys
// on request span at all).
const RUN_SHORT = { from: new Date(COVERAGE_FROM_MS + 165 * DAY).toISOString(), to: new Date(COVERAGE_FROM_MS + 172 * DAY).toISOString() };
// A 12-hour request period, inside the holdout window — the extreme "short request" case the fix
// wave adds explicitly: dataset coverage (200d) is what sizing keys on, not this ~0.5-day span.
const RUN_VERY_SHORT = {
  from: new Date(COVERAGE_FROM_MS + 180 * DAY).toISOString(),
  to: new Date(COVERAGE_FROM_MS + 180 * DAY + 12 * 60 * 60 * 1000).toISOString(),
};
// A dataset whose OWN coverage (7 days) is below the 30-day `minWfoHistoryDays` floor — too small for
// a meaningful holdout reserve regardless of the request period.
const NARROW_COVERAGE = { from: new Date(COVERAGE_FROM_MS).toISOString(), to: new Date(COVERAGE_FROM_MS + 7 * DAY).toISOString() };

function claimed(datasetRef = 'ds-1', period = RUN_INSIDE): JobRow {
  return { datasetRef, request: { period } } as unknown as JobRow;
}

function deps(over: Partial<WorkerDeps>, coverage = COVERAGE): WorkerDeps {
  const descriptor: DatasetDescriptor = {
    datasetRef: 'ds-1',
    symbols: ['BTCUSDT'],
    timeframe: '1m',
    period: coverage,
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

// wfo-extended-fixture item 4 (fix wave) — up-front sufficiency check keyed on the DATASET's coverage
// span (fetched via listDatasets, which now always runs first), NOT the request's own span. The
// marker's job is reporting whether the REQUEST intrudes into the dataset's reserved holdout tail, so
// a short request against a well-covered dataset must resolve normally — only a dataset whose own
// coverage is too narrow trips the check.
describe('resolveHoldoutMarker — up-front insufficient_history (keyed on dataset coverage, not request span)', () => {
  it('7-day request period against the 200-day-covered dataset ⇒ resolves normally (fix wave regression: request span alone no longer short-circuits)', async () => {
    const d = deps({ holdout: { enabled: true, fraction: 0.2 } });
    let listDatasetsCalls = 0;
    const baseListDatasets = (d.dataPort as { listDatasets: () => Promise<DatasetDescriptor[]> }).listDatasets;
    (d.dataPort as { listDatasets: () => Promise<DatasetDescriptor[]> }).listDatasets = async () => {
      listDatasetsCalls += 1;
      return baseListDatasets();
    };
    const m = await resolveHoldoutMarker(d, claimed('ds-1', RUN_SHORT));
    expect(m).toMatchObject({ status: 'resolved', containment: 'full' });
    expect(listDatasetsCalls).toBe(1);
  });

  it('12-hour request period against the 200-day-covered dataset ⇒ resolved marker with correct containment (explicit short-request-on-big-dataset case)', async () => {
    const m = await resolveHoldoutMarker(deps({ holdout: { enabled: true, fraction: 0.2 } }), claimed('ds-1', RUN_VERY_SHORT));
    expect(m).toMatchObject({ status: 'resolved', policy: 'coverage_fraction', fraction: 0.2, containment: 'full' });
  });

  it('any request period against a 7-day-covered dataset ⇒ unknown:insufficient_history with requiredDays + a T2 hint, naming the DATASET as too small', async () => {
    const d = deps({ holdout: { enabled: true, fraction: 0.2 } }, NARROW_COVERAGE);
    // RUN_INSIDE spans 30 days on its own — well over the floor — yet the dataset's OWN 7-day
    // coverage is what must trip the check, proving the comparison target changed.
    const m = await resolveHoldoutMarker(d, claimed('ds-1', RUN_INSIDE));
    expect(m).toMatchObject({ status: 'unknown', reason: 'insufficient_history', requiredDays: 30 });
    expect((m as { requiredTier?: string }).requiredTier).toContain('T2');
  });

  it('30-day request period against the 200-day-covered dataset ⇒ still resolves as before', async () => {
    const m = await resolveHoldoutMarker(deps({ holdout: { enabled: true, fraction: 0.2 } }), claimed());
    expect(m).toMatchObject({ status: 'resolved', containment: 'full' });
  });

  it('unknown dataset ⇒ coverage_not_found unchanged, even though request span would otherwise be insufficient', async () => {
    const m = await resolveHoldoutMarker(
      deps({ holdout: { enabled: true, fraction: 0.2 } }),
      claimed('unmatched-ds', RUN_VERY_SHORT),
    );
    expect(m).toEqual({ status: 'unknown', reason: 'coverage_not_found' });
  });
});
