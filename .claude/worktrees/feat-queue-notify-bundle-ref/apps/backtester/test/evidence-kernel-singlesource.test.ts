// apps/backtester/test/evidence-kernel-singlesource.test.ts
// 042 tripwire for the evidence path: the bundle validation the harness relies on MUST delegate to the
// same @trading-platform/sdk/validation kernel the platform admission uses — not a parallel copy.
//
// Adjustment from brief: instead of `manifest: {}` (all fields missing / structure junk), we use the
// module-missing-params-schema fixture manifest — a well-formed strategy manifest that omits `paramsSchema`
// (required by FR-034). This confirms the full validation path runs and produces a real, named issue
// rather than a generic "schema is empty" short-circuit, making the agreement assertion non-vacuous.
import { describe, expect, it } from 'vitest';
import { validate as appValidate, type ValidationInput } from '../src/engine/validation/index.js';
import { validate as kernelValidate } from '@trading-platform/sdk/validation';
import { platformContractContext } from '@trading/research-contracts/research';

describe('evidence path uses the single-source validation kernel (042)', () => {
  it('app-validator and SDK kernel agree on a representative module input', () => {
    const ctx = platformContractContext([]);
    // Strategy manifest with all required structural fields present but `paramsSchema` deliberately
    // omitted — mirrors the kernel-equivalence/invalid/module-missing-params-schema.json fixture.
    // Both validators must return status:'invalid' + at least one issue, proving real validation ran.
    const input = {
      inputKind: 'module',
      manifest: {
        id: 'tripwire_no_params_schema',
        version: '0.1.0',
        kind: 'strategy',
        name: 'Tripwire: missing paramsSchema',
        summary: 'Drift tripwire — paramsSchema omitted to force a real validation issue.',
        rationale: 'FR-034 requires paramsSchema; omitting it proves the validator runs the full strategy path.',
        author: 'agent',
        contractVersion: '017.1',
        status: 'research_only',
        params: { pumpPct: 10 },
        capabilities: { platformSdk: true },
        dataNeeds: { closedCandlesUpToCurrent: true },
        hooks: ['onBarClose'],
      },
    } as unknown as ValidationInput;

    const app = appValidate(input, ctx);
    const kernel = kernelValidate(input as never, ctx as never);

    // Non-vacuous guard: both validators must have actually produced at least one issue —
    // proves the full module-validation path executed, not a trivial no-op.
    expect(app.issues.length).toBeGreaterThan(0);

    // Drift assertion: if app-validator ever diverges from the SDK kernel
    // (e.g. someone replaces the re-export with a local copy), this MUST fail.
    // Fix the divergence before signing — do not skip this gate.
    expect(kernel.status).toBe(app.status);
    expect(kernel.issues.map((i: { code: string }) => i.code).sort())
      .toEqual(app.issues.map((i) => i.code).sort());
  });
});
