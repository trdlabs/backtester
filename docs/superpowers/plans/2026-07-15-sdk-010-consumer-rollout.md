# SDK 0.10.0 Consumer Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the backtester and lab onto published `@trdlabs/sdk@0.10.0`, prove both backtester production data-source paths use its bounded HistoricalClient transport, and record the resulting known-good release train.

**Architecture:** `RowsDataPortOptions` mirrors the full transport-control subset exposed by `HistoricalClient`; `buildApp` remains the one runtime owner of the validated `dataApi*` values and passes them to real and mock `RowsDataPort` instances. The adapter gets behavioral transport tests while the application gets a separate dual-source factory gate. The release train is written only after merged consumer commits and fresh `origin/main` refs are verified.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest, Fastify fixture servers, `@trdlabs/sdk@0.10.0`, control-center release scripts.

## Global Constraints

- Use the public npm package only; do not import sibling SDK source or a GitHub tarball.
- Backtester must update exactly these manifests to `^0.10.0`: `apps/backtester/package.json`, `packages/research-contracts/package.json`, `packages/sdk/package.json`.
- `RowsDataPortOptions` and both `buildApp` production branches must pass exactly: `timeoutMs`, `maxAttempts`, `retryBaseMs`, `retryMaxMs`, `maxPages`, `maxRows`, `operationDeadlineMs`, and `pageLimit`.
- `DATA_SOURCE=fixture` remains behaviorally unchanged.
- Prove adapter transport behavior separately from factory branch selection.
- Office and mock-platform are inspected unaffected; do not change their manifests.
- Runtime import after a clean install must assert `SDK_VERSION === '0.10.0'` in both consumers.
- Never record a release from stale refs. Fetch sibling `origin/main` refs and verify component SHAs before `pnpm record-release`.

## Execution Order

Execute Task 3 before Tasks 1 and 2. Version `0.9.5` does not expose the
HistoricalClient resilience options under test, so a clean `0.10.0` install is
a prerequisite for compiling the adapter's RED tests. Task 3 itself remains
TDD: its runtime identity assertion fails against the old installed package
before any manifest or lockfile change.

---

### Task 1: Backtester Adapter Contract and Behavioral Tests

**Files:**
- Modify: `apps/backtester/src/data/rows-data-port.ts:71-135`
- Create: `apps/backtester/test/rows-data-port-resilience.test.ts`

**Interfaces:**
- Consumes: `HistoricalClient` options from published `@trdlabs/sdk/historical`.
- Produces: `RowsDataPortOptions` forwarding the eight named transport controls.

- [ ] **Step 1: Write failing adapter tests**

Create fixture fetch helpers patterned after `http-data-port-resilience.test.ts`. Cover:

```ts
it('retries a transient rows response within maxAttempts', async () => {
  const rows = await collect(new RowsDataPort({ baseUrl, fetchImpl, maxAttempts: 2, retryBaseMs: 1, retryMaxMs: 1 }));
  expect(rows).toHaveLength(1);
  expect(rowCalls).toBe(2);
});

it('propagates timeout, operation deadline, and page/row overflow from HistoricalClient', async () => {
  await expect(collect(timeoutPort)).rejects.toThrow(/timeout/);
  await expect(collect(deadlinePort)).rejects.toThrow(/operation deadline exceeded/);
  await expect(collect(pageOverflowPort)).rejects.toThrow(/exceeded maxPages/);
  await expect(collect(rowOverflowPort)).rejects.toThrow(/exceeded maxRows/);
});
```

- [ ] **Step 2: Run RED**

Run: `pnpm vitest run apps/backtester/test/rows-data-port-resilience.test.ts`

Expected: failures because `RowsDataPortOptions` does not expose or forward the resilience controls.

- [ ] **Step 3: Implement minimal option forwarding**

Extend the interface and constructor only:

```ts
export interface RowsDataPortOptions {
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
  readonly maxPages?: number;
  readonly maxRows?: number;
  readonly operationDeadlineMs?: number;
  readonly pageLimit?: number;
}

this.client = new HistoricalClient({
  baseUrl: opts.baseUrl,
  fetchImpl: opts.fetchImpl,
  token: opts.token,
  pageLimit: opts.pageLimit ?? 1000,
  timeoutMs: opts.timeoutMs,
  maxAttempts: opts.maxAttempts,
  retryBaseMs: opts.retryBaseMs,
  retryMaxMs: opts.retryMaxMs,
  maxPages: opts.maxPages,
  maxRows: opts.maxRows,
  operationDeadlineMs: opts.operationDeadlineMs,
});
```

- [ ] **Step 4: Run GREEN and focused regression tests**

Run: `pnpm vitest run apps/backtester/test/rows-data-port-resilience.test.ts apps/backtester/test/rows-parity.test.ts`

Expected: both files pass.

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/data/rows-data-port.ts apps/backtester/test/rows-data-port-resilience.test.ts
git commit -m "fix(data): forward SDK resilience controls through RowsDataPort"
```

### Task 2: Backtester Factory Wiring and Dual-Source Integration Gate

**Files:**
- Modify: `apps/backtester/src/app.ts:124-147`
- Modify: `apps/backtester/test/app-datasource-factory.test.ts`

**Interfaces:**
- Consumes: Task 1 `RowsDataPortOptions` and existing validated `AppConfig.dataApi*` fields.
- Produces: real and mock factory paths with identical transport bounds; a hermetic proof of URL/token branch selection and row reads.

- [ ] **Step 1: Write failing real/mock factory test**

Extend the Fastify fixture to record `authorization` and serve one canonical row. Add parameterized coverage:

```ts
it.each([
  ['real', 'REALSYM', 'real-tok'],
  ['mock', 'MOCKSYM', 'mock-tok'],
] as const)('%s selects its own endpoint and token and reads rows', async (source, symbol, token) => {
  const app = await buildApp(configFor(source));
  const reader = await app.dataPort.openDataset(`${symbol}:1m`);
  const rows = await collect(reader!);
  expect(rows).toEqual([expectedCanonicalRow]);
  expect(requestLog[source]).toContain(`Bearer ${token}`);
  await app.dispose();
});

it.each(['real', 'mock'] as const)('%s forwards dataApiMaxRows to RowsDataPort', async (source) => {
  const app = await buildApp(configFor(source, { dataApiMaxRows: 1 }));
  const reader = await app.dataPort.openDataset(`${symbolFor(source)}:1m`);
  await expect(collect(reader!)).rejects.toMatchObject({ reason: 'pagination_overflow' });
  await app.dispose();
});
```

- [ ] **Step 2: Run RED**

Run: `pnpm vitest run apps/backtester/test/app-datasource-factory.test.ts`

Expected: the max-rows cases fail because real/mock `RowsDataPort` construction lacks the shared `dataApi*` transport settings; URL/token happy paths are retained as regression coverage.

- [ ] **Step 3: Wire both production branches**

In each `new RowsDataPort` branch pass:

```ts
pageLimit: config.dataApiPageLimit,
timeoutMs: config.dataApiTimeoutMs,
maxAttempts: config.dataApiMaxAttempts,
retryBaseMs: config.dataApiRetryBaseMs,
retryMaxMs: config.dataApiRetryMaxMs,
maxPages: config.dataApiMaxPages,
maxRows: config.dataApiMaxRows,
operationDeadlineMs: config.dataApiOperationDeadlineMs,
```

- [ ] **Step 4: Run GREEN and compatibility gate**

Run: `pnpm vitest run apps/backtester/test/app-datasource-factory.test.ts apps/backtester/test/cross-repo-historical-e2e.integration.test.ts`

Expected: hermetic factory tests pass; opt-in sibling-platform suite remains cleanly skipped unless explicitly enabled.

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/app.ts apps/backtester/test/app-datasource-factory.test.ts
git commit -m "test(data): gate real and mock RowsDataPort wiring"
```

### Task 3: Backtester Published-Version Pin and Runtime Identity Gate

**Files:**
- Modify: `apps/backtester/package.json`
- Modify: `packages/research-contracts/package.json`
- Modify: `packages/sdk/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/backtester/test/sdk-runtime-version.test.ts`

**Interfaces:**
- Consumes: published `@trdlabs/sdk@0.10.0` root export `SDK_VERSION`.
- Produces: no old `@trdlabs/sdk` resolution and runtime identity protection.

- [ ] **Step 1: Write failing identity test**

```ts
import { SDK_VERSION } from '@trdlabs/sdk';

it('runs against published @trdlabs/sdk 0.10.0', () => {
  expect(SDK_VERSION).toBe('0.10.0');
});
```

- [ ] **Step 2: Run RED**

Run: `pnpm vitest run apps/backtester/test/sdk-runtime-version.test.ts`

Expected: failure with installed `SDK_VERSION` `0.9.5`.

- [ ] **Step 3: Update all three manifests and lockfile**

Set each `@trdlabs/sdk` specifier to `^0.10.0`, then run:

```bash
pnpm install --lockfile-only
pnpm install --frozen-lockfile
```

- [ ] **Step 4: Verify runtime and resolution**

Run:

```bash
pnpm vitest run apps/backtester/test/sdk-runtime-version.test.ts
pnpm list -r @trdlabs/sdk
```

Expected: the test passes and `pnpm list` has no `0.9.5` entry.

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/package.json packages/research-contracts/package.json packages/sdk/package.json pnpm-lock.yaml apps/backtester/test/sdk-runtime-version.test.ts
git commit -m "chore: upgrade backtester to @trdlabs/sdk 0.10.0"
```

### Task 4: Lab Exact Pin and Runtime Identity Gate

**Repository:** `../lab`

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `src/adapters/platform/sdk-smoke.test.ts`

**Interfaces:**
- Consumes: public root export `SDK_VERSION` from npm package `@trdlabs/sdk@0.10.0`.
- Produces: exact consumer pin and runtime assertion.

- [ ] **Step 1: Write failing version assertion**

Change the existing smoke test to:

```ts
expect(SDK_VERSION).toBe('0.10.0');
```

- [ ] **Step 2: Run RED**

Run: `pnpm vitest run src/adapters/platform/sdk-smoke.test.ts`

Expected: failure with the currently installed `0.9.5` package.

- [ ] **Step 3: Update exact dependency and lockfile**

Set `@trdlabs/sdk` to `0.10.0`, then run:

```bash
pnpm install --lockfile-only
pnpm install --frozen-lockfile
```

- [ ] **Step 4: Run GREEN and primary repository gate**

Run:

```bash
pnpm vitest run src/adapters/platform/sdk-smoke.test.ts
pnpm check
```

Expected: version assertion and lab check pass.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml src/adapters/platform/sdk-smoke.test.ts
git commit -m "chore: upgrade lab to @trdlabs/sdk 0.10.0"
```

### Task 5: Cross-Repository Validation and Known-Good Release Record

**Repository:** `../control-center`

**Files:**
- Modify: `releases.yaml` via `pnpm record-release`

**Interfaces:**
- Consumes: merged backtester and lab commits, npm release `@trdlabs/sdk@0.10.0`.
- Produces: a release-train entry with current, non-null component SHAs.

- [ ] **Step 1: Verify merged consumer commits and fresh refs**

Run from the sibling root:

```bash
for repo in control-center sdk platform lab office backtester mock-platform; do
  git -C "$repo" fetch origin main
done
git -C backtester merge-base --is-ancestor <backtester-merge-sha> origin/main
git -C lab merge-base --is-ancestor <lab-merge-sha> origin/main
```

Expected: both ancestry checks exit `0`.

- [ ] **Step 2: Run final merged backtester and lab gates**

Run from each merged consumer main:

```bash
pnpm install --frozen-lockfile
pnpm vitest run apps/backtester/test/rows-data-port-resilience.test.ts apps/backtester/test/app-datasource-factory.test.ts apps/backtester/test/sdk-runtime-version.test.ts
pnpm list -r @trdlabs/sdk
pnpm check
```

and in lab:

```bash
pnpm install --frozen-lockfile
pnpm vitest run src/adapters/platform/sdk-smoke.test.ts
pnpm check
```

- [ ] **Step 3: Record the release train**

Run from control-center:

```bash
pnpm record-release -- --id 2026-07-15-sdk-010-p2-12 --notes "Published @trdlabs/sdk 0.10.0 consumed by lab and backtester; real/mock HistoricalClient wiring and bounds validated."
pnpm releases -- --show 2026-07-15-sdk-010-p2-12
```

Expected: all components are non-null; `trading-platform-sdk.npm_version` is `0.10.0`; recorded `lab` and `backtester` SHAs equal the verified merge commits.

- [ ] **Step 4: Run control-center gates**

Run: `pnpm test && pnpm validate-links`

Expected: both exit `0`.

- [ ] **Step 5: Commit**

```bash
git add releases.yaml
git commit -m "docs: record SDK 0.10.0 known-good release"
```

## Plan Self-Review

- Scope coverage: Tasks 1-3 implement and validate every backtester requirement; Task 4 owns the lab pin and runtime identity; Task 5 prevents stale release refs and records all validated SHAs.
- Placeholder scan: no TODO/TBD or deferred implementation steps.
- Type consistency: all eight adapter option names exactly match `HistoricalClient` and `AppConfig` fields; the control-center release ID is used consistently.
