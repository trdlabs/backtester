# Bar-major transport collapse (Slice B) — design

**Date:** 2026-07-12
**Status:** approved (brainstorming) → ready for implementation plan
**Roadmap:** Phase D, bar-major / message-collapse. This is **Slice B of two** (Slice A = execution flip, merged PR #101).

## Context

Slice A (PR #101) flipped multi-symbol execution to bar-major order with per-symbol portfolios and an
equal-weight aggregation, behind `BACKTESTER_BAR_MAJOR`. It established the bar-major **semantics** and
the frozen N>1 golden — but the sandbox transport is unchanged: in universe mode the runner still issues
**one IPC round-trip per `(symbol, bar)`**. The universe collapse (17c) cut container *spawns*, not
round-trips. Measured `ipcWait ≈ 44%` of engine time at N=3, scaling ~linearly with N.

Slice B is the transport collapse that realizes the IPC win: **one IPC message per bar carrying all N
symbols' `onBarClose` increments**, the universe harness dispatches to all N resident per-symbol
instances and returns N results, the host applies them via the unchanged `processBar`. It must reproduce
Slice A's bar-major `result_hash` **byte-for-byte** (golden-gated).

### Why the reorder is byte-identical (feasibility crux)

Slice A gave each symbol its **own `Portfolio` + own `RunAccumulators`** (Variant A) — per-symbol state
is fully independent. So splitting the per-union-timestamp loop from Slice A's interleave
(`preBarStages(A) → hook(A) → processBar(A) → preBarStages(B) → …`) into three phases
(`preBarStages(all) → one batched hook → processBar(all)`) produces identical results:
`preBarStages(B)` never touches `portfolioA`, so `ctx_A` (built from `portfolioA` after
`preBarStages(A)`) is the same in both orderings, and `portfolioA` is unchanged between `build(A)` and
`processBar(A)` in both. The transport collapse is safe **because** of Variant A.

## Decisions (locked in brainstorming)

1. **Gating:** new sub-flag `BACKTESTER_BAR_MAJOR_BATCH`, **default OFF** (measure-first — the 17b
   `BACKTESTER_BAR_BATCHING` lever was measured *slower* on long_oi and kept OFF; a perf lever ships
   dark and is enabled after a VPS measurement). Threaded through the same chain as
   `barMajor`/`barBatching` (config → app → worker → StrategyRunDeps → RunDeps).
2. **Activation predicate:** the batch engages ONLY when `barMajor && universe && sandbox && N>1`. In
   trusted / non-universe / lockstep it **degrades to the per-symbol loop** — byte-identical, zero
   transport change.
3. **Hook scope:** batches **`onBarClose` only**. `processBar` (and its internal `onPositionBar`
   per-symbol lockstep call) is **unchanged**. Batching `onPositionBar` would require restructuring the
   reused `processBar` core — deferred to a possible Slice C.
4. **Byte-identity:** Slice B produces the **same `result_hash` as Slice A** (same frozen golden). It is
   a pure transport optimization; no semantic change.

## Architecture

### Driver reorder (`engine/runner.ts::runBarMajor`)

When the batch is active, the per-union-timestamp inner loop runs in three phases instead of the
interleave:

```
for (const ts of unionTs) {
  const active = [];                                   // present symbols at ts, in request.symbols order
  for (let s = 0; s < envs.length; s += 1) {
    const env = envs[s], t = cursor[s];
    if (env.candles[t]?.ts !== ts) continue;
    preBarStages(env, t);
    active.push({ env, t, ctx: env.builder.build(t, stateAt(env.portfolio, env.candles[t].close)) });
    cursor[s] += 1;
  }
  if (active.length === 0) continue;
  const bases = await executeStrategyHookBarMajor(active.map(a => ({ module: a.env.module, ctx: a.ctx })));
  for (let i = 0; i < active.length; i += 1) await processBar(active[i].env, active[i].t, bases[i]);
}
```

When the batch is OFF (or the predicate fails), the existing interleave path (Slice A) runs unchanged.
The `active` order IS `request.symbols` order (tie-break contract), preserved into both the batched
request and the `processBar` apply loop.

### Wire protocol (`engine/sandbox/ipc.ts`)

- Request (host → harness): `HookBarMajorRequest`
  `{ t: 'hookBarMajor', seq, hook: 'onBarClose', bars: Array<{ symbol, snapshot, newBar, newOi?, newLiq? }> }`.
  Each `bars[i]` is a `HookBatchEntry` built by the existing `buildHookPayload` (per-symbol bookkeeping
  is already correct under interleave — proven in Slice A / the interleave-trace test).
- Response (harness → host): **tagged per-entry**
  `{ t: 'okBarMajor', results: Array<{ ok: true, decisions } | { ok: false, error }> }`,
  aligned index-for-index with `bars`. Per-entry tagging (not a flat `decisions[][]` + side marker) so a
  per-symbol failure is unambiguous and mirrors fail-closed-per-symbol directly.

### Harness (`sandbox-harness*/entry.mjs`)

Add a `msg.t === 'hookBarMajor'` branch: for each `bars[i]`, dispatch `onBarClose` to that symbol's
resident instance (already instantiated in the universe container). A per-symbol strategy exception is
caught in-harness → that entry becomes `{ ok: false, error }`; the other entries still run and return
`{ ok: true, decisions }`. The container stays alive (mirror of the per-symbol fail-closed behavior the
lockstep `hook` path already has in universe mode).

### Session (`sandbox-session.ts`)

`callHookBarMajor(ctxs: readonly StrategyContext[]): Promise<readonly HookResult[]>` — builds N
`HookBatchEntry` via the existing `buildHookPayload` (advancing each symbol's per-symbol bookkeeping
slot), sends one `hookBarMajor` envelope, awaits one `okBarMajor` response, and maps each
`results[i]` to a `HookResult`.

### Executor (`sandbox-executor.ts` + trusted)

`executeStrategyHookBarMajor(items: Array<{ module, ctx }>): Promise<StrategyDecision[]>` (one `base`
per item, index-aligned):
- **sandbox / universe:** routes to the shared session's `callHookBarMajor`; per-entry revalidation
  mirrors the lockstep `executeStrategyHook` path.
- **trusted (or non-universe):** loops `executeStrategyHook` per item — byte-identical degradation, no
  batching.

## Failure semantics

- **Per-symbol strategy exception** (harness caught the throw, container alive): the `results[i] =
  { ok: false, error }` entry maps to the **same `HookResult` / `SessionError` path as a harness-level
  `err` from `callHook` for that symbol today** — same `failedSymbols` latch, same `SessionError`, same
  downstream terminal / evidence behavior (this reuses the existing lockstep failure adapter; the exact
  post-latch bookkeeping is whatever `callHook` + the executor already do, NOT re-specified here). Other
  symbols in the batch continue.
- **Channel-level failure** on the `hookBarMajor` envelope (malformed line, EOF, timeout, output
  overflow, contract-version mismatch): **whole-session fatal** — `this.fail(...)`, identical to how the
  lockstep `hook`/`hookBatch` paths treat channel death. This is explicitly distinct from a per-symbol
  strategy exception.

## Observability (`ipc_profile`)

The existing `hookCalls` counts **logical** per-`(symbol, bar)` hook executions; `callHookBarMajor`
credits `hookCalls += bars.length` so that number is unchanged vs lockstep (N logical hooks still ran).
Add a distinct counter for the transport collapse:

- `ipcMessages` (or `barMajorBatches`) — the number of `hookBarMajor` IPC round-trips (one per bar).

The spec claim is precise: **IPC round-trips** collapse from `N/bar` to `1/bar`; logical hook executions
do **not** change. `ipcWaitMs` becomes fewer, larger waits (one receive per bar instead of N).

## Golden / testing

- **Primary golden gate (Docker):** with `BACKTESTER_BAR_MAJOR_BATCH` ON, the sandbox run's
  `result_hash` equals **the frozen Slice A bar-major golden `sha256:9da2192a…`**, byte-for-byte, for
  N=2 and N=3 — i.e. `sandbox-batch-ON == trusted-barMajor == frozen golden` (the trusted path degrades
  to the loop and already equals the golden; this pins the batch transport against the same anchor).
- **Wire test (flag OFF):** zero `hookBarMajor` envelopes are ever sent; the per-bar `hook` envelopes
  are byte-identical in shape to today (channel-spy).
- **Wire test (flag ON):** exactly ONE `hookBarMajor` envelope per bar carrying N entries (channel-spy)
  — the falsifiable proof the round-trips actually collapsed.
- **Per-symbol fail-closed:** one symbol's strategy throws inside a batch → its `results[i]` is
  `{ ok: false, error }` → same latch/outcome as the lockstep universe per-symbol failure → the other
  symbols' results still apply. Result equals the lockstep-failure result for the same scenario.
- **Channel-fatal:** a malformed/short `okBarMajor` response → whole session fails (not a per-symbol
  latch).
- **ipc_profile:** with the batch ON, `ipcMessages` == bar count while `hookCalls` == N × bar count
  (logical unchanged) — proves the collapse is in round-trips, not logical executions.

## Non-goals (out of Slice B)

- Batching `onPositionBar` (or any hook other than `onBarClose`) — would restructure `processBar`;
  possible Slice C.
- Binary IPC framing (msgpack instead of NDJSON) — orthogonal, measure NDJSON collapse first.
- Any change to bar-major semantics / the aggregation / the golden value — Slice B is byte-identical to
  Slice A by construction and by gate.
- Enabling the flag by default — ships dark; enabled after a VPS measurement.

## Files (anticipated)

- `engine/sandbox/ipc.ts` — `HookBarMajorRequest` + `okBarMajor` response types + parse.
- `engine/sandbox/sandbox-session.ts` — `callHookBarMajor`; `ipcMessages` profile counter.
- `sandbox-harness/entry.mjs` + `sandbox-harness-overlay/entry.mjs` — `hookBarMajor` dispatch branch.
- `engine/sandbox/sandbox-executor.ts` — `executeStrategyHookBarMajor` (sandbox route); trusted executor
  loop variant.
- `engine/runner.ts::runBarMajor` — the 3-phase batched inner loop behind the flag.
- `config.ts` / `app.ts` / `jobs/worker.ts` / `engine/run-strategy.ts` — `BACKTESTER_BAR_MAJOR_BATCH`
  flag chain.
- tests: golden (Docker), wire flag-off/on (channel-spy), per-symbol fail-closed, channel-fatal,
  ipc_profile.
