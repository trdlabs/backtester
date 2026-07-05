# Phase 3B — research-contracts wire dedup (SDK as single source) — Design

## Context / Problem

The public `@trading-backtester/sdk` (`packages/sdk`) is the canonical source for the
backtester's wire contracts. But the older package `@trading/research-contracts`
(`packages/research-contracts`) still carries **duplicate definitions** of the same wire
vocabulary in `src/run.ts` (run / result / artifact / validation / capability / comparison
references / completion / gateway-error types) and `src/comparison.ts` (baseline-vs-variant
comparison types).

18 service files in `apps/backtester/src` import these wire types from the root
`@trading/research-contracts` entry. The duplication is a drift risk: the two copies can
diverge silently.

This is **internal hygiene — no consumer impact** (the public SDK and the HTTP wire are
unchanged). It is "Phase 3 Part B" of the public-SDK epic (deferred there).

## Goal

Make `@trading-backtester/sdk` the **single definition source** for these wire types, removing
the duplicate definitions in `research-contracts`, **without** changing the 18 import sites or
the `@trading/research-contracts/research` subpath (47 consumers).

## Approach — thin re-export shim (Approach A)

Replace the **bodies** of the two duplicate files with type re-exports from the SDK. The files
keep their paths and exported names, so every existing importer of `@trading/research-contracts`
sees the same type surface — sourced from the SDK. This matches the house pattern already used
for SDK canonicalization (the service `determinism/*` files became thin re-export wrappers).

Rejected alternative — **hard cutover** (re-point all 18 import sites to
`@trading-backtester/sdk/{contracts,artifacts}` and delete the files): a cleaner tree but 18-file
churn in the contract boundary for cosmetic gain. Out of scope here; can be a later step.

## Changes (3 files)

1. **`packages/research-contracts/src/comparison.ts`** — body becomes:
   ```ts
   export type { MetricDelta, OverlayEffectsSummary, ComparisonVariant, ComparisonSummary }
     from '@trading-backtester/sdk/contracts';
   ```
   (These live in the SDK's `contracts/run.ts` and are exported via `/contracts`.)

2. **`packages/research-contracts/src/run.ts`** — re-export the **exact** set of names the file
   currently exports, sourced from the SDK:
   - from `@trading-backtester/sdk/contracts`:
     `RunMode, Ref, RunPeriod, ModuleKind, BacktestEngine, ModuleManifest, ModuleBundle,
     BacktestRunRequest, RunSubmitRequest, NonTerminalRunStatus, TerminalRunStatus, RunStatus,
     RunJobHandle, ContentHash, RunEvidence, RunResultSummary, RunTimelineEntry, RunStatusView,
     CompletionEventType, CompletionEvent, GatewayErrorCategory, GatewayError, ValidationStatus,
     ValidationIssue, ValidationReport, CapabilityDescriptor, DatasetDescriptor`
   - from `@trading-backtester/sdk/artifacts`:
     `ArtifactReference, ArtifactDescriptor, ArtifactManifest, ArtifactPage, ArtifactAvailability`
   - The current `import type { ComparisonSummary } from './comparison.js'` re-export chain stays
     valid (comparison.ts now re-exports it from the SDK).

3. **`packages/research-contracts/package.json`** — add a workspace dependency on
   `@trading-backtester/sdk` so the re-export imports resolve.

## Safety invariant

The re-export only compiles if the SDK types are **structurally identical** to the current
research-contracts definitions. `pnpm typecheck` over the whole monorepo is the gate: any
divergence surfaces as a compile error at the re-export or at a downstream consumer. If a type
genuinely differs, that is a real drift to adjudicate during implementation — align it to the
SDK, or (only if there is a deliberate reason) keep that single type defined locally and note it.

No runtime change: pure type re-exports. Goldens stay byte-identical; the existing compile-time
drift guard (`overlay-summary` assigns the engine `ComparisonSummary` value to the wire type)
still holds, now anchored on the SDK type.

## Pre-flight checks (done in the plan, before editing)

1. **No cycle:** confirm the SDK does not import `@trading/research-contracts` (it is standalone;
   runtime dep `decimal.js` only). A `research-contracts → sdk` edge must stay acyclic.
2. **Surface parity:** confirm `research-contracts/src/index.ts` and `src/research/*` import only
   the names the shims continue to export (no name is dropped).
3. **Resolution:** confirm `@trading-backtester/sdk/contracts` and `/artifacts` resolve from inside
   the `research-contracts` package (tsconfig paths / workspace), the same way the 18 app files
   already resolve them.

## Verification

- `pnpm typecheck` — primary gate (proves type identity across the monorepo).
- `pnpm check` / full suite green; momentum + overlay goldens byte-unchanged.
- No new `@trading/research-contracts` ↔ SDK cycle (re-check dependency direction).

## Out of scope

- The hard cutover (re-pointing the 18 import sites; deleting the files).
- The `/research` subpath types (`src/research/*`) — unchanged.
- The cross-repo SDK-boundaries initiative (extracting `@trading-platform/sdk` into its own repo)
  — a separate, larger effort tracked in `trading-lab/docs/conversational-operator-roadmap.md`.

## Done when

- `research-contracts/src/run.ts` + `comparison.ts` contain **no duplicate type definitions** —
  only re-exports from `@trading-backtester/sdk`.
- The 18 import sites and the `/research` subpath compile unchanged.
- `pnpm check` green; goldens unchanged.
