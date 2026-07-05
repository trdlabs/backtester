# Phase A — Real Platform Data Path (finish) — Design Spec

**Date:** 2026-07-05
**Status:** approved (brainstorming) → ready for plan
**Branch:** `feat/phase-a-real-platform-finish`

## Goal

Close **Phase A** of the backtester roadmap: make the backtester's **real
`trading-platform` historical data path** a first-class, safe, tested production
posture. This is the last open item of the core product (`Definition of Done`:
"historical data comes through the real platform contract").

Today the full `lab → backtester → platform` flow is proven only against
`trading-mock-platform`. A 2026-07-05 verify-spike proved the real path works
live (VPS `:8088`, `historical.2` contract, Bearer/sha256 auth, 526 symbols) and
fixed a code gap (`RowsReader` was single-symbol → PR #89). But pointing at the
real platform is still **ad-hoc**: `dataSource:'real'` shares config with
`'mock'`, there is no distinct config, no fail-fast, and no automated
real-platform E2E gate. This slice turns the proven-but-manual capability into a
first-class production posture.

## Scope

- Distinct `'real'` config pair (`BACKTESTER_REAL_PLATFORM_URL/_TOKEN`).
- Source-specific config **validation** (fail-fast before server/worker start).
- `app.ts` factory branch selecting `RowsDataPort` on the real pair for `'real'`.
- **Normalized, finite** failure-cause surfaced in `errorDetail` (terminal code
  stays `missing_dataset`).
- Real-platform **E2E gate** (extend the existing cross-repo test): single +
  multi-symbol, **closed-window determinism** assertion on
  `datasetFingerprint`/`resultHash`.
- Docs: `OPERATIONS.md` + `deploy/vps` — `'real'` as the **production posture**.

## Non-goals

- No contract change; `RowsDataPort` keeps consuming the existing `historical.2`.
- No changes to `trading-platform` or `@trading-backtester/sdk` (this is a
  single-repo slice; the cross-repo change rule is not triggered).
- No retry/backoff and no bounded HTTP timeout (lean; the platform is co-located
  loopback — add later only if real failures appear).
- No new terminal-code taxonomy (reuse `missing_dataset`).
- **No flip of the code default** — `dataSource` code-default stays `fixture`.

## Design

### 1. Config variables (`src/config.ts`)

- Add `realPlatformUrl` ← `BACKTESTER_REAL_PLATFORM_URL`.
- Add `realPlatformToken` ← `BACKTESTER_REAL_PLATFORM_TOKEN`.
- `mockPlatformUrl` / `mockPlatformToken` are unchanged (back-compat; `'mock'`
  keeps its own pair).
- `dataSource` code-default remains `fixture`.

### 2. Config validation invariant (fail-fast)

An explicit **source-specific validation** step, run **before** the server or
worker starts (before `buildApp` wires ports / before the worker drains):

- When `BACKTESTER_DATA_SOURCE=real`: an empty **or whitespace-only**
  `BACKTESTER_REAL_PLATFORM_URL` **or** `BACKTESTER_REAL_PLATFORM_TOKEN` is a
  **misconfig**.
- The error is raised at config-validation time (not lazily at first fetch).
- The error **message is stable and asserted** by a unit test (exact string),
  e.g. `BACKTESTER_REAL_PLATFORM_URL and BACKTESTER_REAL_PLATFORM_TOKEN are
  required when BACKTESTER_DATA_SOURCE=real`.

This is an invariant, not an inline `throw` buried in the factory: it lives in a
named config-validation path so both the API and worker entrypoints enforce it
identically.

### 3. Factory (`src/app.ts`)

- `'real'` → `RowsDataPort({ baseUrl: realPlatformUrl, token: realPlatformToken })`.
- `'mock'` → `RowsDataPort` on the mock pair (**unchanged**).
- `'http'` → `HttpDataPort` (**unchanged**); otherwise `FixtureDataPort`.
- `MockPlatformDataPort` stays orphaned/legacy (out of scope).

### 4. Normalized failure cause in `errorDetail`

Preserve the terminal code `missing_dataset` (no new taxonomy), but stop
**silently swallowing the cause**. `RowsDataPort.openDataset` currently catches
`discover()` / auth errors and returns `undefined`, so the worker emits a clean
`missing_dataset` with no reason — a deliberate loss. Fix: surface a **normalized,
finite** cause into `errorDetail`.

**Normalized cause set (finite enum; raw SDK/Node text never surfaced):**

| cause | condition |
| --- | --- |
| `unauthorized` | historical API returns HTTP 401/403 |
| `connection_refused` | transport failure reaching the endpoint (ECONNREFUSED / DNS / network) |
| `contract_version_mismatch` | `historicalContractVersion !== 'historical.2'` |
| `rows_resource_unavailable` | no `rows` resource, or its `availability !== 'available'` |
| `dataset_not_found` | datasetRef symbol **or** timeframe absent from `discover` |
| `discover_failed` | generic normalized fallback for any other discover/transport failure |

**`errorDetail` format (fixed string contract).** `errorDetail` stays the
existing **string-typed** field on `job_terminal` (no shape change). On a
real-fetch failure it is exactly:

```
cause=<cause>; datasetRef=<datasetRef>
```

where `<cause>` is one value from the finite set above and `<datasetRef>` is the
`SYMBOL:timeframe` ref. Nothing else is appended. Tests and ops parse this fixed
form, not incidental SDK/Node wording.

Constraints:

- `errorDetail` carries **only** the `cause=…; datasetRef=…` string above —
  **no** tokens/secrets, **no** stack, **no** raw lower-layer message.
- Terminal code stays `missing_dataset`.
- Fixture / mock / success paths stay **byte-identical** (this only adds a cause
  string on the real-failure path).
- The exact plumbing (typed error vs discriminated result from `openDataset`) is
  a plan-level decision; the **contract above** (finite set, sanitized, code
  preserved) is fixed.

### 5. Real-platform E2E gate

Extend the existing opt-in `cross-repo-historical-e2e.integration.test.ts`
(`RUN_CROSS_REPO_E2E=true`; spawns the real `start-historical-http` binary from a
sibling `trading-platform` checkout):

- Drive the backtester with `dataSource:'real'` + the real pair pointed at the
  spawned server (token the spawned server accepts).
- **Single-symbol** case and **multi-symbol** case (2–3 symbols — unblocked by
  #89).
- **Closed-window determinism** (flake guard, spec-fixed):
  - **closed time window only** — fixed `from`/`to` well before `now`;
  - **fixed symbol list**, **fixed timeframe**;
  - **no `now` / `latest` / open (still-forming) bar**.
- Assertion is **result stability**, not presence: two identical runs over the
  same closed window produce an **identical `datasetFingerprint` / `resultHash`**
  (for both the single- and multi-symbol cases). Presence/row-count alone is not
  sufficient.

### 6. Docs

- `OPERATIONS.md` — a "real platform data source" section: env matrix
  (`BACKTESTER_DATA_SOURCE=real` + `BACKTESTER_REAL_PLATFORM_URL/_TOKEN`), and an
  explicit statement that **`'real'` is the recommended production posture but
  NOT the code default** (code-default stays `fixture`).
- `deploy/vps/backtester.env.example` — document
  `BACKTESTER_REAL_PLATFORM_URL/_TOKEN` and note `DATA_SOURCE=real` is the
  production posture.

## Testing (TDD)

Three explicit groups:

1. **Config validation tests** — `dataSource:'real'` with missing / empty /
   whitespace URL or TOKEN → fails at validation time with the stable, asserted
   error string; a fully-configured `'real'` passes validation.
2. **Factory selection tests** — `'real'` selects `RowsDataPort` bound to the
   **real** pair; `'mock'` still selects `RowsDataPort` on the mock pair;
   `fixture`/`http` unchanged. Plus the normalized-cause mapping unit test
   (each condition → its enum value; no raw text leaks).
3. **Opt-in live E2E** — the extended cross-repo test (single + multi-symbol,
   closed-window determinism on fingerprint/hash). Gated by `RUN_CROSS_REPO_E2E`.

## Done when

- `dataSource:'real'` with the distinct pair reads real historical data.
- **Fail-fast before start** on misconfig (empty/whitespace url or token), with a
  stable tested error string.
- A real-fetch failure yields terminal `missing_dataset` **with a normalized
  cause** (from the finite set) in `errorDetail` — no raw text, no secrets.
- The opt-in real-platform E2E is green, and its **multi-symbol determinism**
  compares the final `datasetFingerprint` / `resultHash` between two identical
  closed-window runs (not just symbol set / row count).
- `OPERATIONS.md` + `deploy/vps` document `'real'` as the **production posture,
  not the code default**.
- Roadmap Phase A #1 / #2 are closable; core-product `Definition of Done` reaches
  the real-platform bar.
