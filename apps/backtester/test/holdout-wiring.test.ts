// E4a — worker finalize wiring for the held-out marker (resolveHoldoutMarker). Pins the three
// projection branches: flag OFF ⇒ no field; ON + coverage ⇒ resolved; ON + no coverage ⇒ unknown.
// resultHash invariance is STRUCTURAL: finalizeResult computes `resultHash = contentRef(payload)`
// and the marker is merged onto the summary projection AFTER that — never into `payload` — so the
// hash cannot depend on holdout (the flag-OFF path is additionally pinned by the goldens).

import { describe, expect, it } from 'vitest';
import type { DatasetDescriptor } from '@trdlabs/backtester-sdk/contracts';
import type { JobRow } from '../src/jobs/job-store.js';
import { resolveHoldoutMarker, type WorkerDeps } from '../src/jobs/worker.js';

const COVERAGE = { from: '2023-01-01T00:00:00.000Z', to: '2023-01-11T00:00:00.000Z' };
// Run entirely inside the last-20% holdout window [2023-01-09, 2023-01-11).
const RUN_INSIDE = { from: '2023-01-09T12:00:00.000Z', to: '2023-01-10T00:00:00.000Z' };

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
