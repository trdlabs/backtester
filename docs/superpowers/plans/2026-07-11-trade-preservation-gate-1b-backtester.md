# Trade-Preservation Gate — Slice 1b-backtester Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the backtester persist an additive `baseline-trades` artifact on comparison (baseline-vs-variant) runs so downstream consumers (trading-lab) can fetch baseline per-trade records for the trade-preservation gate.

**Architecture:** In `persistOverlayArtifacts`, when a comparison exists (`outcome.comparison != null`), emit one extra content-hash-addressed artifact `baseline-trades` carrying `outcome.baseline.trades` (currently computed then discarded). Bump `ARTIFACT_CONTRACT_VERSION` minor (`022.1 → 022.2`, additive). The change is backward-compatible: old consumers ignore the unknown descriptor; new consumers key on a named artifact-type constant.

**Tech Stack:** TypeScript, Vitest (`vitest run`), pnpm. This is the `backtester` repo only.

**Spec:** `trading-lab` repo `docs/superpowers/specs/2026-07-11-trade-preservation-gate-1b-design.md` §3 + §7. This is the FIRST of two slices (`1b-backtester` here, then `1b-lab`). Slice 1a (trading-lab revision lane) is already shipped.

## Global Constraints

- **Backtester imports carry NO file extension** (e.g. `from './store'`, `from '../engine/artifacts'`) — repo convention. Do NOT add `.ts`/`.js`.
- **Tests:** `pnpm test` (`vitest run`). Single file: `pnpm test <path>`. Convention: `import { describe, it, expect } from 'vitest'`, tests under `apps/backtester/test/`.
- **Typecheck/full check:** `pnpm typecheck` (`tsc --noEmit -p tsconfig.json`); `pnpm check` = typecheck + test.
- **Exact artifact-type value:** `'baseline-trades'`, declared as a named constant `BASELINE_TRADES` — never inline the bare string.
- **Guard signal (single source of truth):** gate the baseline-trades artifact on `outcome.comparison != null` (the SAME signal the existing `comparison` artifact uses). Do NOT introduce `outcome.variant != null` as a second signal.
- **Additive only:** existing per-artifact `contentHash`es must be unchanged; no descriptor removed/renamed. `ARTIFACT_CONTRACT_VERSION` bump is minor (`022.2`).
- **Semantics:** baseline-trades descriptor present ⇒ comparison run on new backtester (payload may be `[]` = baseline genuinely had zero trades). Descriptor ABSENT ⇒ non-comparison run or old backtester (feature unavailable). Never emit an empty artifact to mean "unavailable".

---

### Task 1: Version bump + consumer compatibility audit (MANDATORY FIRST — rollout gate)

**Files:**
- Modify: `packages/sdk/src/internal/versions.ts` (line 3: `ARTIFACT_CONTRACT_VERSION`)
- Modify: `packages/research-contracts/src/index.ts` (line 12: `ARTIFACT_CONTRACT_VERSION`)
- Modify: `docs/ARCHITECTURE.md` (parity-anchor line naming `ARTIFACT_CONTRACT_VERSION`)
- Create: `scripts/verify-lab-sdk-version-tolerance.mjs`
- Test: `apps/backtester/test/contract-merge-guard.test.ts` (existing — must stay green)

**Interfaces:**
- Produces: `ARTIFACT_CONTRACT_VERSION === '022.2'` (both packages in sync).

**Why first:** trading-lab consumes the backtester SDK as a pinned release tarball (`@trading-backtester/sdk` v0.7.0). A minor `artifactContractVersion` bump must not cause lab's pinned client to reject manifests. This task locks that.

- [ ] **Step 1: Confirm the current values and the sync guard**

Run: `grep -rn "ARTIFACT_CONTRACT_VERSION = " packages/`
Expected: two definitions, both `'022.1'` — `packages/sdk/src/internal/versions.ts` and `packages/research-contracts/src/index.ts`.

Run: `pnpm test apps/backtester/test/contract-merge-guard.test.ts`
Expected: PASS (baseline — this guard asserts contract constants stay consistent across packages).

- [ ] **Step 2: Write the compatibility audit script**

Create `scripts/verify-lab-sdk-version-tolerance.mjs`:

```js
// Rollout gate for slice 1b: confirm trading-lab's PINNED @trading-backtester/sdk client does not
// strict-reject a manifest carrying a bumped artifactContractVersion (022.1 -> 022.2). The
// baseline-trades artifact + version bump are additive; lab must tolerate the newer version.
// This inspects lab's actually-vendored SDK, not the backtester source (which is ahead at 0.8.0).
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const LAB_SDK = '/home/alexxxnikolskiy/projects/trdlabs/lab/node_modules/@trading-backtester/sdk';
if (!existsSync(LAB_SDK)) {
  console.error(`FAIL: lab vendored SDK not found at ${LAB_SDK} — run pnpm install in trading-lab first`);
  process.exit(2);
}

// Every occurrence of artifactContractVersion in the vendored SDK. The manifest read path
// (getArtifactManifest / readArtifact) must NOT throw or reject on a version mismatch.
let hits = '';
try {
  hits = execSync(`grep -rn "artifactContractVersion" ${LAB_SDK}/dist ${LAB_SDK}/src 2>/dev/null || true`, { encoding: 'utf8' });
} catch { /* grep exit 1 = no matches */ }

console.log('--- artifactContractVersion occurrences in lab vendored SDK ---');
console.log(hits || '(none)');

// Heuristic gate: fail if any occurrence looks like a strict rejection in a read path
// (a throw/return-error guarded by an artifactContractVersion comparison). A human/agent must
// confirm from the printed occurrences that the manifest getter passes the version through.
const suspicious = hits.split('\n').filter((l) =>
  /artifactContractVersion/.test(l) && /(throw|reject|!==|!=|assert|Unsupported|incompatible)/i.test(l),
);
if (suspicious.length > 0) {
  console.error('\nPOTENTIAL STRICT VERSION CHECK — inspect these before bumping:');
  console.error(suspicious.join('\n'));
  process.exit(1);
}
console.log('\nPASS: no strict artifactContractVersion rejection found in lab vendored SDK read path.');
```

- [ ] **Step 3: Run the audit against the current (unbumped) state**

Run: `node scripts/verify-lab-sdk-version-tolerance.mjs`
Expected: prints occurrences and `PASS` (user pre-verified: lab's `getArtifactManifest` returns manifest JSON with no strict version gate). If it prints `POTENTIAL STRICT VERSION CHECK`, STOP and report BLOCKED — the bump would break lab and the spec's fallback (keep 022.1 / re-pin lab) must be chosen with the human.

- [ ] **Step 4: Bump the version in both packages**

`packages/sdk/src/internal/versions.ts` line 3:
```ts
export const ARTIFACT_CONTRACT_VERSION = '022.2' as const;
```
`packages/research-contracts/src/index.ts` line 12:
```ts
export const ARTIFACT_CONTRACT_VERSION = '022.2';
```
`docs/ARCHITECTURE.md`: update the parity-anchor line that reads `ARTIFACT_CONTRACT_VERSION` (`022.1`) → (`022.2`).

- [ ] **Step 5: Verify the sync guard + typecheck still pass**

Run: `pnpm test apps/backtester/test/contract-merge-guard.test.ts && pnpm typecheck`
Expected: PASS (both constants now `022.2`, in sync; types clean).

If `contract-merge-guard.test.ts` hardcodes the expected version string, update that expectation to `022.2` (it is a contract-sync assertion, not a behavior test).

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/internal/versions.ts packages/research-contracts/src/index.ts docs/ARCHITECTURE.md scripts/verify-lab-sdk-version-tolerance.mjs apps/backtester/test/contract-merge-guard.test.ts
git commit -m "chore(contract): bump ARTIFACT_CONTRACT_VERSION 022.1->022.2 + lab-SDK tolerance audit"
```

---

### Task 2: `BASELINE_TRADES` constant + writer

**Files:**
- Modify: `apps/backtester/src/artifacts/overlay-store.ts` (`persistOverlayArtifacts`, ~line 21; add constant near top)
- Test: `apps/backtester/test/overlay-store.test.ts` (new)

**Interfaces:**
- Consumes: `RunOutcome` completed shape — `{ status: 'completed', baseline: BacktestRunResult, variant: BacktestRunResult | null, comparison: ComparisonSummary | null }` (`apps/backtester/src/engine/artifacts.ts`). `BacktestRunResult.trades: Trade[]`; each `Trade` carries `closeReason` (incl. `'end_of_data'`).
- Produces: exported `const BASELINE_TRADES = 'baseline-trades'`; a `baseline-trades` descriptor in the overlay manifest when `outcome.comparison != null`.

- [ ] **Step 1: Write the failing test** — create `apps/backtester/test/overlay-store.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { persistOverlayArtifacts, BASELINE_TRADES } from '../src/artifacts/overlay-store';
import type { ArtifactStore } from '../src/artifacts/store';
import type { RunOutcome } from '../src/engine/artifacts';

// In-memory ArtifactStore: content hash = deterministic index; records every payload.
function fakeStore(): { store: ArtifactStore; written: unknown[] } {
  const written: unknown[] = [];
  const store: ArtifactStore = {
    write: async (payload: unknown) => { written.push(payload); return `hash-${written.length - 1}`; },
  } as unknown as ArtifactStore;
  return { store, written };
}

function runResult(runId: string, trades: unknown[]) {
  return {
    runId, status: 'completed', runKind: 'overlay',
    metrics: {}, evidence: { contractVersion: 'x' }, trades, decisionRecords: [],
  } as never;
}

function comparisonOutcome(baselineTrades: unknown[]): Extract<RunOutcome, { status: 'completed' }> {
  return {
    status: 'completed',
    baseline: runResult('base', baselineTrades),
    variant: runResult('base::variant', [{ entryTs: 1, exitTs: 2, side: 'long', realizedPnl: 1, closeReason: 'take_hit' }]),
    comparison: { baselineRunId: 'base', variants: [] } as never,
  };
}

function nonComparisonOutcome(): Extract<RunOutcome, { status: 'completed' }> {
  return {
    status: 'completed',
    baseline: runResult('base', [{ entryTs: 1, exitTs: 2, side: 'long', realizedPnl: 1, closeReason: 'take_hit' }]),
    variant: null,
    comparison: null,
  };
}

describe('persistOverlayArtifacts baseline-trades', () => {
  it('emits a baseline-trades descriptor carrying baseline.trades on a comparison run', async () => {
    const { store } = fakeStore();
    const baselineTrades = [{ entryTs: 1, exitTs: 2, side: 'long', realizedPnl: -5, closeReason: 'end_of_data' }];
    const res = await persistOverlayArtifacts(store, comparisonOutcome(baselineTrades), 'ds-fp');
    const desc = res.manifest.descriptors.find((d) => d.artifactType === BASELINE_TRADES);
    expect(desc).toBeDefined();
    expect(desc!.approxItemCount).toBe(1);
  });

  it('does NOT emit baseline-trades on a non-comparison run', async () => {
    const { store } = fakeStore();
    const res = await persistOverlayArtifacts(store, nonComparisonOutcome(), 'ds-fp');
    expect(res.manifest.descriptors.find((d) => d.artifactType === BASELINE_TRADES)).toBeUndefined();
  });

  it('emits a PRESENT baseline-trades artifact (empty payload) when baseline had zero trades', async () => {
    const { store, written } = fakeStore();
    const res = await persistOverlayArtifacts(store, comparisonOutcome([]), 'ds-fp');
    const desc = res.manifest.descriptors.find((d) => d.artifactType === BASELINE_TRADES);
    expect(desc).toBeDefined();
    expect(desc!.approxItemCount).toBe(0);
    // payload is the empty array, not omitted
    expect(written).toContainEqual([]);
  });

  it('BASELINE_TRADES is exactly "baseline-trades"', () => {
    expect(BASELINE_TRADES).toBe('baseline-trades');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test apps/backtester/test/overlay-store.test.ts`
Expected: FAIL — `BASELINE_TRADES` is not exported / no such descriptor.

- [ ] **Step 3: Add the constant and the writer spec**

In `apps/backtester/src/artifacts/overlay-store.ts`, add the constant near the top (after imports):
```ts
/** Artifact type for the baseline leg's per-trade records on a comparison run (slice 1b). */
export const BASELINE_TRADES = 'baseline-trades' as const;
```

Inside `persistOverlayArtifacts`, extend the existing comparison-gated tail of the `specs` array. The current code appends the `comparison` artifact via:
```ts
    ...(outcome.comparison != null
      ? [{ artifactType: 'comparison', payload: outcome.comparison } satisfies ArtifactSpec]
      : []),
```
Replace that spread with one that also emits baseline-trades from the SAME guard (single source of truth):
```ts
    ...(outcome.comparison != null
      ? [
          { artifactType: 'comparison', payload: outcome.comparison } satisfies ArtifactSpec,
          {
            artifactType: BASELINE_TRADES,
            payload: outcome.baseline.trades,
            itemCount: outcome.baseline.trades.length,
          } satisfies ArtifactSpec,
        ]
      : []),
```
(The specs are sorted by `artifactType` before writing, so ordering is handled; each payload is content-hash-addressed independently, so existing artifacts' hashes are unchanged.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test apps/backtester/test/overlay-store.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/backtester/src/artifacts/overlay-store.ts apps/backtester/test/overlay-store.test.ts
git commit -m "feat(artifacts): persist baseline-trades on comparison runs (slice 1b)"
```

---

### Task 3: Reconcile existing tests + goldens + variant⇔comparison invariant

**Files:**
- Modify: `apps/backtester/test/comparison-wire.test.ts` (if it asserts the exact descriptor set/count)
- Test: `apps/backtester/test/overlay-store.test.ts` (extend with the invariant)
- Inspect: golden / byte-identity tests (`apps/backtester/test/long-oi-parity/golden-fixture.test.ts`, `equivalence.test.ts`, `completion.test.ts`, `api.e2e.test.ts`) for manifest-descriptor-set assertions

**Interfaces:**
- Consumes: `BASELINE_TRADES` (Task 2), `persistOverlayArtifacts` (Task 2).

- [ ] **Step 1: Run the full suite to surface any test that asserts the exact descriptor set**

Run: `pnpm test`
Expected: identify any FAILING test whose expectation is a fixed descriptor list/count now that comparison runs carry one extra `baseline-trades` descriptor. (Per-artifact content hashes are unchanged, so hash-based assertions should stay green; only exact-descriptor-set assertions can break.)

- [ ] **Step 2: Update each broken exact-descriptor-set assertion additively**

For every test surfaced in Step 1, add `baseline-trades` to the expected descriptor set (and bump any expected count by 1) for comparison-run cases only. Do NOT touch non-comparison-run expectations. Example shape for `comparison-wire.test.ts` if it enumerates descriptors:
```ts
// comparison run now additionally carries the baseline-trades descriptor
expect(descriptorTypes).toEqual(
  expect.arrayContaining(['run-summary', 'metrics', 'trades', 'decision-records', 'comparison', 'baseline-trades']),
);
```
If a test asserts an exact-length manifest or a golden manifest snapshot, update the golden to include the new descriptor and note in the commit body that this is an intended additive change (the version bump `022.2` records it).

- [ ] **Step 3: Add the variant⇔comparison invariant test**

Append to `apps/backtester/test/overlay-store.test.ts`:
```ts
import type { RunOutcome as RunOutcomeT } from '../src/engine/artifacts';

// The baseline-trades guard uses outcome.comparison != null. The runner sets `variant` and
// `comparison` together (comparison = computeComparison(baseline, variant) runs in the same
// overlays block), so the two signals are equivalent. This locks that equivalence so a future
// divergence — which would desync the guard — is caught here rather than in production.
describe('RunOutcome comparison/variant equivalence invariant', () => {
  function assertEquiv(o: Extract<RunOutcomeT, { status: 'completed' }>) {
    expect(o.variant != null).toBe(o.comparison != null);
  }
  it('holds for a comparison outcome', () => assertEquiv(comparisonOutcome([])));
  it('holds for a non-comparison outcome', () => assertEquiv(nonComparisonOutcome()));
});
```
If the repo has a runner-level test that produces a real `RunOutcome` from `runBacktest` (e.g. `funding-engine.test.ts` or an engine test), also add one assertion there that a real overlay run yields `variant != null` iff `comparison != null` — grounding the invariant on the actual producer, not just constructed fixtures.

- [ ] **Step 4: Run the full check**

Run: `pnpm check`
Expected: typecheck clean; full suite green (including the reconciled descriptor-set tests and the new invariant).

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/test/
git commit -m "test(artifacts): reconcile descriptor-set tests + variant/comparison invariant"
```

---

## Self-Review

**Spec coverage (§3 + §7):**
- §3.1 baseline-trades artifact, `comparison != null` guard, named constant, present-vs-absent semantics → Task 2. ✓
- §3.2 `ARTIFACT_CONTRACT_VERSION` bump (both files + ARCHITECTURE) → Task 1. ✓
- §3.3 tests: comparison/non-comparison/empty + comparison-wire/golden reconcile + variant⇔comparison invariant + byte-proof guard → Tasks 2 & 3. ✓
- §7 version-compat rollout gate (audit script, first block, fallback-on-strict-check → BLOCKED) → Task 1. ✓
- Out of scope (correctly absent): all lab-side work (getBaselineRunTrades, applyBacktestPreservationGate, migration, retrofit) — that is the `1b-lab` plan. No SDK typed-contract field (B1). Backtester image redeploy is an ops step, not a code task.

**Placeholder scan:** none — every code step shows full code; the audit script and writer edit are complete. The only "inspect and update if present" steps (Task 3 Steps 1-2) are inherently discovery-driven (which existing tests assert descriptor sets is not knowable without running them) and give the exact additive edit to apply.

**Type consistency:** `BASELINE_TRADES` value `'baseline-trades'` is consistent across Tasks 2-3 and matches the spec's contract value (the `1b-lab` plan declares its own lab-side constant with the same literal). `persistOverlayArtifacts(store, outcome, datasetFingerprint)` signature and `RunOutcome` completed shape match the real definitions.

**Note for `1b-lab` plan (next):** lab declares its own `BASELINE_TRADES = 'baseline-trades'` constant; adds `getBaselineRunTrades(comparisonRunId): Promise<TradeRecord[] | null>` (descriptor absent → null); `applyBacktestPreservationGate` (EOD→INCONCLUSIVE, abstention/winner→MODIFY); wires it into `finalizeBacktestCompletion` with fail-open + `evaluation.preservation_skipped`; `evaluation.preservation_gate` column (migration 0022); 1a revision-lane fail-open retrofit (`revision.preservation_skipped`); and the authoritative automated version-tolerance lock-test (feed a `022.2` manifest through lab's vendored client). Ships AFTER this slice.
