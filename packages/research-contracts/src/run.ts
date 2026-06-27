// Run / result / artifact / validation / capability wire types — re-exported from the canonical
// SDK (@trading-backtester/sdk). This module keeps the historical @trading/research-contracts
// entry stable for existing importers (no import-site churn); the SDK is the single definition
// source. ComparisonSummary is re-exported from ./comparison.ts (itself a thin SDK re-export).

export type {
  RunMode,
  Ref,
  RunPeriod,
  ModuleKind,
  BacktestEngine,
  ModuleManifest,
  ModuleBundle,
  BacktestRunRequest,
  RunSubmitRequest,
  ModuleValidateRequest,
  NonTerminalRunStatus,
  TerminalRunStatus,
  RunStatus,
  RunJobHandle,
  ContentHash,
  RunEvidence,
  RunResultSummary,
  RunTimelineEntry,
  RunStatusView,
  CompletionEventType,
  CompletionEvent,
  GatewayErrorCategory,
  GatewayError,
  ValidationStatus,
  ValidationIssue,
  ValidationReport,
  CapabilityDescriptor,
  DatasetDescriptor,
} from '@trading-backtester/sdk/contracts';

export type {
  ArtifactReference,
  ArtifactDescriptor,
  ArtifactManifest,
  ArtifactPage,
  ArtifactAvailability,
} from '@trading-backtester/sdk/artifacts';
