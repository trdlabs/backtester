import type { RunMode, RunPeriod } from './run';

export interface CapabilityDescriptor {
  readonly contractVersion: string;
  readonly artifactContractVersion: string;
  readonly supportedMetrics: readonly string[];
  readonly supportedModes: readonly RunMode[];
  readonly maxConcurrency: number;
}

export interface DatasetDescriptor {
  readonly datasetRef: string;
  readonly symbols: readonly string[];
  readonly timeframe: string;
  readonly period: RunPeriod;
  readonly rowCount: number;
}
