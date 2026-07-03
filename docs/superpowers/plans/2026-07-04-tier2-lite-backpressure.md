# Tier 2 Lite Backpressure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pg pool knob + statement timeout, resumeToken pre-lookup before bundle writes, queue-depth cap → 429/Retry-After with a distinct `rate_limit` category, and safe SDK retry/backoff.

**Architecture:** `JobStore.findByResumeToken` powers a cheap replay pre-lookup in `submitRun` (anchored flow: validate → fingerprint → replay/409 → cap 429 → bundle put → insertOrGet). `SubmitError` gains `category`/`retryAfterS` so the route stops hard-coding `validation_error`. `createPool` gains options threaded only from the app path. The SDK retry engine lives inside `BacktesterClient.request` with an idempotency flag; `FetchLikeResponse` gains an optional `headers` getter for numeric `Retry-After`.

**Tech Stack:** TypeScript (Node 24, ESM), vitest, pg, Fastify.

**Spec:** `docs/superpowers/specs/2026-07-04-tier2-lite-backpressure-design.md` (rev 2 — anchored flow, `rate_limit` category, numeric-only Retry-After).

## Global Constraints

- Defaults preserve today's behavior EXACTLY: `BACKTESTER_PG_POOL_MAX=10`, `BACKTESTER_PG_STATEMENT_TIMEOUT_MS=0` (off), `BACKTESTER_QUEUE_MAX_DEPTH=0` (unlimited), `BACKTESTER_QUEUE_RETRY_AFTER_S=30`.
- Anchored submit flow: `validate → requestFingerprint → [resumeToken? findByResumeToken → replay/409] → [new AND cap hit ⇒ 429, NO bundle write] → bundleStore.put → insertOrGet`.
- 429 body: `{ category: 'rate_limit', code: 'queue_full', message, queueDepth, maxDepth }` + `Retry-After: <s>` header. Existing errors keep `category: 'validation_error'` (including the 409 — do NOT silently change its category).
- Replays with a matching resumeToken NEVER see the cap and NEVER write a bundle.
- SDK: retries default ON, only provably-safe cases (429 always; network/502-504 only for GET or POST with `resumeToken`); only NUMERIC-seconds `Retry-After` honored (HTTP-date → backoff fallback), documented.
- Migrations exempt from statement timeout (only `app.ts` threads pool opts).
- Work on branch `feat/tier2-lite-backpressure` from main (created in Task 1). Imports in apps/backtester use `.js` suffixes; SDK client files use extensionless relative imports (match each file's existing style). Tests from REPO ROOT: `pnpm vitest run apps/backtester/test/<file>`; full gate `pnpm check`. Use plain Read/Edit/Write tools (never MCP edit tools). Commit trailer on every commit: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: `JobStore.findByResumeToken` (interface + both stores + conformance)

**Files:**
- Modify: `apps/backtester/src/jobs/job-store.ts` (interface ~line 131, `InMemoryJobStore` below it — it keeps a `byKey` map of `resumeToken ?? runId` → runId)
- Modify: `apps/backtester/src/jobs/pg-job-store.ts` (next to `get`, ~line 182)
- Test: `apps/backtester/test/find-by-resume-token.test.ts` (new, parametrized over `STORE_FACTORIES` — mirror the seeding style of `test/queue-stats.test.ts` / `test/idempotency.test.ts`)

**Interfaces:**
- Produces: `findByResumeToken(resumeToken: string): Promise<JobRow | undefined>` on the `JobStore` interface — Task 3 calls it in `submitRun`.

- [ ] **Step 0: Create the branch**

```bash
cd /home/alexxxnikolskiy/projects/trading-backtester
git checkout -b feat/tier2-lite-backpressure main
```

- [ ] **Step 1: Write the failing test**

```typescript
// apps/backtester/test/find-by-resume-token.test.ts
// findByResumeToken conformance over both stores (Pg leg auto-skips without a DB).
import { describe, expect, it } from 'vitest';
import { STORE_FACTORIES } from './store-factories.js';

for (const factory of STORE_FACTORIES) {
  describe.skipIf(!factory.available)(`findByResumeToken (${factory.name})`, () => {
    it('returns undefined when no job carries the token', async () => {
      const { store, teardown } = await factory.create();
      try {
        expect(await store.findByResumeToken('tok-none')).toBeUndefined();
      } finally {
        await teardown();
      }
    });

    it('returns the job inserted with the token, and does not match runId or other tokens', async () => {
      const { store, teardown } = await factory.create();
      try {
        // Seed two jobs via insertOrGet — one WITH resumeToken 'tok-a', one WITHOUT (keyed by runId).
        // Mirror the NewJob literal shape used by test/queue-stats.test.ts's seedJob helper VERBATIM
        // (same required fields), only varying runId/resumeToken.
        // ... seedJob(1, { resumeToken: 'tok-a' }); seedJob(2) ...
        const hit = await store.findByResumeToken('tok-a');
        expect(hit?.resumeToken).toBe('tok-a');
        expect(await store.findByResumeToken(/* job 2's runId */ 'run-2')).toBeUndefined();
      } finally {
        await teardown();
      }
    });
  });
}
```

(Copy the `seedJob` helper from `test/queue-stats.test.ts` verbatim and extend it with an optional `resumeToken` — do not invent new field values. The two assertions — token hit returns the row, a runId does NOT match as a token — must stay.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run apps/backtester/test/find-by-resume-token.test.ts`
Expected: FAIL — `findByResumeToken is not a function` (in-memory leg).

- [ ] **Step 3: Implement — interface + InMemory**

Interface (job-store.ts, after `get`):

```typescript
  /** Cheap replay pre-lookup: the job previously inserted with this resumeToken, if any. */
  findByResumeToken(resumeToken: string): Promise<JobRow | undefined>;
```

`InMemoryJobStore` (uses the existing `byKey` map — resumeToken keys live there):

```typescript
  async findByResumeToken(resumeToken: string): Promise<JobRow | undefined> {
    const runId = this.byKey.get(resumeToken);
    return runId ? this.jobs.get(runId) : undefined;
  }
```

CAVEAT: `byKey` also maps runId → runId for jobs WITHOUT a resumeToken. That is fine here because callers pass an actual resumeToken; but add one guard so a token that collides with a bare runId cannot false-match: after the map hit, verify `job.resumeToken === resumeToken`:

```typescript
  async findByResumeToken(resumeToken: string): Promise<JobRow | undefined> {
    const runId = this.byKey.get(resumeToken);
    const job = runId ? this.jobs.get(runId) : undefined;
    return job?.resumeToken === resumeToken ? job : undefined;
  }
```

- [ ] **Step 4: Implement — Pg** (served by partial unique index `ux_backtest_job_resume_token`)

```typescript
  async findByResumeToken(resumeToken: string): Promise<JobRow | undefined> {
    const r = await this.pool.query<JobDbRow>('SELECT * FROM backtest_job WHERE resume_token = $1', [
      resumeToken,
    ]);
    return r.rows[0] ? rowToJob(r.rows[0]) : undefined;
  }
```

- [ ] **Step 5: Run tests (both legs — Pg REQUIRED green once)**

Run: `pnpm vitest run apps/backtester/test/find-by-resume-token.test.ts`
Then: `BACKTESTER_TEST_DATABASE_URL=postgres://lab:lab@127.0.0.1:5432/backtester_perf pnpm vitest run apps/backtester/test/find-by-resume-token.test.ts`
Expected: all PASS; paste the Pg-leg output in the report. Also `grep -rn "implements JobStore" apps/backtester --include="*.ts"` — add the method to any other implementer found (copy the InMemory body).

- [ ] **Step 6: Commit**

```bash
git add apps/backtester/src/jobs/job-store.ts apps/backtester/src/jobs/pg-job-store.ts apps/backtester/test/find-by-resume-token.test.ts
git commit -m "feat(queue): JobStore.findByResumeToken — cheap replay pre-lookup (both stores)"
```

---

### Task 2: `createPool` options + config knobs (pool max, statement timeout)

**Files:**
- Modify: `apps/backtester/src/db/pool.ts` (full current file is 11 lines)
- Modify: `apps/backtester/src/config.ts` (AppConfig fields near `databaseUrl` ~line 78; loadConfig near `defaultQueueTimeoutMs` ~line 226)
- Modify: `apps/backtester/src/app.ts:69` (`ownedPool = createPool(config.databaseUrl);`)
- Test: `apps/backtester/test/pool-options.test.ts` (new)

**Interfaces:**
- Produces: `createPool(connectionString: string, schema?: string, opts?: { max?: number; statementTimeoutMs?: number }): Pool`; `AppConfig.pgPoolMax: number` (default 10), `AppConfig.pgStatementTimeoutMs: number` (default 0 = off).

- [ ] **Step 1: Write the failing test**

```typescript
// apps/backtester/test/pool-options.test.ts
import { describe, expect, it } from 'vitest';
import { createPool } from '../src/db/pool.js';
import { PG_AVAILABLE } from './store-factories.js';

const PG_URL = process.env.BACKTESTER_TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe('createPool options', () => {
  it('threads max and statement_timeout into the pool config', () => {
    const pool = createPool('postgres://u:p@localhost:5/db', undefined, { max: 7, statementTimeoutMs: 1234 });
    expect(pool.options.max).toBe(7);
    expect(pool.options.options).toContain('statement_timeout=1234');
    void pool.end();
  });

  it('combines schema search_path with statement_timeout in one options string', () => {
    const pool = createPool('postgres://u:p@localhost:5/db', 'myschema', { statementTimeoutMs: 500 });
    expect(pool.options.options).toContain('search_path=myschema');
    expect(pool.options.options).toContain('statement_timeout=500');
    void pool.end();
  });

  it('defaults preserve today: no opts → no options string beyond schema, pg default max', () => {
    const pool = createPool('postgres://u:p@localhost:5/db');
    expect(pool.options.options).toBeUndefined();
    expect(pool.options.max).toBeUndefined();
    void pool.end();
  });
});

describe.skipIf(!PG_AVAILABLE)('createPool statement_timeout (Postgres conformance)', () => {
  it('SHOW statement_timeout reflects the option on a live connection', async () => {
    const pool = createPool(PG_URL as string, undefined, { statementTimeoutMs: 4321 });
    try {
      const r = await pool.query<{ statement_timeout: string }>('SHOW statement_timeout');
      expect(r.rows[0]!.statement_timeout).toBe('4321ms');
    } finally {
      await pool.end();
    }
  });

  it('no-opts pool shows 0 (off) — the migrations-exempt path', async () => {
    const pool = createPool(PG_URL as string);
    try {
      const r = await pool.query<{ statement_timeout: string }>('SHOW statement_timeout');
      expect(r.rows[0]!.statement_timeout).toBe('0');
    } finally {
      await pool.end();
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run apps/backtester/test/pool-options.test.ts`
Expected: FAIL — opts argument not accepted / options undefined.

- [ ] **Step 3: Implement pool.ts**

```typescript
import { Pool, type PoolConfig } from 'pg';

/**
 * Create a pg Pool. When `schema` is given, every connection starts with that search_path (via the
 * libpq `options` startup param) — used by tests to isolate each run in a throwaway schema.
 * opts.max caps pool connections (pg default 10); opts.statementTimeoutMs sets a per-connection
 * statement_timeout (0/omitted = off). Migration call sites intentionally pass NO opts — DDL must
 * never inherit the app-path timeout.
 */
export function createPool(
  connectionString: string,
  schema?: string,
  opts?: { max?: number; statementTimeoutMs?: number },
): Pool {
  const config: PoolConfig = { connectionString };
  const startup: string[] = [];
  if (schema) startup.push(`-c search_path=${schema}`);
  if (opts?.statementTimeoutMs && opts.statementTimeoutMs > 0) {
    startup.push(`-c statement_timeout=${opts.statementTimeoutMs}`);
  }
  if (startup.length > 0) config.options = startup.join(' ');
  if (opts?.max !== undefined) config.max = opts.max;
  return new Pool(config);
}
```

- [ ] **Step 4: Config fields**

`AppConfig` (after `readonly databaseUrl?: string;`):

```typescript
  /** Max pooled Pg connections per process (pg default 10; raise with worker fleet math). */
  readonly pgPoolMax: number;
  /** statement_timeout (ms) on app-pool connections; 0 = off. Migrations are exempt by construction. */
  readonly pgStatementTimeoutMs: number;
```

`loadConfig` (next to `defaultQueueTimeoutMs`, same `Number(env.X ?? default)` style):

```typescript
    pgPoolMax: Math.max(1, Number(env.BACKTESTER_PG_POOL_MAX ?? 10) || 10),
    pgStatementTimeoutMs: Math.max(0, Number(env.BACKTESTER_PG_STATEMENT_TIMEOUT_MS ?? 0) || 0),
```

(Clamped, not bare `Number`: pool max is never < 1; timeout never negative; NaN from garbage env falls back to the default via `|| default` / `|| 0`.) Add two assertions to the pool-options test file's unit section:

```typescript
  it('clamps garbage env-derived values (pool max >= 1, timeout >= 0)', () => {
    const pool = createPool('postgres://u:p@localhost:5/db', undefined, { max: 0, statementTimeoutMs: -5 });
    expect(pool.options.max).toBe(1);            // createPool itself clamps too
    expect(pool.options.options).toBeUndefined(); // negative timeout = off
    void pool.end();
  });
```

and mirror the clamp inside `createPool` (`config.max = Math.max(1, opts.max)`; timeout only applied when `> 0` — already the case).

`app.ts:69` — the ONLY production caller (migrate keeps the same `ownedPool`? NO — verify: `migrate(ownedPool)` runs on the app pool at app.ts:70. The timeout would apply to migrations!). **Resolution (required):** construct the app pool WITHOUT the timeout first for `migrate`, or run migrate on a separate short-lived no-opts pool. Implement the latter — explicit and safe:

```typescript
    if (config.databaseUrl) {
      // Migrations run on a dedicated no-opts pool: DDL must never inherit statement_timeout.
      const migrationPool = createPool(config.databaseUrl);
      try {
        await migrate(migrationPool);
      } finally {
        await migrationPool.end();
      }
      ownedPool = createPool(config.databaseUrl, undefined, {
        max: config.pgPoolMax,
        statementTimeoutMs: config.pgStatementTimeoutMs,
      });
      store = new PgJobStore(ownedPool);
    } else {
```

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run apps/backtester/test/pool-options.test.ts` (unit legs) and with `BACKTESTER_TEST_DATABASE_URL=postgres://lab:lab@127.0.0.1:5432/backtester_perf` (Pg legs REQUIRED green — paste output). Then `npx tsc --noEmit -p apps/backtester`. Then run one Pg-touching app suite to prove the migrate-split works end-to-end: `BACKTESTER_TEST_DATABASE_URL=... pnpm vitest run apps/backtester/test/idempotency.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add apps/backtester/src/db/pool.ts apps/backtester/src/config.ts apps/backtester/src/app.ts apps/backtester/test/pool-options.test.ts
git commit -m "feat(db): BACKTESTER_PG_POOL_MAX + statement timeout knobs (app pool only; migrations exempt)"
```

---

### Task 3: Replay pre-lookup + SubmitError category/retryAfterS + route mapping

**Files:**
- Modify: `apps/backtester/src/jobs/submit.ts` (`SubmitError` class lines 12–21; `submitRun` lines 109–166)
- Modify: `apps/backtester/src/api/server.ts` (POST /v1/runs handler lines 93–104)
- Test: `apps/backtester/test/idempotency.test.ts` (extend — replay must not write a bundle)

**Interfaces:**
- Consumes: `findByResumeToken` (Task 1).
- Produces: `SubmitError` constructor `(statusCode, code, message, opts?: { category?: string; retryAfterS?: number })` with `readonly category: string` (default `'validation_error'`) and `readonly retryAfterS?: number`. Route sends `category: err.category` and sets `Retry-After` when `err.retryAfterS` is present. A shared `assertReplayFingerprint(job, fingerprint)` helper used by BOTH the pre-lookup and the `!created` backstop. Task 4 builds the 429 on top.

- [ ] **Step 1: Write the failing test**

Extend `test/idempotency.test.ts` (inside the existing `for (const factory of STORE_FACTORIES)` loop, mirroring its `makeApp`/`runBody`/`AUTH` fixtures):

```typescript
    it('ESTABLISHED replay with matching resumeToken does not re-write the bundle (pre-lookup path; a concurrent first-submit race may still pay one put before the insertOrGet backstop — out of scope here)', async () => {
      const { app, cleanup } = await makeApp(factory);
      try {
        const payload = runBody({ resumeToken: 'tok-pre' });
        const first = await app.server.inject({ method: 'POST', url: '/v1/runs', headers: AUTH, payload });
        expect(first.statusCode).toBe(202);
        // Spy AFTER the first submit: the replay must not touch the bundle store at all.
        const putSpy = vi.spyOn(app.workerDeps.bundleStore!, 'put'); // adapt to AppHandles' actual shape (src/app.ts)
        const replay = await app.server.inject({ method: 'POST', url: '/v1/runs', headers: AUTH, payload });
        expect(replay.statusCode).toBe(202);
        expect((replay.json() as RunJobHandle).idempotentReplay).toBe(true);
        expect(putSpy).not.toHaveBeenCalled();
      } finally {
        await cleanup();
      }
    });
```

(Adapt the `app.deps.bundleStore` access to what `makeApp` actually exposes — check `test/helpers.ts`; if the deps object isn't exposed, spy on the store via the handle `makeApp` returns or extend the helper minimally, following its existing style. If `runBody` doesn't include a `moduleBundle`, use the variant the file already uses for bundle submits — the test MUST exercise a body that would otherwise call `bundleStore.put`. The 409 mismatch tests already in the file must stay green unchanged.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run apps/backtester/test/idempotency.test.ts`
Expected: the new test FAILS (today the replay path calls `bundleStore.put` before `insertOrGet`); existing tests PASS.

- [ ] **Step 3: Implement — SubmitError + helper + pre-lookup**

`SubmitError` (back-compat: existing `throw new SubmitError(400, 'validation_error', msg)` call sites keep working unchanged):

```typescript
export class SubmitError extends Error {
  readonly category: string;
  readonly retryAfterS?: number;
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    opts?: { category?: string; retryAfterS?: number },
  ) {
    super(message);
    this.name = 'SubmitError';
    this.category = opts?.category ?? 'validation_error';
    if (opts?.retryAfterS !== undefined) this.retryAfterS = opts.retryAfterS;
  }
}
```

Shared mismatch check (module-level, submit.ts):

```typescript
/** Replay contract: same resumeToken must carry the same run-affecting request. */
function assertReplayFingerprint(job: JobRow, fingerprint: string): void {
  if (storedRequestFingerprint(job.request, job.bundleHash ?? null) !== fingerprint) {
    throw new SubmitError(409, 'resume_token_conflict', 'resume token reused with a different request');
  }
}
```

In `submitRun`, insert the pre-lookup right after `const now = deps.clock();` and BEFORE the bundle-store block (anchored flow):

```typescript
  // Anchored flow: cheap replay pre-lookup BEFORE any bundle write. Guarantee is for ESTABLISHED
  // replays (the token's job already exists): they re-attach without paying bundleStore.put and
  // (Task 4) without seeing the queue cap. A CONCURRENT first-submit race (two initial submits with
  // one token, neither committed yet) may still pay one extra bundle put before the insertOrGet
  // backstop below deduplicates the job — accepted; content-addressed puts are idempotent.
  if (body.resumeToken !== undefined) {
    const existing = await deps.store.findByResumeToken(body.resumeToken);
    if (existing) {
      assertReplayFingerprint(existing, fingerprint);
      return { handle: toHandle(existing, true), created: false };
    }
  }
```

Replace the `!created` block's inline check with the SAME helper (race backstop — two concurrent first-submits with one token):

```typescript
  const { job, created } = await deps.store.insertOrGet(newJob);
  if (!created) {
    assertReplayFingerprint(job, fingerprint);
    return { handle: toHandle(job, true), created: false };
  }
```

- [ ] **Step 4: Implement — route mapping**

server.ts POST /v1/runs catch:

```typescript
    } catch (err) {
      if (err instanceof SubmitError) {
        if (err.retryAfterS !== undefined) reply.header('retry-after', String(err.retryAfterS));
        return reply.code(err.statusCode).send({ category: err.category, code: err.code, message: err.message });
      }
      throw err;
    }
```

(Behavior today is unchanged: every existing SubmitError defaults to `category: 'validation_error'`, no header. The 409 keeps its current category.)

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run apps/backtester/test/idempotency.test.ts apps/backtester/test/restart-idempotency.test.ts apps/backtester/test/api.e2e.test.ts && npx tsc --noEmit -p apps/backtester`
Expected: PASS / clean (replay handles byte-identical: same runId, `idempotentReplay: true`).

- [ ] **Step 6: Commit**

```bash
git add apps/backtester/src/jobs/submit.ts apps/backtester/src/api/server.ts apps/backtester/test/idempotency.test.ts
git commit -m "feat(queue): resumeToken replay pre-lookup before bundle write + SubmitError category/retryAfterS"
```

---

### Task 4: Queue-depth cap → 429 queue_full

**Files:**
- Modify: `apps/backtester/src/config.ts` (two fields next to Task 2's), `apps/backtester/src/jobs/submit.ts` (`SubmitDeps` + cap check), `apps/backtester/src/app.ts` (thread the two values into the `buildServer({...})` deps — same object that carries `defaultQueueTimeoutMs`)
- Test: `apps/backtester/test/queue-cap.test.ts` (new, factory-parametrized)

**Interfaces:**
- Consumes: `countQueueStats` (shipped in #79), Task 3's pre-lookup + SubmitError opts.
- Produces: `AppConfig.queueMaxDepth: number` (default 0), `AppConfig.queueRetryAfterS: number` (default 30); `SubmitDeps.queueMaxDepth?: number`, `SubmitDeps.queueRetryAfterS?: number`.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/backtester/test/queue-cap.test.ts
// Queue-depth cap → 429 queue_full (rate_limit category, Retry-After) with resumeToken-replay bypass.
// Mirrors idempotency.test.ts fixtures (makeApp/runBody/AUTH) — copy them verbatim.
import { describe, expect, it } from 'vitest';
import { STORE_FACTORIES } from './store-factories.js';
// + the same imports idempotency.test.ts uses for makeApp/runBody/AUTH/RunJobHandle

for (const factory of STORE_FACTORIES) {
  describe.skipIf(!factory.available)(`queue cap (${factory.name})`, () => {
    it('429s a NEW submit at the cap: rate_limit category, Retry-After header, nothing persisted', async () => {
      const { app, cleanup } = await makeApp(factory, {}, { queueMaxDepth: 2, queueRetryAfterS: 7 });
      try {
        await app.server.inject({ method: 'POST', url: '/v1/runs', headers: AUTH, payload: runBody({}) });
        await app.server.inject({ method: 'POST', url: '/v1/runs', headers: AUTH, payload: runBody({ seed: 2 }) });
        const third = await app.server.inject({ method: 'POST', url: '/v1/runs', headers: AUTH, payload: runBody({ seed: 3 }) });
        expect(third.statusCode).toBe(429);
        expect(third.headers['retry-after']).toBe('7');
        const body = third.json() as { category: string; code: string; queueDepth: number; maxDepth: number };
        expect(body.category).toBe('rate_limit');
        expect(body.code).toBe('queue_full');
        expect(body.queueDepth).toBeGreaterThanOrEqual(2);
        expect(body.maxDepth).toBe(2);
        // nothing persisted: queue depth still exactly 2 (check AppHandles' shape in src/app.ts —
        // the store is exposed via the handles object, e.g. app.workerDeps.store; adapt the access)
        const stats = await app.workerDeps.store.countQueueStats(Date.now());
        expect(stats.depth).toBe(2);
      } finally {
        await cleanup();
      }
    });

    it('replay with matching resumeToken bypasses the cap', async () => {
      const { app, cleanup } = await makeApp(factory, {}, { queueMaxDepth: 1, queueRetryAfterS: 7 });
      try {
        const payload = runBody({ resumeToken: 'tok-cap' });
        const first = await app.server.inject({ method: 'POST', url: '/v1/runs', headers: AUTH, payload });
        expect(first.statusCode).toBe(202); // fills the queue to the cap
        const replay = await app.server.inject({ method: 'POST', url: '/v1/runs', headers: AUTH, payload });
        expect(replay.statusCode).toBe(202);
        expect((replay.json() as RunJobHandle).idempotentReplay).toBe(true);
      } finally {
        await cleanup();
      }
    });

    it('cap 0 = unlimited (default)', async () => {
      const { app, cleanup } = await makeApp(factory);
      try {
        for (let i = 0; i < 5; i += 1) {
          const r = await app.server.inject({ method: 'POST', url: '/v1/runs', headers: AUTH, payload: runBody({ seed: i }) });
          expect(r.statusCode).toBe(202);
        }
      } finally {
        await cleanup();
      }
    });
  });
}
```

(Third `makeApp` argument = the `over: Partial<AppConfig>` override that already exists in `test/helpers.ts` — SubmitDeps must be fed from config there like `defaultQueueTimeoutMs` is. The 429 body's extra fields ride alongside category/code/message.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run apps/backtester/test/queue-cap.test.ts`
Expected: FAIL — cap ignored, third submit 202.

- [ ] **Step 3: Implement**

Config fields + loadConfig (next to Task 2's):

```typescript
  /** Queued-jobs cap; a NEW submit beyond it gets 429 queue_full. 0 = unlimited. */
  readonly queueMaxDepth: number;
  /** Retry-After (seconds) advertised on 429. */
  readonly queueRetryAfterS: number;
```

```typescript
    queueMaxDepth: Math.max(0, Number(env.BACKTESTER_QUEUE_MAX_DEPTH ?? 0) || 0),
    queueRetryAfterS: Math.max(1, Number(env.BACKTESTER_QUEUE_RETRY_AFTER_S ?? 30) || 30),
```

(Clamped: depth never negative — 0 stays the unlimited sentinel; Retry-After never < 1s; NaN falls back to defaults.)

`SubmitDeps` gains `queueMaxDepth?: number; queueRetryAfterS?: number;` — threaded in app.ts's `buildServer({...})` (`queueMaxDepth: config.queueMaxDepth, queueRetryAfterS: config.queueRetryAfterS`) and through server.ts's deps into submitRun (follow how `defaultQueueTimeoutMs` flows — same object).

In `submitRun`, AFTER the Task-3 pre-lookup and BEFORE the bundle-store block:

```typescript
  // Backpressure backstop (approximate by design — a small race near the cap is acceptable):
  // only NEW jobs are capped; replays re-attached above never reach here.
  const cap = deps.queueMaxDepth ?? 0;
  if (cap > 0) {
    const { depth } = await deps.store.countQueueStats(now);
    if (depth >= cap) {
      throw new SubmitError(429, 'queue_full', `queue depth ${depth} >= cap ${cap}`, {
        category: 'rate_limit',
        retryAfterS: deps.queueRetryAfterS ?? 30,
        extras: { queueDepth: depth, maxDepth: cap },
      });
    }
  }
```

`SubmitError` opts (extend Task 3's version — TYPED, no casts): `opts?: { category?: string; retryAfterS?: number; extras?: Record<string, number> }` with `readonly extras?: Record<string, number>` assigned in the constructor. The ROUTE produces `{ category, code, message, queueDepth, maxDepth }` by spreading:

server.ts catch (extend Task 3's version):

```typescript
      if (err instanceof SubmitError) {
        if (err.retryAfterS !== undefined) reply.header('retry-after', String(err.retryAfterS));
        return reply.code(err.statusCode).send({ category: err.category, code: err.code, message: err.message, ...(err.extras ?? {}) });
      }
```

(The `err.extras ?? {}` spread is type-safe — no casts anywhere in this path.)

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run apps/backtester/test/queue-cap.test.ts apps/backtester/test/idempotency.test.ts apps/backtester/test/api.e2e.test.ts && npx tsc --noEmit -p apps/backtester`
Expected: PASS (both store legs where available).

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/config.ts apps/backtester/src/jobs/submit.ts apps/backtester/src/api/server.ts apps/backtester/src/app.ts apps/backtester/test/queue-cap.test.ts apps/backtester/test/helpers.ts
git commit -m "feat(queue): BACKTESTER_QUEUE_MAX_DEPTH cap — 429 queue_full (rate_limit) + Retry-After, replay bypass"
```

(Include helpers.ts only if it needed the SubmitDeps threading.)

---

### Task 5: SDK retry/backoff + RateLimit error + Retry-After (numeric only)

**Files:**
- Modify: `packages/sdk/src/client/client.ts` (options lines 31–49, `request`/`raise` lines 84–121)
- Modify: `packages/sdk/src/client/errors.ts` (add `BacktesterRateLimitError`)
- Check exports: `packages/sdk/src/client/index.ts` must re-export the new error class (mirror existing error exports).
- Test: `apps/backtester/test/sdk-client-retry.test.ts` (new — mocked-fetch pattern from `test/sdk-client-registry.test.ts`)

**Interfaces:**
- Produces: `BacktesterClientOptions.retry?: { maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number }` (defaults 3/500/10000); `FetchLikeResponse.headers?: { get(name: string): string | null }` (OPTIONAL — existing fakes stay valid); `BacktesterRateLimitError extends BacktesterError` thrown on 429; internal `sleepImpl` injectable for tests via a non-public option `retrySleepImpl?: (ms: number) => Promise<void>` (or accept `retry.sleepImpl` — pick one, document in code).

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/backtester/test/sdk-client-retry.test.ts
// SDK retry policy: 429 always retried (numeric Retry-After honored); network errors retried only
// for GET or POST-with-resumeToken; other 4xx never retried. Mirrors sdk-client-registry.test.ts's
// FetchLike fake.
import { describe, expect, it } from 'vitest';
import { BacktesterClient } from '../../../packages/sdk/src/client/index';
import { BacktesterRateLimitError, BacktesterValidationError } from '../../../packages/sdk/src/client/errors';
import type { FetchLike, FetchLikeResponse } from '../../../packages/sdk/src/client/client';

const ok = (body: unknown): FetchLikeResponse =>
  ({ ok: true, status: 200, json: async () => body, text: async () => '' });
const err429 = (retryAfter?: string): FetchLikeResponse => ({
  ok: false,
  status: 429,
  json: async () => ({ category: 'rate_limit', code: 'queue_full', message: 'full' }),
  text: async () => '',
  headers: { get: (n: string) => (n.toLowerCase() === 'retry-after' ? retryAfter ?? null : null) },
});

function clientWith(responses: Array<FetchLikeResponse | Error>, sleeps: number[]): BacktesterClient {
  const fetchImpl: FetchLike = async () => {
    const next = responses.shift()!;
    if (next instanceof Error) throw next;
    return next;
  };
  return new BacktesterClient({
    baseUrl: 'http://bt.test',
    token: 't',
    fetchImpl,
    retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50, sleepImpl: async (ms) => { sleeps.push(ms); } },
  });
}

describe('SDK retry policy', () => {
  it('retries 429 and honors numeric Retry-After seconds', async () => {
    const sleeps: number[] = [];
    const client = clientWith([err429('2'), ok({ runId: 'r', jobId: 'r' })], sleeps);
    const handle = await client.submitRun({ resumeToken: undefined } as never); // any body: 429 is always safe
    expect((handle as { runId: string }).runId).toBe('r');
    expect(sleeps).toEqual([2000]); // numeric seconds → ms; NOT backoff
  });

  it('falls back to backoff when Retry-After is an HTTP-date (numeric-only anchor)', async () => {
    const sleeps: number[] = [];
    const client = clientWith([err429('Wed, 21 Oct 2026 07:28:00 GMT'), ok({ runId: 'r' })], sleeps);
    await client.submitRun({} as never);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(0);
    expect(sleeps[0]).toBeLessThanOrEqual(50); // capped by maxDelayMs
  });

  it('exhausts maxAttempts on persistent 429 and throws BacktesterRateLimitError', async () => {
    const sleeps: number[] = [];
    const client = clientWith([err429(), err429(), err429()], sleeps);
    await expect(client.submitRun({} as never)).rejects.toBeInstanceOf(BacktesterRateLimitError);
    expect(sleeps).toHaveLength(2); // 3 attempts = 2 waits
  });

  it('retries GET on network error', async () => {
    const sleeps: number[] = [];
    const client = clientWith([new Error('ECONNRESET'), ok({ contractVersion: 'x' })], sleeps);
    await expect(client.getCapabilities()).resolves.toBeTruthy();
  });

  it('does NOT retry POST network error without resumeToken (fails fast)', async () => {
    const sleeps: number[] = [];
    const client = clientWith([new Error('ECONNRESET'), ok({ runId: 'r' })], sleeps);
    await expect(client.submitRun({} as never)).rejects.toThrow('ECONNRESET');
    expect(sleeps).toHaveLength(0);
  });

  it('retries POST network error WITH resumeToken (idempotent replay)', async () => {
    const sleeps: number[] = [];
    const client = clientWith([new Error('ECONNRESET'), ok({ runId: 'r' })], sleeps);
    await expect(client.submitRun({ resumeToken: 'tok' } as never)).resolves.toBeTruthy();
    expect(sleeps).toHaveLength(1);
  });

  it('never retries other 4xx', async () => {
    const sleeps: number[] = [];
    const bad: FetchLikeResponse = { ok: false, status: 400, json: async () => ({ code: 'validation_error', message: 'no' }), text: async () => '' };
    const client = clientWith([bad, ok({})], sleeps);
    await expect(client.submitRun({ resumeToken: 'tok' } as never)).rejects.toBeInstanceOf(BacktesterValidationError);
    expect(sleeps).toHaveLength(0);
  });

  it('maxAttempts: 1 disables retries', async () => {
    const sleeps: number[] = [];
    const fetchImpl: FetchLike = async () => err429('1');
    const client = new BacktesterClient({ baseUrl: 'http://x', token: 't', fetchImpl, retry: { maxAttempts: 1, sleepImpl: async (ms) => { sleeps.push(ms); } } });
    await expect(client.getCapabilities()).rejects.toBeInstanceOf(BacktesterRateLimitError);
    expect(sleeps).toHaveLength(0);
  });
});
```

(Adjust `sleepImpl`'s home to wherever you put it — it MUST be injectable so tests never really sleep. If `retry.sleepImpl` complicates the public type, accept it but mark `@internal` in the doc comment.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run apps/backtester/test/sdk-client-retry.test.ts`
Expected: FAIL — `retry` option unknown / no retry behavior / no BacktesterRateLimitError export.

- [ ] **Step 3: Implement**

errors.ts:

```typescript
/** 429 — queue_full / rate limited; safe to retry after Retry-After. */
export class BacktesterRateLimitError extends BacktesterError {}
```

client.ts — options + types:

```typescript
export interface FetchLikeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
  /** Optional (additive): lets the client read Retry-After. Fakes without it keep working. */
  headers?: { get(name: string): string | null };
}

export interface RetryOptions {
  /** Total attempts including the first (1 = no retries). Default 3. */
  readonly maxAttempts?: number;
  /** Backoff base delay (ms), full jitter, doubled per attempt. Default 500. */
  readonly baseDelayMs?: number;
  /** Backoff ceiling (ms). Default 10000. */
  readonly maxDelayMs?: number;
  /** @internal test seam — replaces real sleeping. */
  readonly sleepImpl?: (ms: number) => Promise<void>;
}

export interface BacktesterClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  /** Defaults to the global `fetch`. */
  readonly fetchImpl?: FetchLike;
  /** Safe-retry policy (429 always; network/5xx only when idempotent). Default ON (3 attempts). */
  readonly retry?: RetryOptions;
}
```

`request` becomes a retry loop (`raise` gains the 429 case):

```typescript
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: FetchLikeInit = {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    // Idempotency: GETs always; mutations only when the body carries a resumeToken (replay contract).
    const idempotent =
      method === 'GET' ||
      (typeof body === 'object' && body !== null && typeof (body as { resumeToken?: unknown }).resumeToken === 'string');

    const maxAttempts = Math.max(1, Math.floor(this.retry.maxAttempts ?? 3) || 1);
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let res: FetchLikeResponse;
      try {
        res = await this.fetchImpl(`${this.base}${path}`, init);
      } catch (err) {
        lastErr = err;
        if (!idempotent || attempt === maxAttempts) throw err;
        await this.sleep(this.backoffMs(attempt));
        continue;
      }
      if (res.ok) return (await res.json()) as T;
      const retryable = res.status === 429 || (idempotent && (res.status === 502 || res.status === 503 || res.status === 504));
      if (!retryable || attempt === maxAttempts) return this.raise(res, path);
      // Numeric-seconds Retry-After only (scope anchor); anything else → backoff.
      const ra = res.headers?.get('retry-after');
      const raSeconds = ra !== undefined && ra !== null && /^\d+$/.test(ra.trim()) ? Number(ra.trim()) : undefined;
      await this.sleep(raSeconds !== undefined ? raSeconds * 1000 : this.backoffMs(attempt));
    }
    throw lastErr instanceof Error ? lastErr : new Error('retry loop exhausted');
  }

  private backoffMs(attempt: number): number {
    const base = Math.max(1, this.retry.baseDelayMs ?? 500);
    const cap = Math.max(1, this.retry.maxDelayMs ?? 10_000);
    const exp = Math.min(cap, base * 2 ** (attempt - 1));
    return Math.max(1, Math.floor(Math.random() * exp)); // full jitter
  }

  private sleep(ms: number): Promise<void> {
    return (this.retry.sleepImpl ?? ((m: number) => new Promise<void>((r) => setTimeout(r, m))))(ms);
  }
```

with `private readonly retry: RetryOptions;` assigned `opts.retry ?? {}` in the constructor, and in `raise`:

```typescript
      case 429:
        throw new BacktesterRateLimitError(res.status, code, message, category, payload);
```

(+ import the class; + re-export from `client/index.ts` alongside the other error classes.)

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run apps/backtester/test/sdk-client-retry.test.ts apps/backtester/test/sdk-client-registry.test.ts apps/backtester/test/sdk-client.test.ts && npx tsc --noEmit -p apps/backtester && npx tsc --noEmit -p packages/sdk 2>/dev/null || pnpm --dir packages/sdk typecheck`
Expected: PASS / clean (pick whichever typecheck entry the SDK package actually has — check its package.json scripts).

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/client/client.ts packages/sdk/src/client/errors.ts packages/sdk/src/client/index.ts apps/backtester/test/sdk-client-retry.test.ts
git commit -m "feat(sdk): safe retry/backoff — 429 always (numeric Retry-After), network/5xx only when idempotent"
```

---

### Task 6: OPERATIONS backpressure section + full gate + wrap-up

**Files:**
- Modify: `docs/OPERATIONS.md`

- [ ] **Step 1: OPERATIONS section**

Add under the horizontal-scaling/capacity area:

```markdown
### Backpressure & connection hardening (Phase D Tier 2 lite)

- `BACKTESTER_PG_POOL_MAX` (default 10): per-process pool cap. Fleet math: `worker_pods ×
  (pool_max)` must stay under Postgres `max_connections` with headroom for the API pod and admin
  sessions; 10–20/process is typical.
- `BACKTESTER_PG_STATEMENT_TIMEOUT_MS` (default 0 = off; recommended 30000): statement_timeout on
  app-pool connections. Migrations always run on a dedicated no-timeout pool.
- `BACKTESTER_QUEUE_MAX_DEPTH` (default 0 = unlimited; recommended ≈ worker_slots ×
  queue_timeout / avg_run_seconds): a NEW submit beyond the cap gets `429 { category: 'rate_limit',
  code: 'queue_full', queueDepth, maxDepth }` + `Retry-After` (`BACKTESTER_QUEUE_RETRY_AFTER_S`,
  default 30). resumeToken replays always pass (crash-recovery contract) and never re-upload
  bundles. The cap is approximate under concurrency — a backstop, not a semaphore.
- SDK (`BacktesterClient`): retries default ON — 429 always (numeric-seconds `Retry-After`
  honored; HTTP-date form ignored → backoff), network/502-504 only for GETs or submits carrying a
  `resumeToken`. `retry: { maxAttempts: 1 }` disables.
```

- [ ] **Step 2: Full gate**

Run: `pnpm check`
Expected: green. Also re-run the two Pg-gated suites once with `BACKTESTER_TEST_DATABASE_URL=postgres://lab:lab@127.0.0.1:5432/backtester_perf` (find-by-resume-token, pool-options, queue-cap) — all green.

- [ ] **Step 3: Diff scope check**

`git diff main --stat` — only: `src/db/pool.ts`, `src/config.ts`, `src/app.ts`, `src/jobs/{job-store,pg-job-store,submit}.ts`, `src/api/server.ts`, `packages/sdk/src/client/{client,errors,index}.ts`, the new/extended test files, `test/helpers.ts` (if threaded), `docs/OPERATIONS.md`, plan/spec docs.

- [ ] **Step 4: Commit docs + finish**

```bash
git add docs/OPERATIONS.md
git commit -m "docs(ops): backpressure section — pool/timeout/queue-cap knobs + SDK retry semantics"
```

Then superpowers:finishing-a-development-branch (PR, squash-merge convention). Follow-ups stay out: SDK release 4-site version bump + lab re-pin + `rate_limited` mapping in lab's `toGatewayError`.
