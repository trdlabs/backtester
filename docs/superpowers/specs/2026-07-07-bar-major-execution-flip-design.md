# Bar-major execution flip (Slice A) — design

**Date:** 2026-07-07
**Status:** approved (brainstorming) → ready for implementation plan
**Roadmap:** Phase D, bar-major / message-collapse (deferred own slice under 17c). This is **Slice A of two**.

## Context

In universe mode (17c), one container hosts N per-symbol strategy instances, but the runner
(`simulateTarget`, `apps/backtester/src/engine/runner.ts`) still drives execution **symbol-major**:

```
for (const symbol of request.symbols) { runSymbol(symbol, /* all its bars */) }
```

Symbol A runs all its bars against the shared `Portfolio`, then symbol B. Because IPC is one message
per `(symbol, bar)`, a universe run still issues `N × M` round-trips — the universe collapse cut
container **spawns**, not **round-trips**. The `ipc_profile` measurement on real long_oi × 3-symbol
showed `ipcWait ≈ 44%` of engine time at N=3, scaling ~linearly with N. Cutting those round-trips is
**bar-major's job**: one IPC message per bar carrying all N symbols.

Bar-major transport requires bar-major **execution order** — all symbols must stand on bar `t`
simultaneously, i.e. `for (bar) { for (symbol) }`. That reorders how the shared portfolio interleaves
cross-symbol trades, which **changes `result_hash`** for multi-symbol runs. Per the 17c spec, this is
a **product decision** (portfolio applies cross-symbol signals per-bar vs per-symbol-sequentially),
not a transport tweak — so it is gated and gets its own golden.

## Decomposition (decided)

Two slices, execution-flip first:

- **Slice A (this spec):** flip the runner's execution order to bar-major behind a flag. Pure loop
  reorder reusing the existing per-bar steps; **no new IPC protocol**. Establishes the bar-major
  semantics + golden. `trusted == sandbox` byte-identical. No transport perf win yet.
- **Slice B (later spec):** sandbox `hookBarMajor` transport — one IPC message per bar carrying all N
  symbols' increments, harness runs all N instances per message. Must reproduce Slice A's golden
  byte-for-byte. This is where the IPC round-trip win lands.

## Decisions (locked in brainstorming)

1. **Gating:** flag `BACKTESTER_BAR_MAJOR`, **default OFF**. symbol-major stays the default and the
   current golden. bar-major is an opt-in mode with its **own** golden baseline.
2. **N=1 invariant:** for a single symbol the union timeline equals that symbol's timeline and the
   bar-major loop is identical to symbol-major → **byte-identical `result_hash`**. New golden is only
   for N>1.
3. **Mutual exclusion with 17b:** `BACKTESTER_BAR_MAJOR` and `BACKTESTER_BAR_BATCHING` cannot both be
   enabled — **fail-fast at config load** with a stable error string (NOT silent precedence). A silent
   winner would let an operator enable two optimizations and have one quietly disabled — a nasty
   debug case.
4. **Timeline alignment:** by **timestamp** (union of all symbols' timestamps). At each ts only the
   symbols that have a candle at that ts act. Temporally correct under differing windows / gaps.
5. **Tie-break order (part of the `result_hash` contract):** iterate `unionTs` **ascending**; within a
   single timestamp process symbols strictly in **`request.symbols` order**.
6. **`t_local` semantics:** the per-symbol callback index is the symbol's own **candle index**,
   advanced **only when that symbol has a candle at the current ts**. `preBarStages(env, t_local)` and
   `processBar(env, t_local, base)` must see exactly the same per-symbol series index they see in
   symbol-major — this is what keeps sparse/misaligned coverage correct.
7. **Golden source:** a **committed deterministic fixture/golden** (a vendored real-slice fixture is
   fine). The merge gate must NOT depend on the VPS / live platform. A live real-platform run is
   acceptable as **evidence**, never as the required golden.

## Architecture

`simulateTarget` branches on the flag:

```
if (barMajor && request.symbols.length > 1) → runBarMajor(...)
else                                        → <today's symbol-major loop, unchanged & byte-identical>
```

The shared `Portfolio` and `RunAccumulators` are the same objects in both paths. bar-major replaces
the symbol loop with three phases:

### Phase 1 — Setup (all symbols)

For each symbol (in `request.symbols` order) build its `BarEnv` exactly as `runSymbol` does today:
`candles`, `PointInTimeContextBuilder`, a **fresh module instance** via `moduleFactory` (per-symbol
FSM isolation, unchanged), `gridMinutes`, `fundingCol`, `gridTs`. Call `strategyExec.initStrategy?.`
for each symbol. **All N envs (and their module instances) stay live simultaneously**, held in a map
keyed by symbol — the in-process mirror of the universe container's N resident instances.

### Phase 2 — Bar-major loop

Build the **sorted union of unique timestamps** across all symbols' candle arrays. Maintain a
per-symbol cursor (next candle index). For each `ts` in the union (ascending):

```
for (const symbol of request.symbols) {          // strict request order — tie-break contract
  const env = envs.get(symbol);
  if (env.candles[cursor[symbol]]?.ts !== ts) continue;   // symbol absent at this ts → skip
  const t_local = cursor[symbol];
  preBarStages(env, t_local);
  const base = firstDecision(await env.strategyExec.executeStrategyHook(env.module, 'onBarClose', env.builder.build(t_local, stateAt(portfolio, env.candles[t_local].close))));
  await processBar(env, t_local, base);
  cursor[symbol] += 1;
}
```

The shared portfolio and equity curve are updated in this interleaved order; the equity curve becomes
**temporally ordered** (one appended point per processed `(ts, symbol)` in contract order) rather than
symbol-block-concatenated. The per-bar functions `preBarStages` / `processBar` are **reused
unchanged** — Slice A only reorders their invocation.

17b's `executeStrategyHookBatch` (flat-stretch batching) is **not used** in bar-major mode (the flags
are mutually exclusive); the bar-major loop always takes the single-hook path.

### Phase 3 — Teardown (all symbols)

After the union is exhausted, for each symbol in **`request.symbols` order**: `expirePending`,
`forcedMtmClose(last bar of that symbol)`, `disposeStrategy?.`. For N>1 this forced-close ordering is
**part of the new bar-major hash** (all symbols reach end-of-data before any teardown, vs symbol-major
where each symbol tears down before the next begins). For N=1 it must coincide with the old path.

## Invariants & testing

- **N=1 byte-identity (regression gate):** bar-major `result_hash` for a single-symbol run equals the
  symbol-major `result_hash`. Pins that the reorder is a true no-op at N=1.
- **Twin-equivalence:** trusted (in-process) and sandbox (universe) under bar-major produce a
  **byte-identical** `result_hash` to each other — the existing invariant, now asserted in bar-major
  mode too.
- **New N>1 golden:** a committed deterministic fixture yields a stable bar-major `result_hash`,
  distinct from and recorded alongside the symbol-major golden. Determinism replay (same run twice →
  same hash).
- **Config fail-fast:** `BACKTESTER_BAR_MAJOR=true` + `BACKTESTER_BAR_BATCHING=true` → `loadConfig`
  throws a stable, asserted error message.
- **Universe interleaving (MANDATORY, low-level):** a dedicated test drives the universe session with
  interleaved per-symbol calls (`A0, B0, A1, B1, …`) — the order bar-major produces, exercised for the
  first time (today the session only ever sees symbol-major `A0, A1, …, B0, B1`). It asserts, via a
  spy/trace and NOT only the final hash:
  - the hook-call **order** is exactly the bar-major interleave, and
  - each symbol's `newBar` / bar-index bookkeeping is **monotonic per symbol** and matches the
    sequence it would receive symbol-major.
  This targets the specific bookkeeping-under-interleave failure class a hash comparison can mask.

## Non-goals (out of Slice A)

- No new IPC message type / transport collapse (that is Slice B).
- No change to portfolio position-sizing math, fill model, or risk/exec — only the **order** of
  per-bar application changes.
- No change to the symbol-major default path (byte-identical).
- Single-symbol behavior unchanged.

## Files (anticipated)

- `apps/backtester/src/engine/runner.ts` — flag param on `simulateTarget`; new bar-major driver reusing
  `preBarStages` / `processBar` / `BarEnv` setup extracted from `runSymbol`.
- `apps/backtester/src/config.ts` — `barMajor` config + mutual-exclusion fail-fast.
- wiring from config → engine → `simulateTarget`.
- tests: N=1 byte-identity, N>1 golden + determinism replay, config fail-fast, universe interleaving
  trace; a committed multi-symbol fixture for the golden.
