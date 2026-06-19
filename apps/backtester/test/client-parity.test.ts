// Compile-time guard: the client's VENDORED wire types (packages/client/src/wire.ts) must stay
// structurally identical to the SDK canonical contracts. Any drift flips an AssertEqual to `false`,
// which fails to satisfy the `true`-typed tuple and breaks `pnpm typecheck` (and this test's compile).
// TEMPORARY — this test is deleted after the trading-lab cutover to the SDK package specifier.

import { describe, expect, it } from 'vitest';
import type * as Client from '../../../packages/client/src/index';
import type * as SdkContracts from '../../../packages/sdk/src/contracts/index';
import type * as SdkArtifacts from '../../../packages/sdk/src/artifacts/index';

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const checks: [
  Equal<Client.RunSubmitRequest, SdkContracts.RunSubmitRequest>,
  Equal<Client.RunJobHandle, SdkContracts.RunJobHandle>,
  Equal<Client.RunStatusView, SdkContracts.RunStatusView>,
  Equal<Client.RunResultSummary, SdkContracts.RunResultSummary>,
  Equal<Client.RunEvidence, SdkContracts.RunEvidence>,
  Equal<Client.ModuleBundle, SdkContracts.ModuleBundle>,
  Equal<Client.ModuleManifest, SdkContracts.ModuleManifest>,
  Equal<Client.ArtifactManifest, SdkArtifacts.ArtifactManifest>,
  Equal<Client.ArtifactPage, SdkArtifacts.ArtifactPage>,
  Equal<Client.ArtifactReference, SdkArtifacts.ArtifactReference>,
  Equal<Client.ValidationReport, SdkContracts.ValidationReport>,
  Equal<Client.CapabilityDescriptor, SdkContracts.CapabilityDescriptor>,
  Equal<Client.DatasetDescriptor, SdkContracts.DatasetDescriptor>,
  Equal<Client.CompletionEvent, SdkContracts.CompletionEvent>,
  Equal<Client.Ref, SdkContracts.Ref>,
  Equal<Client.BacktestEngine, SdkContracts.BacktestEngine>,
  Equal<Client.ModuleKind, SdkContracts.ModuleKind>,
] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true];

// Compile-time guard: validateModule must only accept ModuleValidateRequest.
// This function is never called at runtime — it exists solely for the type check.
// If `@ts-expect-error` becomes unused, validateModule drifted back to `unknown`.
function _validateModuleIsTyped(): void {
  const c = null as unknown as Client.BacktesterClient;
  // @ts-expect-error excess property — validateModule must reject unknown-shaped objects
  c.validateModule({ notAValidField: 'bad' });
}

describe('@trading-backtester/client ↔ @trading-backtester/sdk parity', () => {
  it('vendored client wire types are structurally identical to the SDK contracts', () => {
    expect(checks.every((c) => c === true)).toBe(true);
  });
});
