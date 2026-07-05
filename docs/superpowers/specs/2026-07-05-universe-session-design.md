# Universe Session (17c) — container-collapse, byte-identical — Design

**Status:** design (brainstorming approved 2026-07-05)
**Roadmap:** Phase D item 17c. **Scope this slice: container-collapse ONLY.**
**Flag:** `BACKTESTER_UNIVERSE_SESSION` (default OFF; OFF = today's per-symbol path, byte-for-byte).

## Goal

Enable top-300/400-symbol universe backtests on small hardware by replacing **one sandbox container per (module, symbol)** with **one container per module bundle hosting N per-symbol strategy instances**. Today an N-symbol run spawns up to `2N` containers (N strategy + N overlay), ~8–10 min of spawns for 300 symbols and a container-memory ceiling ~38 GB. The universe session collapses that to **one container per bundle** (strategy + overlay ⇒ 2 containers total), one spawn each, memory `base + k×N` in one process.

## Non-goals (explicitly out of this slice)

- **Bar-major / message-collapse.** Today ~`N×M` IPC round trips (symbol-major). Sending "one message per bar for ALL symbols" would cut round trips ~N× BUT changes the order decisions are applied to the shared portfolio ⇒ a different `result_hash` for multi-symbol runs. That is a **separate future slice**, taken only after a post-17c IPC re-measure still shows IPC-wait dominating. This slice does NOT touch execution order or the portfolio pass.
- **Auto-sharding** across multiple containers. This slice uses a single container per bundle with a soft cap that **rejects** oversized runs (see Scaling). Auto-shard into `⌈N/cap⌉` containers is a follow-up.
- **Portfolio semantics for concurrent signals.** The sequential shared-portfolio model is unchanged.

## Load-bearing invariant

**`result_hash` byte-identical to today.** Because the host keeps **symbol-major** execution order (`for (const symbol of request.symbols) { run all its bars }`) and applies decisions to the shared `Portfolio` in the exact same order, the assembled `RunOutcome` — and thus `contentRef()`/`result_hash` — is identical whether a run executes as N per-symbol containers (flag OFF) or one universe container (flag ON). The universe session is a **transport substitution**, not an execution-model change. This is enforced by the golden gate below.

## Current architecture (baseline being changed)

- `runner.ts::simulateTarget` (`runner.ts:583`) drives `for (const symbol of request.symbols)` sequentially over one shared `Portfolio` (`runner.ts:604,612,631`). Symbols are **not** interleaved bar-by-bar. **← unchanged by this slice.**
- `sandbox-executor.ts::SandboxModuleExecutor.sessionFor` (`:69-90`) keys a `Map<symbol, SandboxSession>` — one container per symbol. **← changed: one session per executor.**
- `routing.ts::createExecutorRouter` caches one `SandboxModuleExecutor` per `bundleHash` (`:187-194`) — strategy bundle and overlay bundle get separate executors. Collapsing at the executor level therefore covers **both** paths symmetrically with one change.
- `sandbox-session.ts` — per-symbol `open()`/`callHook()`/`callHookBatch()`/`close()`, holds host-side `barIndex`/`lastBarTs` and the candle buffer assuming ONE symbol. **← changed: per-symbol state keyed inside.**
- `sandbox-harness-overlay/entry.mjs` (+ `hook-batch.mjs`) — one `instance`/`buffer` per process. **← changed: `Map<symbol, {instance, buffer}>`.**
- `docker-driver.ts` — container name `sbx-<runId>-<moduleId>-<version>-<symbol>` (`:37-46`). **← changed: drop `-<symbol>`.**
- `sandbox-policy.ts` — fixed per-container limits (128 MiB, 2s/call, 30s/session). **← changed: N-aware memory + session wall-time.**
- `context-serializer.ts::ContextSnapshot` already carries `symbol` (`:17-33`). **← reused as the routing key; no new field needed on the hook path.**

## Design

### 1. Host: one session per executor (was per symbol)

`SandboxModuleExecutor` gains a universe mode (behind the flag): instead of `sessionFor(symbol)` returning a per-symbol `SandboxSession`, it lazily opens **one** `SandboxSession` for the whole executor (its bundle) and reuses it for every symbol. The host loop in `runner.ts` is untouched — it still calls the executor per (symbol, bar) in symbol-major order; only the session lookup collapses. Because `ContextSnapshot.symbol` is already on every hook request, the host needs no new field: the same `HookRequest` stream now lands in one container, tagged by symbol.

`SandboxSession` host-side per-symbol bookkeeping (`barIndex`/`lastBarTs`/candle-buffer bridge) moves from instance fields to a `Map<symbol, …>` so the newBar-vs-resend logic (`sandbox-session.ts:161-184`) stays correct per symbol within the shared session.

### 2. Harness: N instances keyed by symbol

`entry.mjs` replaces its single `instance`/`buffer` with `const instances = new Map<symbol, {instance, buffer}>`. On the first `init`/`hook` for a symbol, it constructs that symbol's strategy instance and candle buffer; subsequent hooks route by `req.symbol`. Same isolation semantics — the security boundary is **bundle ↔ host**, not symbol ↔ symbol (all instances are the same trusted-or-sandboxed bundle code, already co-resident by design). On a per-symbol instance failure the harness emits a **symbol-scoped `err` envelope** (not a fake `ok:[]`), so the failure surfaces to the host rather than being swallowed in-container (see §4). `hook-batch.mjs` (17b, inert) is updated for the keyed lookup so it stays consistent, but remains engine-unwired.

### 3. Container & policy

- **One container per bundle.** With the symbol segment gone, the container name must stay unique across the strategy and overlay bundles — include the **kind and bundle hash** so two bundles sharing a `moduleId`/`version` can't collide: `sbx-<runId>-<kind>-<bundleHashShort>` (kind ∈ `strategy|overlay`). Both executors get exactly one container each (2 total), via the generic executor-level change.
- **Memory:** `memoryBytes = base + k × N` (N = symbol count). **Conservative defaults ship as-is** (VPS only tunes): `base = 128 MiB`, `k = 8 MiB/symbol`. Holds the same aggregate data N separate containers held, now in one process.
- **Wall time:** `wallTimeMsPerCall` unchanged (2s, per hook). `wallTimeMsPerSession = perSymbolSessionMs × N` (the session runs all N symbols sequentially); `perSymbolSessionMs` default = today's `30s`.
- **Soft cap:** configurable `maxUniverseN`, **conservative default `64`** (the VPS run tunes it upward once headroom is measured; universes beyond it wait for the auto-shard follow-up). Enforcement is **pre-execution validation, not the HTTP submit layer** — the symbol-count check lives alongside the existing request/refs/overlays validation at the top of `runBacktest` (`runner.ts`), returning a `validation_error` outcome so nothing is spawned. It is NOT added to the `POST /v1/runs` handler.

### 4. Failure semantics (per-symbol fail-closed)

- **Per-symbol error (one instance throws / emits schema-invalid / times out on its call):** the harness catches it for that symbol and returns a **symbol-scoped `err` envelope** to the host (carrying the symbol + reason) rather than silently swallowing it. The host applies fail-closed for that bar (`[]` decisions → zero orders) AND records the symbol-tagged error via `ExecutorRouter.errors()`, so a degraded symbol is **observable**, not invisible — preserving the per-symbol diagnostic that separate containers gave for free. Other symbols' instances keep running. This keeps today's "one symbol degrades, the run keeps going" behavior; the resulting `RunOutcome` for that symbol (all-idle) is identical to the per-symbol path under the same failure.
- **Whole-container / process crash (OOM-kill, harness process death):** the single `SandboxSession.fail()` latch now marks the universe session failed ⇒ **all N symbols** in that container degrade to fail-closed `idle` for their remaining bars, and the run still completes (no throw), matching today's per-session fail-closed but with a wider blast radius. **This is the accepted tradeoff of container-collapse.** The soft cap bounds that blast radius (and memory); auto-shard (follow-up) narrows it further.
- Errors continue to aggregate via `ExecutorRouter.errors()` for post-run diagnostics, now tagged per symbol within the shared session.

### 5. Determinism & golden gate

- Symbol-major order preserved ⇒ `result_hash` byte-identical by construction. No change to `processBar` stage order, portfolio application, or `assembleResult`.
- **Golden gate (merge bar):**
  1. Existing goldens (long_oi, momentum, overlay) — byte-identical with the flag ON and OFF.
  2. **New multi-symbol golden:** a ≥3-symbol run executed with `BACKTESTER_UNIVERSE_SESSION=false` (today's per-symbol containers) vs `=true` (universe session) produces **byte-identical `result_hash`** — the load-bearing proof that container-collapse is a pure transport substitution.
  3. Per-symbol fail-closed test: one symbol's instance throws → that symbol contributes idle, the others complete normally, run succeeds, `result_hash` matches a per-symbol run with the same injected failure.
  4. Container-crash test: the container dies mid-run → all in-flight symbols degrade to fail-closed idle, run completes (no throw).
  5. Soft-cap test: `symbols.length > maxUniverseN` → run rejected with the expected error, nothing spawned.

### 6. Flag & rollout

`BACKTESTER_UNIVERSE_SESSION` (default **false**). OFF ⇒ `sessionFor(symbol)` per-symbol path, byte-for-byte today's behavior (the executor-level branch is the only reachable change; when off, no universe session is constructed). Postgres/queue/dedup/coalescing untouched. No SDK/public-contract change (INV: internal execution topology only).

## Open items (resolved during implementation / measurement)

- `base`/`k` memory (`128 MiB` / `8 MiB`), `maxUniverseN` (`64`), `perSymbolSessionMs` (`30s`) — **conservative defaults are set in §3 and ship as-is; no blocking measurement.** The VPS (89.124.86.84) run only *tunes* them upward once real N-symbol headroom is measured.
- Whether to eagerly free a completed symbol's instance mid-run (would cap live memory nearer `base + k×1 + Σ buffers`); deferred — keep all N for simplicity this slice, the soft cap protects memory.

## Follow-ups (separate slices)

- **Bar-major / message-collapse** — only after a post-17c IPC re-measure still shows IPC-wait dominating; changes multi-symbol portfolio semantics + `result_hash` (own golden).
- **Auto-sharding** into `⌈N/cap⌉` containers for universes beyond a single container's memory, and shard-parallelism across workers.
- **Binary IPC framing** (msgpack) — Nautilus-inspired, only if IPC-wait dominates after the above; measure first.
