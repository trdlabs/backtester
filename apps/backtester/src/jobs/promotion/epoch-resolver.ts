// E4b — TRUSTED epoch resolver: the epoch identity is server-derived, never a client string. The
// production resolver validates the run's datasetRef against the data port and uses it as the epoch.
import type { JobRow } from '../job-store.js';

export interface QualificationEpochResolver {
  resolve(claimed: JobRow): Promise<{ epochId: string } | null>;
}

interface DatasetLister { listDatasets(): Promise<readonly { readonly datasetRef: string }[]>; }

export class DatasetIdentityEpochResolver implements QualificationEpochResolver {
  constructor(private readonly dataPort: DatasetLister) {}
  async resolve(claimed: JobRow): Promise<{ epochId: string } | null> {
    const datasets = await this.dataPort.listDatasets();
    const found = datasets.find((d) => d.datasetRef === claimed.datasetRef);
    return found ? { epochId: found.datasetRef } : null;
  }
}
