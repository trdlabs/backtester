# Phase 3B — research-contracts wire dedup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `@trading-backtester/sdk` the single definition source for the backtester wire types by turning the duplicate `packages/research-contracts/src/{run.ts,comparison.ts}` into thin type re-exports — with zero import-site churn and no runtime change.

**Architecture:** Approach A (thin re-export shim). The two files keep their paths and exported names but re-export every type from the SDK (`@trading-backtester/sdk/contracts` for run/validation/capability/comparison/module types; `@trading-backtester/sdk/artifacts` for artifact types). `research-contracts/src/index.ts` (`export * from './run.js'` / `'./comparison.js'`) then surfaces the SDK types unchanged to the 18 importers and the `/research` subpath.

**Tech Stack:** TypeScript, pnpm workspaces (raw-TS source packages, no build step for `research-contracts`), Vitest.

## Global Constraints

- **No runtime change.** These files export only types; the shims must be `export type { ... }` only. Goldens (`eff10116…` momentum, `0be9931c`/`e381659c` overlay) MUST stay byte-identical.
- **No import-site churn.** The 18 `apps/backtester/src` files importing `@trading/research-contracts` and the 47 `/research`-subpath consumers MUST NOT be edited.
- **No new dependency cycle.** `@trading-backtester/sdk` must not import `@trading/research-contracts` (verified empty at plan time). The new edge is `research-contracts → sdk` only.
- **Primary gate is `pnpm typecheck`** at the repo root — it proves the SDK types are structurally identical to the definitions being removed. A clean typecheck across the whole monorepo is the proof of correctness.
- Spec: `docs/superpowers/specs/2026-06-21-research-contracts-wire-dedup-design.md`.

---

### Task 1: Pre-flight + SDK dependency + `comparison.ts` shim

**Files:**
- Modify: `packages/research-contracts/package.json` (add the SDK workspace dependency)
- Modify: `packages/research-contracts/src/comparison.ts` (body → re-export)

**Interfaces:**
- Consumes: `@trading-backtester/sdk/contracts` exports `MetricDelta`, `OverlayEffectsSummary`, `ComparisonVariant`, `ComparisonSummary` (defined in the SDK's `contracts/run.ts`, surfaced via `contracts/index.ts` `export type * from './run'`).
- Produces: `@trading/research-contracts` continues to export the same four comparison type names, now sourced from the SDK.

- [ ] **Step 1: Pre-flight — confirm no cycle and SDK surface (read-only)**

Run:
```bash
cd /home/alexxxnikolskiy/projects/trading-backtester
grep -rn '@trading/research-contracts' packages/sdk/src ; echo "cycle-check-exit:$?"
grep -nE 'MetricDelta|OverlayEffectsSummary|ComparisonVariant|ComparisonSummary' packages/sdk/src/contracts/run.ts
```
Expected: the first grep prints nothing (`cycle-check-exit:1` = no match = no cycle); the second prints the four interface declarations in the SDK. If the SDK is missing any of the four, STOP — the shim cannot source them yet (escalate; do not invent types).

- [ ] **Step 2: Add the SDK workspace dependency to `research-contracts/package.json`**

Add a `dependencies` block (the file currently has none). Insert it after the `"types"` line, before the closing brace:

```json
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "dependencies": {
    "@trading-backtester/sdk": "workspace:*"
  }
}
```

- [ ] **Step 3: Install so the workspace symlink resolves**

Run: `pnpm install`
Expected: completes; `node_modules/@trading-backtester/sdk` is linked for `research-contracts` (no lockfile churn beyond the new dependency edge).

- [ ] **Step 4: Replace `comparison.ts` body with a type re-export**

Overwrite `packages/research-contracts/src/comparison.ts` entirely with:

```ts
// Wire comparison vocabulary (baseline-vs-variant) — re-exported from the canonical SDK
// (@trading-backtester/sdk). This module keeps the historical @trading/research-contracts
// entry stable for existing importers; the SDK is the single definition source.

export type {
  MetricDelta,
  OverlayEffectsSummary,
  ComparisonVariant,
  ComparisonSummary,
} from '@trading-backtester/sdk/contracts';
```

- [ ] **Step 5: Typecheck the monorepo**

Run: `pnpm typecheck`
Expected: PASS (0 errors). A failure here means a comparison type diverged between the SDK and research-contracts — read the error, reconcile to the SDK type, and re-run. Do not silence with `any`.

- [ ] **Step 6: Commit**

```bash
git add packages/research-contracts/package.json packages/research-contracts/src/comparison.ts pnpm-lock.yaml
git commit -m "refactor(contracts): re-export comparison wire types from the SDK (dedup)"
```

---

### Task 2: `run.ts` shim + full verification

**Files:**
- Modify: `packages/research-contracts/src/run.ts` (body → re-exports)
- Verify: whole monorepo (`pnpm typecheck`, `pnpm check`)

**Interfaces:**
- Consumes: `@trading-backtester/sdk/contracts` exports (via `contracts/index.ts`) `RunMode, Ref, RunPeriod, ModuleKind, BacktestEngine, ModuleManifest, ModuleBundle, BacktestRunRequest, RunSubmitRequest, NonTerminalRunStatus, TerminalRunStatus, RunStatus, RunJobHandle, ContentHash, RunEvidence, RunResultSummary, RunTimelineEntry, RunStatusView, CompletionEventType, CompletionEvent, GatewayErrorCategory, GatewayError, ValidationStatus, ValidationIssue, ValidationReport, CapabilityDescriptor, DatasetDescriptor`; `@trading-backtester/sdk/artifacts` exports `ArtifactReference, ArtifactDescriptor, ArtifactManifest, ArtifactPage, ArtifactAvailability`.
- Produces: `@trading/research-contracts` continues to export the identical run/artifact/validation/capability type surface, now sourced from the SDK. (`research-contracts/src/index.ts` keeps `export * from './run.js'` unchanged.)

- [ ] **Step 1: Confirm the SDK `/artifacts` subpath exports all five artifact types (read-only)**

Run:
```bash
cd /home/alexxxnikolskiy/projects/trading-backtester
grep -nE 'ArtifactReference|ArtifactDescriptor|ArtifactManifest|ArtifactPage|ArtifactAvailability' packages/sdk/src/artifacts/types.ts
```
Expected: all five names appear as `export interface`/`export type` in the SDK artifacts module. If any is missing, STOP and escalate (the type would have to be added to the SDK first — out of this task's scope).

- [ ] **Step 2: Replace `run.ts` body with type re-exports**

Overwrite `packages/research-contracts/src/run.ts` entirely with:

```ts
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
```

- [ ] **Step 3: Typecheck the monorepo (proves the 18 sites + `/research` + index still compile)**

Run: `pnpm typecheck`
Expected: PASS (0 errors). A failure names the exact divergent type or a consumer that relied on a research-contracts-only shape — read it, reconcile to the SDK type, re-run. Do not edit the 18 import sites to "fix" a divergence; a divergence means the types were not actually parity and must be adjudicated (align the SDK, or keep that one type defined locally and note it in the commit).

- [ ] **Step 4: Confirm the two files contain only re-exports (no leftover definitions)**

Run:
```bash
grep -cE 'export (interface|type [A-Za-z]+ =)' packages/research-contracts/src/run.ts packages/research-contracts/src/comparison.ts
```
Expected: `0` definition lines in each file (only `export type { ... } from` re-exports remain).

- [ ] **Step 5: Full suite — goldens byte-unchanged**

Run: `pnpm check`
Expected: typecheck 0 + full test suite green (same pass/skip counts as before the change; Docker-sandbox tests skip-not-fail without Docker). The momentum/overlay golden tests (`eff10116…`, `0be9931c`, `e381659c`) MUST be unchanged — a pure type re-export cannot move them; if any golden moves, STOP (something other than this change is in the tree).

- [ ] **Step 6: Re-confirm no dependency cycle**

Run:
```bash
grep -rn '@trading/research-contracts' packages/sdk/src ; echo "cycle-exit:$?"
```
Expected: no matches (`cycle-exit:1`) — the SDK still does not import research-contracts.

- [ ] **Step 7: Commit**

```bash
git add packages/research-contracts/src/run.ts
git commit -m "refactor(contracts): re-export run/artifact wire types from the SDK (dedup); SDK is the single source"
```

---

## Verification (whole-plan acceptance)

- `pnpm typecheck`: 0 errors.
- `pnpm check`: full suite green; goldens unchanged.
- `packages/research-contracts/src/{run.ts,comparison.ts}` contain **only** `export type { ... } from '@trading-backtester/sdk/...'` re-exports — zero local definitions.
- The 18 `@trading/research-contracts` import sites and the `/research` subpath are unedited.
- `@trading-backtester/sdk` does not import `@trading/research-contracts` (no cycle).
