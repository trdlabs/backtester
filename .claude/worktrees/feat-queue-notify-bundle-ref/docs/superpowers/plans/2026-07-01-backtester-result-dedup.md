# Fingerprint-based result dedup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a worker-time completed-result cache: on a compute-identity hit, reconstruct a run's terminal result by re-stamping a cached run's runId-normalized template instead of executing the engine/sandbox — preserving the `result_hash` contract, default OFF.

**Architecture:** A generic `substitute` (deep string swap `runId`↔`SENTINEL`) implements `normalize`/`restamp`, automatically covering the woven/derived runId footprint (`${runId}::variant`). The worker's `processNextQueued` is restructured so materialization + `datasetFingerprint` run before a dedup gate, `sandboxBundleFor` moves to the miss-path, and a single extracted `finalizeResult` (persist + summary) is shared by the hit and miss paths so their output is provably identical. The template is stored content-addressed in the existing artifact store; a new `backtest_result_cache` table maps `compute_identity → templateRef`.

**Tech Stack:** TypeScript (ESM, strict), Node ≥22, pnpm 11.6.0, vitest 2.1.8, Postgres (`pg`), the existing content-addressed `ArtifactStore` (S3/file, from PR #72).

**Design spec:** [`docs/superpowers/specs/2026-07-01-backtester-result-dedup-design.md`](../specs/2026-07-01-backtester-result-dedup-design.md)

## Global Constraints

- **Never change `result_hash`.** `result_hash = contentRef(runId-stamped payload)` is preserved. The acceptance gate for the core is the per-path byte-equivalence golden: `restamp(normalize(engine, freshRun(X), X), Y)` has the same `contentRef` as `freshRun(Y)`. Existing goldens (momentum `sha256:eff10116…`, overlay-golden, determinism) MUST stay green.
- **Default OFF (dark launch).** `BACKTESTER_DEDUP_ENABLED` defaults to `false`. With it off, execution is byte-identical to today (no cache reads/writes; early bundle-load behavior unchanged in effect).
- **Cache only successful `completed`.** Never cache/serve `failed` / `timeout` / `validation_error`.
- **`bypassCache` is not run-affecting.** It is NOT part of `requestFingerprint` or `computeIdentity`. A bypassed run still populates the cache on completion.
- **`dedupedFrom` never enters the hashed payload.** Store it on the job row (`deduped_from` column) + a completion-event field — never inside the `RunOutcome`/`BacktestResult` that `contentRef` hashes, and (to avoid an SDK contract bump) NOT in `RunResultSummary`.
- **`DEDUP_COMPUTE_VERSION`** is a dedicated constant, not tied to any package/API version. Bump rule (documented at the constant): bump when engine output, the `normalize`/`restamp` shape, artifact-persistence semantics, or a sandbox-policy change alters cached-vs-fresh equivalence.
- **Sandbox and queue untouched.** No changes to `engine/sandbox/*`, `claimNextQueued`, leases, or reaping.
- **Read source via Bash** (`cat`/`sed`/`grep`) in this environment — the Gortex PreToolUse hook denies the `Read` tool on indexed source and the Gortex MCP tools are not registered. `edit_file`/`Edit`/`Write` are available.
- **Test command:** `pnpm vitest run apps/backtester/test/<file>.test.ts` (single case `-t "<name>"`); typecheck `pnpm typecheck`; full gate `pnpm check`. Every commit ends with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Import style:** new files under `src/jobs/dedup/` use extensionless relative imports for local `../` modules, matching the sibling `src/jobs/*.ts` files (note some worker imports use `.js` — match the file you edit).

## File Structure

- Create `apps/backtester/src/jobs/dedup/version.ts` — `DEDUP_COMPUTE_VERSION`, `DEDUP_TEMPLATE_VERSION`, `RUNID_SENTINEL` + bump-rule doc.
- Create `apps/backtester/src/jobs/dedup/restamp.ts` — `DedupTemplate`, `DedupEngine`, `normalize`, `restamp` (generic `substitute`).
- Create `apps/backtester/src/jobs/dedup/compute-identity.ts` — `computeIdentity`.
- Create `apps/backtester/src/jobs/dedup/result-cache.ts` — `ResultCache` interface, `CacheEntry`, `InMemoryResultCache`.
- Create `apps/backtester/src/jobs/dedup/pg-result-cache.ts` — `PgResultCache`.
- Create `apps/backtester/migrations/0004_result_cache.sql` — cache table + `deduped_from` column.
- Modify `apps/backtester/src/jobs/worker.ts` — extract `materializeFor`/`executeEngine`/`finalizeResult`; insert the dedup gate; move `sandboxBundleFor` to the miss-path; populate the cache on a completed miss; add `resultCache` + `dedupEnabled` to `WorkerDeps`.
- Modify `apps/backtester/src/config.ts` — `dedupEnabled` (env `BACKTESTER_DEDUP_ENABLED`, default false).
- Modify `packages/sdk/src/contracts/run.ts` — add `bypassCache?: boolean` to `RunSubmitRequest`.
- Modify `apps/backtester/src/jobs/submit.ts` — pass `bypassCache` through to the stored request (already excluded from the fingerprint by `fingerprint.ts::normalize`, which does not read it).
- Modify `apps/backtester/src/app.ts` — construct the `ResultCache` and thread `dedupEnabled` into `WorkerDeps`.
- Modify `docs/OPERATIONS.md`, `docs/ROADMAP.md`.
- Tests: `test/dedup-restamp.test.ts`, `test/dedup-equivalence.test.ts`, `test/dedup-compute-identity.test.ts`, `test/dedup-result-cache.test.ts`, `test/dedup-worker.test.ts`, `test/config-dedup.test.ts`.

---

### Task 1: DedupTemplate + normalize/restamp core

**Files:**
- Create: `apps/backtester/src/jobs/dedup/version.ts`
- Create: `apps/backtester/src/jobs/dedup/restamp.ts`
- Test: `apps/backtester/test/dedup-restamp.test.ts`

**Interfaces:**
- Produces:
  - `const DEDUP_COMPUTE_VERSION: string`, `const DEDUP_TEMPLATE_VERSION: string`, `const RUNID_SENTINEL: string` (version.ts)
  - `type DedupEngine = 'momentum' | 'overlay' | 'strategy'`
  - `type DedupPayloadKind = 'RunOutcome' | 'BacktestResult'`
  - `interface DedupTemplate { readonly engine: DedupEngine; readonly payloadKind: DedupPayloadKind; readonly templateVersion: string; readonly normalizedPayload: unknown }`
  - `function normalize(engine: DedupEngine, payload: unknown, runId: string): DedupTemplate`
  - `function restamp(template: DedupTemplate, runId: string): unknown`

- [ ] **Step 1: Write the failing test**

`apps/backtester/test/dedup-restamp.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { normalize, restamp } from '../src/jobs/dedup/restamp';
import { RUNID_SENTINEL } from '../src/jobs/dedup/version';

// A payload with runId woven top-level, nested, and DERIVED (`${runId}::variant`) — mirrors the
// real engine footprint (runner.ts baseline/variant + metrics).
function payload(runId: string): unknown {
  return {
    runId,
    runKind: 'baseline-vs-variant',
    metrics: { sharpe: 1.5 },
    variants: [
      { kind: 'baseline', runId, note: 'x' },
      { kind: 'variant', runId: `${runId}::variant`, note: 'y' },
    ],
    evidence: { seed: 7, moduleVersions: [{ id: 'm', version: '1.0.0' }] },
  };
}

describe('normalize/restamp', () => {
  it('normalize erases runId everywhere including derived forms', () => {
    const t = normalize('overlay', payload('run-AAA'), 'run-AAA');
    expect(JSON.stringify(t.normalizedPayload)).not.toContain('run-AAA');
    expect(JSON.stringify(t.normalizedPayload)).toContain(RUNID_SENTINEL);
    expect(JSON.stringify(t.normalizedPayload)).toContain(`${RUNID_SENTINEL}::variant`);
    expect(t.engine).toBe('overlay');
    expect(t.payloadKind).toBe('RunOutcome');
  });

  it('normalize of two runs (different runId) is identical', () => {
    const a = normalize('overlay', payload('run-AAA'), 'run-AAA').normalizedPayload;
    const b = normalize('overlay', payload('run-BBB'), 'run-BBB').normalizedPayload;
    expect(a).toEqual(b);
  });

  it('restamp is the exact inverse: restamp(normalize(p(X),X), Y) deep-equals p(Y)', () => {
    const t = normalize('overlay', payload('run-AAA'), 'run-AAA');
    expect(restamp(t, 'run-BBB')).toEqual(payload('run-BBB'));
  });

  it('momentum payloadKind is BacktestResult', () => {
    expect(normalize('momentum', payload('r'), 'r').payloadKind).toBe('BacktestResult');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/backtester/test/dedup-restamp.test.ts`
Expected: FAIL — cannot find module `../src/jobs/dedup/restamp`.

- [ ] **Step 3: Write the constants**

`apps/backtester/src/jobs/dedup/version.ts`:
```ts
// Dedup compute-semantics version. NOT tied to any package/API version — this is the operator lever
// for cache invalidation. BUMP when a change could alter cached-vs-fresh equivalence:
//   - engine output, the normalize/restamp shape, artifact-persistence semantics, or a sandbox-policy
//     change that affects deterministic output.
// A bump re-keys every cache entry (new computeIdentity space) — safe by construction.
export const DEDUP_COMPUTE_VERSION = '1';

// Shape version of the DedupTemplate envelope itself. Bump if the envelope shape changes.
export const DEDUP_TEMPLATE_VERSION = '1';

// Fixed placeholder runId used in normalized templates. A zero UUID never collides with a real
// randomUUID() runId. normalize() asserts a real payload does not already contain it.
export const RUNID_SENTINEL = '00000000-0000-0000-0000-000000000000';
```

- [ ] **Step 4: Write the core**

`apps/backtester/src/jobs/dedup/restamp.ts`:
```ts
import { DEDUP_TEMPLATE_VERSION, RUNID_SENTINEL } from './version';

export type DedupEngine = 'momentum' | 'overlay' | 'strategy';
export type DedupPayloadKind = 'RunOutcome' | 'BacktestResult';

export interface DedupTemplate {
  readonly engine: DedupEngine;
  readonly payloadKind: DedupPayloadKind;
  readonly templateVersion: string;
  readonly normalizedPayload: unknown;
}

// Deep clone that replaces every occurrence of `from` with `to` inside every string value. Because
// runId is a randomUUID, swapping its substring is exact: it only appears where it (or a derived form
// like `${runId}::variant`) was written, so this covers the woven footprint without enumerating types.
function substitute(value: unknown, from: string, to: string): unknown {
  if (typeof value === 'string') return value.split(from).join(to);
  if (Array.isArray(value)) return value.map((v) => substitute(v, from, to));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = substitute(v, from, to);
    return out;
  }
  return value;
}

const kindFor = (engine: DedupEngine): DedupPayloadKind =>
  engine === 'momentum' ? 'BacktestResult' : 'RunOutcome';

export function normalize(engine: DedupEngine, payload: unknown, runId: string): DedupTemplate {
  if (JSON.stringify(payload).includes(RUNID_SENTINEL)) {
    throw new Error('dedup: payload already contains the runId sentinel — cannot normalize');
  }
  return {
    engine,
    payloadKind: kindFor(engine),
    templateVersion: DEDUP_TEMPLATE_VERSION,
    normalizedPayload: substitute(payload, runId, RUNID_SENTINEL),
  };
}

export function restamp(template: DedupTemplate, runId: string): unknown {
  return substitute(template.normalizedPayload, RUNID_SENTINEL, runId);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run apps/backtester/test/dedup-restamp.test.ts`
Expected: PASS. Then `pnpm typecheck` → PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/backtester/src/jobs/dedup/version.ts apps/backtester/src/jobs/dedup/restamp.ts apps/backtester/test/dedup-restamp.test.ts
git commit -m "feat(dedup): DedupTemplate + normalize/restamp core (generic runId substitution)"
```

---

### Task 2: Byte-equivalence golden (per engine path)

This is the real acceptance for the core: prove `restamp(normalize(freshRun(X)), Y)` is byte-identical (same `contentRef`) to `freshRun(Y)` against the REAL engine.

**Files:**
- Test: `apps/backtester/test/dedup-equivalence.test.ts`

**Interfaces:**
- Consumes: `normalize`, `restamp` (Task 1); `runBacktest` (`../src/runner/run-backtest`) → `BacktestResult`; `materialize` + `FixtureDataPort` (as used in `momentum-guardrail.test.ts`); `contentRef` (`../src/determinism/hash`).

- [ ] **Step 1: Write the momentum equivalence golden (mirror `momentum-guardrail.test.ts` setup)**

First read the existing harness to copy its fixture wiring verbatim: `cat apps/backtester/test/momentum-guardrail.test.ts` (note `REQ`, `FIXTURES_DIR`, `loadDataset()`). Then:

`apps/backtester/test/dedup-equivalence.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { runBacktest } from '../src/runner/run-backtest';
import { materialize } from '../src/data/reader';
import { FixtureDataPort } from '../src/data/fixture-port';
import { contentRef } from '../src/determinism/hash';
import { normalize, restamp } from '../src/jobs/dedup/restamp';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Copy REQ/FIXTURES_DIR/loadDataset from momentum-guardrail.test.ts (same fixture: smoke-btc-1m).
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(HERE, '../fixtures/candles');
const BASE_REQ = {
  mode: 'research' as const,
  moduleRef: { id: 'momentum', version: '1.0.0' },
  datasetRef: 'smoke-btc-1m',
  symbols: ['BTCUSDT'],
  timeframe: '1m',
  period: { from: '1970-01-01T00:00:00.000Z', to: '2100-01-01T00:00:00.000Z' },
  seed: 42,
  metrics: [] as string[],
};
async function loadDataset() {
  const reader = await new FixtureDataPort(FIXTURES_DIR).openDataset('smoke-btc-1m');
  if (!reader) throw new Error('fixture missing');
  return materialize(reader, 'smoke-btc-1m', { tsFrom: 0, tsTo: Number.MAX_SAFE_INTEGER, symbols: ['BTCUSDT'] });
}
const freshRun = async (runId: string) => runBacktest({ ...BASE_REQ, runId }, { dataset: await loadDataset() });

describe('dedup equivalence golden — momentum', () => {
  it('restamp(normalize(run(X)), Y) is byte-identical to run(Y)', async () => {
    const a = await freshRun('run-AAAAAAAA');
    const b = await freshRun('run-BBBBBBBB');
    const restamped = restamp(normalize('momentum', a, 'run-AAAAAAAA'), 'run-BBBBBBBB');
    expect(contentRef(restamped)).toBe(contentRef(b));
  });
});
```
(If the exact `BASE_REQ` field set differs from `momentum-guardrail.test.ts::REQ`, use that file's `REQ` verbatim — the point is a real `runBacktest` producing a `BacktestResult` with a distinct `runId`.)

- [ ] **Step 2: Run it — verify it PASSES immediately (this is a golden, not TDD-red)**

Run: `pnpm vitest run apps/backtester/test/dedup-equivalence.test.ts`
Expected: PASS. If it FAILS, the generic `substitute` missed a runId occurrence in the momentum payload — fix `restamp.ts` (do NOT weaken the assertion) until byte-identity holds. This is the safety net working.

- [ ] **Step 3: Add the overlay equivalence golden**

Read an existing overlay in-process run harness: `cat apps/backtester/test/overlay-golden.test.ts` to copy how `runOverlayBacktest(request, { registry, marketTape })` is set up (trusted registry, `buildOverlayDataset`). Add an `overlay` describe block mirroring Step 1 but calling `runOverlayBacktest` for two runIds and asserting equal `contentRef`. Use `engine: 'overlay'` in `normalize`.

- [ ] **Step 4: Add the strategy equivalence golden (Docker-gated)**

The strategy path runs in the Docker sandbox. Guard the test the same way the repo gates Docker tests (copy the gate from `apps/backtester/test/strategy-route-worker.integration.test.ts` — read it with `cat`). Mirror Step 1 with `runStrategyBacktest` and `engine: 'strategy'`. It will skip in WSL2/CI-without-Docker — that is expected; CI's Docker lane is the gate.

- [ ] **Step 5: Run + commit**

Run: `pnpm vitest run apps/backtester/test/dedup-equivalence.test.ts`
Expected: momentum + overlay PASS; strategy skipped (no Docker) or PASS (Docker).
```bash
git add apps/backtester/test/dedup-equivalence.test.ts
git commit -m "test(dedup): per-path byte-equivalence goldens (restamp==freshRun)"
```

---

### Task 3: computeIdentity

**Files:**
- Create: `apps/backtester/src/jobs/dedup/compute-identity.ts`
- Test: `apps/backtester/test/dedup-compute-identity.test.ts`

**Interfaces:**
- Consumes: `requestFingerprint` is NOT called here (the worker already computed the stored `job.requestFingerprint`); this function takes the pieces. `sha256Hex` + `canonicalJson` (`../determinism/*`), `DEDUP_COMPUTE_VERSION` (Task 1).
- Produces: `function computeIdentity(input: { requestFingerprint: string; datasetFingerprint: string; sandboxPolicyVersion: string }): string`

- [ ] **Step 1: Write the failing test**

`apps/backtester/test/dedup-compute-identity.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { computeIdentity } from '../src/jobs/dedup/compute-identity';

const base = { requestFingerprint: 'fp1', datasetFingerprint: 'ds1', sandboxPolicyVersion: 'sp1' };

describe('computeIdentity', () => {
  it('is stable for identical inputs and sha256-shaped', () => {
    expect(computeIdentity(base)).toBe(computeIdentity({ ...base }));
    expect(computeIdentity(base)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('changes when datasetFingerprint changes', () => {
    expect(computeIdentity({ ...base, datasetFingerprint: 'ds2' })).not.toBe(computeIdentity(base));
  });
  it('changes when sandboxPolicyVersion changes', () => {
    expect(computeIdentity({ ...base, sandboxPolicyVersion: 'sp2' })).not.toBe(computeIdentity(base));
  });
  it('changes when requestFingerprint changes', () => {
    expect(computeIdentity({ ...base, requestFingerprint: 'fp2' })).not.toBe(computeIdentity(base));
  });
});
```

- [ ] **Step 2: Run — FAIL** (`pnpm vitest run apps/backtester/test/dedup-compute-identity.test.ts`) — module missing.

- [ ] **Step 3: Implement**

`apps/backtester/src/jobs/dedup/compute-identity.ts`:
```ts
import { canonicalJson } from '../../determinism/canonical-json';
import { sha256Hex } from '../../determinism/hash';
import { DEDUP_COMPUTE_VERSION } from './version';

export interface ComputeIdentityInput {
  readonly requestFingerprint: string;
  readonly datasetFingerprint: string;
  readonly sandboxPolicyVersion: string;
}

/** Runid-independent identity of a compute. computeVersion folds in DEDUP_COMPUTE_VERSION so a bump
 *  invalidates the whole cache. bypassCache is intentionally absent — it is not run-affecting. */
export function computeIdentity(input: ComputeIdentityInput): string {
  return sha256Hex(
    canonicalJson({
      requestFingerprint: input.requestFingerprint,
      datasetFingerprint: input.datasetFingerprint,
      computeVersion: DEDUP_COMPUTE_VERSION,
      sandboxPolicyVersion: input.sandboxPolicyVersion,
    }),
  );
}
```

- [ ] **Step 4: Run — PASS; `pnpm typecheck` — PASS.**

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/jobs/dedup/compute-identity.ts apps/backtester/test/dedup-compute-identity.test.ts
git commit -m "feat(dedup): computeIdentity (fingerprint + datasetFingerprint + version + sandbox policy)"
```

---

### Task 4: ResultCache interface + InMemoryResultCache

**Files:**
- Create: `apps/backtester/src/jobs/dedup/result-cache.ts`
- Test: `apps/backtester/test/dedup-result-cache.test.ts`

**Interfaces:**
- Produces:
  - `interface CacheEntry { readonly computeIdentity: string; readonly requestFingerprint: string; readonly datasetFingerprint: string; readonly computeVersion: string; readonly sandboxPolicyVersion: string; readonly templateRef: string; readonly createdAtMs: number }`
  - `interface ResultCache { lookup(computeIdentity: string): Promise<CacheEntry | undefined>; put(entry: CacheEntry): Promise<void> }`
  - `class InMemoryResultCache implements ResultCache`

- [ ] **Step 1: Write the failing test**

`apps/backtester/test/dedup-result-cache.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { InMemoryResultCache, type CacheEntry } from '../src/jobs/dedup/result-cache';

const entry = (id: string): CacheEntry => ({
  computeIdentity: id,
  requestFingerprint: 'fp',
  datasetFingerprint: 'ds',
  computeVersion: '1',
  sandboxPolicyVersion: 'sp',
  templateRef: 'sha256:abc',
  createdAtMs: 1,
});

describe('InMemoryResultCache', () => {
  it('miss then hit round-trips', async () => {
    const c = new InMemoryResultCache();
    expect(await c.lookup('k')).toBeUndefined();
    await c.put(entry('k'));
    expect(await c.lookup('k')).toEqual(entry('k'));
  });
  it('put is idempotent (first writer wins)', async () => {
    const c = new InMemoryResultCache();
    await c.put(entry('k'));
    await c.put({ ...entry('k'), templateRef: 'sha256:other' });
    expect((await c.lookup('k'))?.templateRef).toBe('sha256:abc');
  });
});
```

- [ ] **Step 2: Run — FAIL** (module missing).

- [ ] **Step 3: Implement**

`apps/backtester/src/jobs/dedup/result-cache.ts`:
```ts
export interface CacheEntry {
  readonly computeIdentity: string;
  readonly requestFingerprint: string;
  readonly datasetFingerprint: string;
  readonly computeVersion: string;
  readonly sandboxPolicyVersion: string;
  readonly templateRef: string;
  readonly createdAtMs: number;
}

export interface ResultCache {
  lookup(computeIdentity: string): Promise<CacheEntry | undefined>;
  /** Idempotent: first writer wins (identical content anyway). */
  put(entry: CacheEntry): Promise<void>;
}

export class InMemoryResultCache implements ResultCache {
  private readonly rows = new Map<string, CacheEntry>();
  async lookup(computeIdentity: string): Promise<CacheEntry | undefined> {
    return this.rows.get(computeIdentity);
  }
  async put(entry: CacheEntry): Promise<void> {
    if (!this.rows.has(entry.computeIdentity)) this.rows.set(entry.computeIdentity, entry);
  }
}
```

- [ ] **Step 4: Run — PASS; typecheck — PASS.**

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/jobs/dedup/result-cache.ts apps/backtester/test/dedup-result-cache.test.ts
git commit -m "feat(dedup): ResultCache interface + InMemoryResultCache"
```

---

### Task 5: PgResultCache + migration

**Files:**
- Create: `apps/backtester/migrations/0004_result_cache.sql`
- Create: `apps/backtester/src/jobs/dedup/pg-result-cache.ts`
- Test: `apps/backtester/test/dedup-result-cache.test.ts` (append a Pg-gated conformance block)

**Interfaces:**
- Consumes: `ResultCache`/`CacheEntry` (Task 4); `pg` `Pool` (as `pg-job-store.ts` uses it).
- Produces: `class PgResultCache implements ResultCache { constructor(pool: Pool) }`; migration adds table `backtest_result_cache` and column `backtest_job.deduped_from`.

- [ ] **Step 1: Write the migration**

`apps/backtester/migrations/0004_result_cache.sql` (read `0003_worker_lease.sql` first with `cat` to match the file's SQL style/idempotency):
```sql
-- 0004: fingerprint-based result dedup cache (Phase C item 11). Metadata + a content-addressed
-- pointer (template_ref) to the runId-normalized DedupTemplate in the artifact store.
CREATE TABLE IF NOT EXISTS backtest_result_cache (
  compute_identity       TEXT PRIMARY KEY,
  request_fingerprint    TEXT NOT NULL,
  dataset_fingerprint    TEXT NOT NULL,
  compute_version        TEXT NOT NULL,
  sandbox_policy_version TEXT NOT NULL,
  template_ref           TEXT NOT NULL,
  created_at_ms          BIGINT NOT NULL
);

-- Provenance: which cache entry a run was served from (NULL for freshly-computed runs). Observability
-- only — never part of result_hash.
ALTER TABLE backtest_job ADD COLUMN IF NOT EXISTS deduped_from TEXT;
```

- [ ] **Step 2: Write the Pg-gated conformance test**

Read `apps/backtester/test/` for the existing Postgres test gate (search: `grep -rln "PG_TEST\|DATABASE_URL\|describe.skipIf\|pg-mem\|newDb" apps/backtester/test`). Reuse the SAME gating mechanism the `PgJobStore` tests use. Append a block running the identical assertions as Task 4's InMemory test against `new PgResultCache(pool)` after applying migrations. If the repo uses `pg-mem`, use it; otherwise gate on `DATABASE_URL`.

- [ ] **Step 3: Implement PgResultCache**

`apps/backtester/src/jobs/dedup/pg-result-cache.ts` (mirror `pg-job-store.ts` row-mapping style — `cat` it first):
```ts
import type { Pool } from 'pg';
import type { CacheEntry, ResultCache } from './result-cache';

interface Row {
  compute_identity: string;
  request_fingerprint: string;
  dataset_fingerprint: string;
  compute_version: string;
  sandbox_policy_version: string;
  template_ref: string;
  created_at_ms: string; // pg BIGINT → string
}

const toEntry = (r: Row): CacheEntry => ({
  computeIdentity: r.compute_identity,
  requestFingerprint: r.request_fingerprint,
  datasetFingerprint: r.dataset_fingerprint,
  computeVersion: r.compute_version,
  sandboxPolicyVersion: r.sandbox_policy_version,
  templateRef: r.template_ref,
  createdAtMs: Number(r.created_at_ms),
});

export class PgResultCache implements ResultCache {
  constructor(private readonly pool: Pool) {}
  async lookup(computeIdentity: string): Promise<CacheEntry | undefined> {
    const r = await this.pool.query<Row>('SELECT * FROM backtest_result_cache WHERE compute_identity = $1', [computeIdentity]);
    return r.rows[0] ? toEntry(r.rows[0]) : undefined;
  }
  async put(entry: CacheEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO backtest_result_cache
         (compute_identity, request_fingerprint, dataset_fingerprint, compute_version, sandbox_policy_version, template_ref, created_at_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (compute_identity) DO NOTHING`,
      [entry.computeIdentity, entry.requestFingerprint, entry.datasetFingerprint, entry.computeVersion, entry.sandboxPolicyVersion, entry.templateRef, entry.createdAtMs],
    );
  }
}
```

- [ ] **Step 4: Run the conformance test** (`pnpm vitest run apps/backtester/test/dedup-result-cache.test.ts`) — InMemory PASS; Pg PASS or skipped per gate. Typecheck PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/migrations/0004_result_cache.sql apps/backtester/src/jobs/dedup/pg-result-cache.ts apps/backtester/test/dedup-result-cache.test.ts
git commit -m "feat(dedup): PgResultCache + 0004 cache table + deduped_from column"
```

---

### Task 6: Config + bypassCache contract

**Files:**
- Modify: `apps/backtester/src/config.ts` (add `dedupEnabled`)
- Modify: `packages/sdk/src/contracts/run.ts` (add `bypassCache?`)
- Modify: `apps/backtester/src/jobs/submit.ts` (pass `bypassCache` into the stored request)
- Test: `apps/backtester/test/config-dedup.test.ts`

**Interfaces:**
- Produces: `AppConfig.dedupEnabled: boolean`; `RunSubmitRequest.bypassCache?: boolean`.

- [ ] **Step 1: Write the failing config test**

`apps/backtester/test/config-dedup.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { requestFingerprint } from '../src/jobs/fingerprint';

describe('dedup config + bypassCache', () => {
  it('dedupEnabled defaults to false', () => {
    expect(loadConfig({}).dedupEnabled).toBe(false);
  });
  it('dedupEnabled true only for "true"', () => {
    expect(loadConfig({ BACKTESTER_DEDUP_ENABLED: 'true' }).dedupEnabled).toBe(true);
    expect(loadConfig({ BACKTESTER_DEDUP_ENABLED: '1' }).dedupEnabled).toBe(false);
  });
  it('bypassCache does NOT change the request fingerprint', () => {
    const base = {
      mode: 'research', moduleRef: { id: 'm', version: '1.0.0' }, datasetRef: 'd',
      symbols: ['BTCUSDT'], timeframe: '1m', period: { from: 'a', to: 'b' }, seed: 1,
    } as any;
    expect(requestFingerprint({ ...base, bypassCache: true })).toBe(requestFingerprint(base));
  });
});
```

- [ ] **Step 2: Run — FAIL** (`dedupEnabled` undefined).

- [ ] **Step 3: Add `dedupEnabled` to config**

In `apps/backtester/src/config.ts` (read with `cat` to place precisely): add to the `AppConfig` interface:
```ts
  /** Enable the fingerprint-based result-dedup cache. Default false (dark launch). */
  readonly dedupEnabled: boolean;
```
and in `loadConfig`'s returned object literal:
```ts
    dedupEnabled: env.BACKTESTER_DEDUP_ENABLED === 'true',
```

- [ ] **Step 4: Add `bypassCache` to the SDK contract**

In `packages/sdk/src/contracts/run.ts`, add to `RunSubmitRequest` (read the interface first):
```ts
  /** Force a fresh compute, bypassing the result-dedup cache. Not run-affecting (excluded from the
   *  fingerprint); a bypassed run still populates the cache on completion. */
  readonly bypassCache?: boolean;
```
`fingerprint.ts::normalize` does not read `bypassCache`, so the fingerprint is already unaffected (the test in Step 1 proves it). No fingerprint change needed.

- [ ] **Step 5: Thread `bypassCache` into the stored request in submit.ts**

`submit.ts` already spreads `...rest` (which includes `bypassCache`) into `request: { ...rest, runId, metrics }`. Confirm by reading `submit.ts` — the stored `job.request.bypassCache` is thus available to the worker with no code change. If `bypassCache` is stripped anywhere, add it explicitly to the stored `request`. No test beyond Step 1 required (worker consumption is tested in Task 7).

- [ ] **Step 6: Run + typecheck + commit**

Run: `pnpm vitest run apps/backtester/test/config-dedup.test.ts` → PASS. `pnpm typecheck` → PASS (SDK rebuild via pretypecheck).
```bash
git add apps/backtester/src/config.ts packages/sdk/src/contracts/run.ts apps/backtester/test/config-dedup.test.ts
git commit -m "feat(dedup): dedupEnabled config + bypassCache contract (not run-affecting)"
```

---

### Task 7: Worker restructure — dedup gate + finalizeResult extraction

This is the integration task. **Read `apps/backtester/src/jobs/worker.ts` in full first** (`cat apps/backtester/src/jobs/worker.ts`). The current `processNextQueued`: claims, loads `sandboxBundle` EARLY when `bundleHash` is set, then per-engine branches each materialize a tape, compute `dsFingerprint`, build a registry/executor, run the engine, then persist + build a summary, then `transition(...'completed'...)` + `publishCompletion`.

**Files:**
- Modify: `apps/backtester/src/jobs/worker.ts`
- Test: `apps/backtester/test/dedup-worker.test.ts`

**Interfaces:**
- Consumes: `normalize`/`restamp`/`DedupTemplate` (Task 1), `computeIdentity` (Task 3), `ResultCache`/`CacheEntry` (Task 4), `RUNID_SENTINEL`/versions (Task 1).
- Produces: `WorkerDeps` gains `resultCache?: ResultCache` and `dedupEnabled?: boolean`. Extracted internal functions `materializeFor`, `executeEngine`, `finalizeResult` (module-private; no external contract).

- [ ] **Step 1: Extract `finalizeResult` (pure refactor — no behavior change)**

Refactor the three engine branches so the **post-payload** work (persist artifacts + build the `RunResultSummary` + `resultHash`) lives in one function:
```ts
interface Finalized { summary: RunResultSummary; manifest: ArtifactManifest; resultHash: ContentHash; }

async function finalizeResult(
  deps: WorkerDeps,
  engine: 'momentum' | 'overlay' | 'strategy',
  payload: unknown,           // BacktestResult (momentum) | RunOutcome (overlay/strategy)
  claimed: JobRow,
  datasetFingerprint: string,
  evidenceRef?: ArtifactReference,
): Promise<Finalized>
```
Move the EXISTING persist+summary code from each branch into this function unchanged (momentum → `persistRunArtifacts` + the inline momentum summary; overlay/strategy → `persistOverlayArtifacts` + `toOverlaySummary`). `resultHash = contentRef(payload)` computed inside. Each engine branch now: run engine → `payload` → `finalizeResult(...)`. Run the FULL existing worker test suite to prove no behavior change:

Run: `pnpm vitest run apps/backtester/test/worker-loop.test.ts apps/backtester/test/momentum-guardrail.test.ts apps/backtester/test/overlay-golden.test.ts apps/backtester/test/determinism.test.ts`
Expected: all PASS (goldens unchanged). Commit this pure refactor separately:
```bash
git add apps/backtester/src/jobs/worker.ts
git commit -m "refactor(worker): extract finalizeResult (persist + summary) — no behavior change"
```

- [ ] **Step 2: Extract `materializeFor` and hoist it above the engine branches**

Extract the per-engine "materialize tape/dataset + compute `datasetFingerprint`" into:
```ts
interface Materialized { engine: 'momentum'|'overlay'|'strategy'; datasetFingerprint: string; payloadInputs: /* tape/dataset + engineRequest bits */ }
async function materializeFor(deps: WorkerDeps, claimed: JobRow): Promise<Materialized>
```
so `processNextQueued` calls `materializeFor` ONCE, before any sandbox/engine work, and passes the result into the (miss-path) engine execution. Keep `overlayTapeCache`/`momentumTapeCache` usage identical. Re-run the same suite as Step 1 → PASS. Commit:
```bash
git commit -am "refactor(worker): extract materializeFor and hoist before engine execution"
```

- [ ] **Step 3: Write the failing dedup-worker test**

`apps/backtester/test/dedup-worker.test.ts` — drives `processNextQueued` twice with the SAME momentum request (distinct runIds) through an `InMemoryJobStore` + `InMemoryResultCache` + spies. Read `worker-loop.test.ts` with `cat` to copy the worker-deps construction. Assertions:
```ts
// (sketch — fill deps from worker-loop.test.ts)
it('second identical run HITS the cache and skips engine/sandbox work', async () => {
  const cache = new InMemoryResultCache();
  const deps = makeWorkerDeps({ resultCache: cache, dedupEnabled: true });
  const runBacktestSpy = vi.spyOn(runBacktestModule, 'runBacktest');

  await enqueue(deps, { ...REQ, runId: 'run-AAAAAAAA' });
  await processNextQueued(deps);          // MISS — runs engine, populates cache
  expect(runBacktestSpy).toHaveBeenCalledTimes(1);

  await enqueue(deps, { ...REQ, runId: 'run-BBBBBBBB' });
  await processNextQueued(deps);          // HIT — must NOT run the engine again
  expect(runBacktestSpy).toHaveBeenCalledTimes(1);

  const b = await deps.store.get('run-BBBBBBBB');
  expect(b.status).toBe('completed');
  // result_hash is runId-stamped, so B's hash is NOT A's — it must equal a FRESH run(B)'s hash.
  // freshRun/contentRef are the Task 2 helpers (import them here too).
  const freshHashB = contentRef(await freshRun('run-BBBBBBBB'));
  expect(b.resultHash).toBe(freshHashB);
  expect(b.dedupedFrom).toBeDefined();     // provenance recorded on the job row
});
```
Also add these cases:
- **HIT skips ALL compute (not just the engine):** inject spies on `sandboxBundleFor`, `executorFor`, and the executor router; on the hit assert each is `not.toHaveBeenCalled()`. This is the test that catches an incomplete restructuring where the bundle loads early.
- **Kill-switch off:** with `dedupEnabled:false`, the second identical run also runs the engine (`runBacktestSpy` called twice; no cache read/write).
- **Never-cache failure:** a run whose engine throws ends `failed` and writes NO cache row (`await cache.lookup(identity)` is `undefined`).

- [ ] **Step 4: Run — FAIL** (the dedup gate doesn't exist yet).

- [ ] **Step 5: Insert the dedup gate + move `sandboxBundleFor` to the miss-path + populate on miss**

In `processNextQueued`, after `materializeFor` and before any bundle/engine work:
```ts
const materialized = await materializeFor(deps, claimed);
const dedupOn = deps.dedupEnabled === true && deps.resultCache !== undefined;
// bypassCache skips the LOOKUP (force fresh) but a fresh successful run still POPULATES the cache below.
const doLookup = dedupOn && claimed.request.bypassCache !== true;
const policy = deps.overlaySandbox.policy;
const sandboxPolicyVersion = `${policy.id}@${policy.version}`;
const engine = engineOf(claimed);  // 'momentum' | 'overlay' | 'strategy'

let finalized: Finalized | undefined;
let dedupedFrom: string | undefined;
if (doLookup) {
  const identity = computeIdentity({
    requestFingerprint: claimed.requestFingerprint,
    datasetFingerprint: materialized.datasetFingerprint,
    sandboxPolicyVersion,
  });
  const hit = await deps.resultCache!.lookup(identity);
  if (hit) {
    const template = (await deps.artifactStore.read(hit.templateRef)) as DedupTemplate;
    if (template.engine === engine && template.templateVersion === DEDUP_TEMPLATE_VERSION) {
      const payload = restamp(template, runId);                 // NO sandboxBundleFor / executor / engine
      finalized = await finalizeResult(deps, engine, payload, claimed, materialized.datasetFingerprint);
      dedupedFrom = hit.computeIdentity;
    }
  }
}

if (!finalized) {
  // MISS PATH — the ONLY place sandbox/bundle/engine work happens
  const sandboxBundle = claimed.bundleHash !== undefined ? await sandboxBundleFor(deps, claimed.bundleHash) : undefined;
  try {
    const payload = await executeEngine(deps, claimed, materialized, sandboxBundle);
    finalized = await finalizeResult(deps, engine, payload, claimed, materialized.datasetFingerprint /*, evidenceRef */);
    if (dedupOn) {   // populate on ANY completed fresh run — INCLUDING a bypassCache run (bypass skips lookup, not populate)
      const normalized = normalize(engine, payload, runId);
      const templateRef = await deps.artifactStore.write(normalized);
      await deps.resultCache!.put({
        computeIdentity: computeIdentity({ requestFingerprint: claimed.requestFingerprint, datasetFingerprint: materialized.datasetFingerprint, sandboxPolicyVersion }),
        requestFingerprint: claimed.requestFingerprint,
        datasetFingerprint: materialized.datasetFingerprint,
        computeVersion: DEDUP_COMPUTE_VERSION,
        sandboxPolicyVersion,
        templateRef,
        createdAtMs: deps.clock(),
      });
    }
  } finally { /* existing cleanup: sandboxBundle?.cleanup(), router.closeAll(), executor.close() */ }
}
// shared terminal transition (existing), passing finalized.summary/resultHash/manifest + dedupedFrom
```
The terminal `transition(runId, 'running', 'completed', {...})` is now SHARED by hit and miss. Pass `dedupedFrom` through to the job row (the `transition` terminal-update writes `deduped_from` — add the column write in `pg-job-store.ts::transition` and the `JobRow.dedupedFrom` field; for `InMemoryJobStore` store it on the row). The cache `put` runs only on a `completed` outcome — because it is inside the miss-path try before the catch; a thrown engine error skips `put` (never caches failed/timeout/validation_error). Keep the existing `catch` (terminal failure) and `finally` (cleanup) exactly as before.

- [ ] **Step 6: Run — PASS** (`pnpm vitest run apps/backtester/test/dedup-worker.test.ts`) and re-run the golden suite from Step 1 → PASS (dedup off by default in those tests ⇒ unchanged). Typecheck PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/backtester/src/jobs/worker.ts apps/backtester/src/jobs/job-store.ts apps/backtester/src/jobs/pg-job-store.ts apps/backtester/test/dedup-worker.test.ts
git commit -m "feat(dedup): worker dedup gate — HIT re-stamps (skips sandbox/engine), MISS populates cache"
```

---

### Task 8: buildApp wiring + docs + full gate

**Files:**
- Modify: `apps/backtester/src/app.ts` (construct `ResultCache`, thread `dedupEnabled` into `WorkerDeps`)
- Modify: `docs/OPERATIONS.md`, `docs/ROADMAP.md`

**Interfaces:**
- Consumes: `PgResultCache`/`InMemoryResultCache` (Tasks 4–5), `WorkerDeps.{resultCache,dedupEnabled}` (Task 7).

- [ ] **Step 1: Wire the cache into buildApp**

In `apps/backtester/src/app.ts` (read with `cat`; the store selection already branches on `config.databaseUrl`): construct the cache next to the job store —
```ts
const resultCache = ownedPool ? new PgResultCache(ownedPool) : new InMemoryResultCache();
```
and add to the `workerDeps` object: `resultCache, dedupEnabled: config.dedupEnabled,`. Add the imports. (When `overrides.store` is supplied without a pool, default to `new InMemoryResultCache()`.)

**Migration lifecycle (must hold):** `PgResultCache` MUST use the SAME `ownedPool` on which `buildApp` already ran `migrate(ownedPool)` before constructing `PgJobStore`. `migrate()` applies every file in `apps/backtester/migrations/` (including the new `0004`) against `ownedPool` at startup, so constructing `PgResultCache(ownedPool)` after that call guarantees the cache table + `deduped_from` column exist in the same lifecycle — an app pointed at a Postgres with an older schema will not hit a dedup lookup/put against a missing table. Do NOT construct a separate pool for the cache.

- [ ] **Step 2: Verify no regression + kill-switch default**

Run: `pnpm vitest run apps/backtester/test/lifecycle.test.ts apps/backtester/test/worker-loop.test.ts`
Expected: PASS (dedup defaults OFF → behavior unchanged). Typecheck PASS.

- [ ] **Step 3: Docs**

Append to `docs/OPERATIONS.md` a "Result dedup (Phase C item 11)" subsection: enable with `BACKTESTER_DEDUP_ENABLED=true` (default off); it caches only successful `completed` runs keyed by `requestFingerprint + datasetFingerprint + DEDUP_COMPUTE_VERSION + sandbox policy`; invalidate by bumping `DEDUP_COMPUTE_VERSION`; per-request `bypassCache` forces fresh compute; `result_hash` is unchanged (re-stamped per run). In `docs/ROADMAP.md`, mark Phase C item 11 in-progress with a pointer to the design + this plan.

- [ ] **Step 4: Commit**

```bash
git add apps/backtester/src/app.ts docs/OPERATIONS.md docs/ROADMAP.md
git commit -m "feat(dedup): wire ResultCache into buildApp + OPERATIONS/ROADMAP docs"
```

---

### Task 9: Full-suite gate

- [ ] **Step 1: Run the full check**

Run: `pnpm check`
Expected: PASS — typecheck clean; full vitest green including the new dedup tests and the equivalence goldens; existing goldens (`eff10116…`, overlay-golden, determinism) unchanged. Dedup Docker-gated cases skip in WSL2.

- [ ] **Step 2: Fix forward if needed**

Investigate any failure with systematic-debugging; never weaken an assertion or a golden to make it pass. Re-run `pnpm check` until green, committing each fix.

---

## Self-Review

**Spec coverage:**
- §5 worker restructuring (hoist materialize+fingerprint, dedup gate, `sandboxBundleFor`→miss-path, `finalizeResult` shared) → Task 7 (Steps 1–2 pure refactors, Step 5 gate).
- §6 computeIdentity (fingerprint + datasetFingerprint + computeVersion + sandboxPolicyVersion) → Task 3.
- §7 `DEDUP_COMPUTE_VERSION` dedicated constant + bump rule → Task 1 (version.ts).
- §8 `DedupTemplate` typed union + `normalize`/`restamp` + per-path equivalence golden → Tasks 1, 2.
- §9 `dedupedFrom` on job row + event, never in the hashed payload / not in `RunResultSummary` → Task 7 Step 5.
- §10 `backtest_result_cache` table + template in artifact store + `ResultCache`/`InMemory`/`Pg` → Tasks 4, 5.
- §11 `dedupEnabled` default false + `bypassCache` not run-affecting → Task 6.
- §12 tests (equivalence golden; HIT skips sandbox/executor/router/engine; MISS populates; identity sensitivity; never-cache negatives; cache conformance; kill-switch off identical) → Tasks 2, 3, 4/5, 6, 7.
- §13 deliverables incl. buildApp wiring + docs → Task 8.
- Invariants: goldens re-run in Task 7 Steps 1–2 and Task 9; `result_hash` pinned by the equivalence golden; sandbox/queue files untouched.

**Placeholder scan:** Task 7's worker code is shown as the target gate + extractions with exact new code; the two pre-refactors (Steps 1–2) are behavior-preserving and gated by re-running existing goldens. The `cat`-first instruction is because the `Read` tool is hook-blocked here — the implementer transcribes the existing branch bodies into `finalizeResult`/`materializeFor` unchanged. No TBD/"handle edge cases".

**Type consistency:** `DedupTemplate.{engine,payloadKind,templateVersion,normalizedPayload}`, `normalize(engine,payload,runId)`, `restamp(template,runId)`, `computeIdentity({requestFingerprint,datasetFingerprint,sandboxPolicyVersion})`, `CacheEntry`/`ResultCache.{lookup,put}`, `WorkerDeps.{resultCache,dedupEnabled}`, `AppConfig.dedupEnabled`, `RunSubmitRequest.bypassCache`, `finalizeResult(...)→Finalized{summary,manifest,resultHash}` are used identically across tasks.

**Note for the implementer (Task 7):** the `Read` tool is denied by the Gortex hook in this repo — use `cat`/`sed`/`grep` via Bash to read `worker.ts`, `pg-job-store.ts`, `worker-loop.test.ts`, `overlay-golden.test.ts` before editing. Do the two pure refactors (finalizeResult, materializeFor) as separate green commits BEFORE adding the gate, so a reviewer can see the behavior-preserving steps in isolation.
