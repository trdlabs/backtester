# Tier 2 lite — ingress backpressure + connection hardening (Phase D item 16 subset) — design

Date: 2026-07-04 (rev 2 — technical anchor applied after user review)
Status: approved for planning
Context: ROADMAP Phase D item 16, scoped to the four guards agreed as the pre-load-growth slice:
Pg pool knob, statement timeout, queue-depth cap → 429/Retry-After, SDK retry/backoff. Bundle-by-ref
and LISTEN/NOTIFY stay in item 16 for later slices. No perf refactor (17b/17c) rides in here.

## Goals

1. Pg pool size and statement timeout become configurable (today: hardcoded pg defaults — max 10,
   no timeout — invisible degradation under burst).
2. A submit burst hits a configurable queue-depth cap and gets an honest `429` + `Retry-After`
   instead of silently queueing into the 6-hour expiry.
3. The SDK client retries safely (429 always; network errors only where idempotent) with
   exponential backoff + `Retry-After` honoring, and surfaces HTTP status/code so consumers
   (trading-lab) can map `rate_limited`.

## Non-goals

- No lab-side changes (the `toGatewayError` → `rate_limited` mapping needs an SDK release + re-pin —
  a follow-up lab PR, listed in Rollout).
- No bundle-by-ref, no LISTEN/NOTIFY (item 16 remainder), no queue/schema changes.
- Defaults preserve today's behavior EXACTLY (all new knobs default off/current values).

## Design

### 1. Pg pool knob + statement timeout (`src/db/pool.ts`)

`createPool(url, schema?)` gains an options argument: `createPool(url, schema?, opts?: { max?:
number; statementTimeoutMs?: number })`.

- `BACKTESTER_PG_POOL_MAX` (default **10** — pg's own default, now explicit) → `opts.max`.
- `BACKTESTER_PG_STATEMENT_TIMEOUT_MS` (default **0** = off, preserving behavior; OPERATIONS
  recommends `30000` operationally) → applied as a connection startup parameter
  (`options: '-c statement_timeout=<ms>'` on the pool config), so every pooled connection carries it.
- **Migrations are exempt:** only the app path (`buildApp`/`app.ts`'s pool construction) passes the
  timeout; `migrate`-owning call sites (tests, tooling) keep constructing the pool without opts.
  The plan verifies every `createPool` caller and threads opts ONLY through the app path.

### 2. Queue-depth cap → 429 + Retry-After (`src/jobs/submit.ts` + config)

- `BACKTESTER_QUEUE_MAX_DEPTH` (default **0** = unlimited — today's behavior).
- `BACKTESTER_QUEUE_RETRY_AFTER_S` (default **30**) — the `Retry-After` header value.
- **Anchored submit flow (fixed, not plan-chosen):**
  `validate → requestFingerprint → [resumeToken? findByResumeToken → existing ⇒ replay (fingerprint
  match) / 409 (mismatch)] → [new job AND cap set AND depth >= cap ⇒ 429, NO bundle write] →
  bundleStore.put → insertOrGet/create`.
- **New `JobStore.findByResumeToken(resumeToken: string): Promise<JobRow | undefined>`** in the
  interface + BOTH implementations (Pg: served by the existing partial unique index
  `ux_backtest_job_resume_token`) + conformance tests — the cheap replay lookup that runs BEFORE
  `bundleStore.put`, so replays never pay a bundle write and never see the cap.
- When the cap trips: reply `429 { error: 'queue_full', queueDepth, maxDepth }` with
  `Retry-After: <s>`; nothing persisted, no bundle written.
- **429 is NOT a validation error:** the submit error surface gains a distinct category
  `rate_limit` (SubmitError category or a special-cased route mapping — plan picks from the actual
  SubmitError shape); consumers must be able to discriminate it from `validation_error`.
- The check is best-effort (racy by design): N concurrent submits near the cap may all pass — the
  cap is a backstop against runaway bursts, not an exact semaphore.

### 3. SDK retry/backoff (`packages/sdk` — `BacktesterClient`)

- `BacktesterError` gains `status?: number` (HTTP) and the parsed body `code?: string` so consumers
  can discriminate (`status === 429` / `code === 'queue_full'` → lab maps `rate_limited`).
- Client options gain `retry?: { maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number }`
  (defaults **3 / 500 / 10000**, full jitter).
- Retry policy (default ON — safe by construction):
  - **429**: always retryable (nothing was created); wait = `Retry-After` header if present, else
    backoff. **Scope anchor: only NUMERIC-SECONDS `Retry-After` is honored in this PR** (the
    HTTP-date form is ignored → falls back to backoff); explicit and documented, not an oversight.
  - **GET requests**: also retry on network errors and 502/503/504.
  - **POST/mutations**: retry on 429 always; on network errors / 502-504 ONLY when the request
    carries a `resumeToken` (idempotent replay by contract). A non-idempotent POST network failure
    surfaces immediately — retrying could double-submit.
  - Never retry other 4xx.
- `maxAttempts: 1` disables retries (escape hatch); behavior for non-retryable outcomes is
  byte-identical to today.

## Config surface

| Env | Default | Effect |
|---|---|---|
| `BACKTESTER_PG_POOL_MAX` | 10 | pool max connections (per process) |
| `BACKTESTER_PG_STATEMENT_TIMEOUT_MS` | 0 (off) | statement_timeout on app-pool connections; migrations exempt |
| `BACKTESTER_QUEUE_MAX_DEPTH` | 0 (unlimited) | queued-jobs cap; exceeded ⇒ 429 queue_full |
| `BACKTESTER_QUEUE_RETRY_AFTER_S` | 30 | Retry-After header on 429 |

SDK: `new BacktesterClient({ ..., retry })`, defaults 3/500ms/10s, jitter, Retry-After honored.

## Testing

- `createPool`: unit — opts.max threaded; statement timeout present in pool config only when set.
  Pg-gated: `SHOW statement_timeout` on a pooled connection reflects the option; migrate-path pool
  (no opts) shows `0`.
- Submit cap: factory-parametrized — cap 2 + 3 queued jobs ⇒ new submit 429 with header + body shape
  and NO job row / bundle write; replay with matching resumeToken at depth>cap ⇒ 200-path reattach;
  cap 0 ⇒ unlimited (existing suites untouched).
- SDK retry: unit with mocked fetch — 429→success (honors numeric Retry-After); GET network
  error→retry; POST network error without resumeToken → NO retry, fails fast; POST with resumeToken
  → retried; maxAttempts respected; other 4xx not retried; `BacktesterError.status/code` populated.
- Full `pnpm check` green; capabilities/registry/e2e suites byte-identical (defaults off).

## Rollout

One backtester PR (`feat/tier2-lite-backpressure`). Follow-ups (NOT in this PR): SDK version bump +
release (4-site gotcha: package.json, versions.ts SDK_VERSION, package-shape.test,
registry-contract.test — bump BEFORE dispatching the release workflow) → lab re-pin + `rate_limited`
mapping in `toGatewayError` + lab poll/retry wiring. OPERATIONS.md gains a backpressure section
(recommended values: pool 10–20/process with Postgres max_connections math, statement timeout 30s,
queue cap ≈ slots × (queue_timeout / avg_run_s)).

## Decisions taken (flag for review)

1. Statement timeout default **0/off** (repo's preserve-behavior convention) with OPERATIONS
   recommendation, not a hot default.
2. 429 bypass for resumeToken replays is a hard behavioral contract (crash recovery > backpressure).
3. SDK retries default **ON** but only for provably-safe cases (429; idempotent/GET); non-idempotent
   POST network failures still fail fast.
4. Cap check is approximate (racy) by design — documented, not "fixed" with locking.
5. Lab-side `rate_limited` mapping deferred to the SDK-release follow-up (cross-repo dance).
