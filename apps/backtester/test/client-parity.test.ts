// Compile-time guard: the client's VENDORED wire types (packages/client/src/wire.ts) must stay
// structurally identical to @trading/research-contracts. Any drift flips an AssertEqual to `false`,
// which fails to satisfy the `true`-typed tuple and breaks `pnpm typecheck` (and this test's compile).

import { describe, expect, it } from 'vitest';
import type * as Client from '../../../packages/client/src/index';
import type * as RC from '@trading/research-contracts';

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const checks: [
  Equal<Client.RunSubmitRequest, RC.RunSubmitRequest>,
  Equal<Client.RunJobHandle, RC.RunJobHandle>,
  Equal<Client.RunStatusView, RC.RunStatusView>,
  Equal<Client.RunResultSummary, RC.RunResultSummary>,
  Equal<Client.RunEvidence, RC.RunEvidence>,
  Equal<Client.ModuleBundle, RC.ModuleBundle>,
  Equal<Client.ModuleManifest, RC.ModuleManifest>,
  Equal<Client.ArtifactManifest, RC.ArtifactManifest>,
  Equal<Client.ArtifactPage, RC.ArtifactPage>,
  Equal<Client.ArtifactReference, RC.ArtifactReference>,
  Equal<Client.ValidationReport, RC.ValidationReport>,
  Equal<Client.CapabilityDescriptor, RC.CapabilityDescriptor>,
  Equal<Client.DatasetDescriptor, RC.DatasetDescriptor>,
  Equal<Client.CompletionEvent, RC.CompletionEvent>,
  Equal<Client.Ref, RC.Ref>,
  Equal<Client.BacktestEngine, RC.BacktestEngine>,
  Equal<Client.ModuleKind, RC.ModuleKind>,
] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true];

// Compile-time guard: validateModule must only accept ModuleValidateRequest.
// This function is never called at runtime — it exists solely for the type check.
// If `@ts-expect-error` becomes unused, validateModule drifted back to `unknown`.
function _validateModuleIsTyped(): void {
  const c = null as unknown as Client.BacktesterClient;
  // @ts-expect-error excess property — validateModule must reject unknown-shaped objects
  c.validateModule({ notAValidField: 'bad' });
}

describe('@trading-backtester/client ↔ @trading/research-contracts parity', () => {
  it('vendored client wire types are structurally identical to the contracts', () => {
    expect(checks.every((c) => c === true)).toBe(true);
  });
});
