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

Because IPC is one message per `(symbol, bar)`, a universe run still issues `N × M` round-trips — the
universe collapse cut container **spawns**, not **round-trips**. The `ipc_profile` measurement on real
long_oi × 3-symbol showed `ipcWait ≈ 44%` of engine time at N=3, scaling ~linearly with N. Cutting
those round-trips is **bar-major's job**: one IPC message per bar carrying all N symbols.

Bar-major transport requires bar-major **execution order** — all symbols must stand on bar `t`
simultaneously, i.e. `for (bar) { for (symbol) }`.

### Discovery that shaped this design: `Portfolio` is single-position

`Portfolio` (`apps/backtester/src/engine/portfolio.ts`) holds a **single** `_position` and a **single**
`_pending` (its own comment: *"Portfolio-wide счётчик открытых позиций (MVP: 0 или 1)"*). Today's
multi-symbol run is therefore **sequential single-position sims sharing one compounding account**:
symbol A trades to completion (its position force-closed at end-of-data), then symbol B starts from the
cash/equity A left behind. This works **only** because symbol-major never overlaps symbols in time.

A bar-major interleave against that one shared portfolio is a **base incompatibility**, not an edge
case: at bar `t`, if symbol A holds the single position, symbol B sees `portfolio.isFlat === false`
and `portfolio.position.symbol === 'A'` and would run its `onPositionBar` against A's position.

So bar-major is **not** a pure loop reorder over a shared portfolio. It requires a portfolio-model
decision.

## Decomposition (decided)

Two slices, execution-flip first:

- **Slice A (this spec):** flip the runner to bar-major order behind a flag, with a **per-symbol
  portfolio** so the interleave is well-defined; aggregate the N per-symbol results into one
  `BacktestRunResult`. Reuses the existing per-bar steps unchanged. **No new IPC protocol.** Establishes
  the bar-major semantics + golden. `trusted == sandbox` byte-identical. No transport perf win yet.
- **Slice B (later spec):** sandbox `hookBarMajor` transport — one IPC message per bar carrying all N
  symbols' increments, harness runs all N instances per message. Must reproduce Slice A's golden
  byte-for-byte. This is where the IPC round-trip win lands.

## Decisions (locked in brainstorming)

1. **Gating:** flag `BACKTESTER_BAR_MAJOR`, **default OFF**. symbol-major stays the default and the
   current golden. bar-major is an opt-in mode with its **own** golden baseline.
2. **N=1 invariant:** bar-major only engages for `symbols.length > 1`; N=1 takes the unchanged
   symbol-major path → **byte-identical `result_hash`** by construction (the aggregation code never runs).
3. **Mutual exclusion with 17b:** `BACKTESTER_BAR_MAJOR` and `BACKTESTER_BAR_BATCHING` cannot both be
   enabled — **fail-fast at config load** with a stable error string (NOT silent precedence).
4. **Timeline alignment:** by **timestamp** (union of all symbols' timestamps). At each ts only the
   symbols that have a candle at that ts act. Temporally correct under differing windows / gaps.
5. **Tie-break order (part of the artifact-ordering contract):** iterate `unionTs` **ascending**; within
   a single timestamp process symbols strictly in **`request.symbols` order**. Under per-symbol
   portfolios this order does **not** cause shared-position conflict — it only fixes deterministic
   artifact ordering (equity points, decisionRecords, merge order).
6. **`t_local` semantics:** the per-symbol callback index is the symbol's own **candle index**, advanced
   **only when that symbol has a candle at the current ts**. `preBarStages(env, t_local)` and
   `processBar(env, t_local, base)` see exactly the same per-symbol series index they see in
   symbol-major.
7. **Golden source:** a **committed deterministic fixture/golden**. The merge gate must NOT depend on the
   VPS / live platform. A live real-platform run is acceptable as **evidence**, never as the required
   golden. The N>1 golden is a golden of the **new bar-major semantics** — NOT a byte-comparison against
   symbol-major (they legitimately differ).
8. **Portfolio model (Variant A):** **per-symbol `Portfolio`**. Each symbol runs its own single-position
   sim in isolation. Today's cross-symbol equity compounding is treated as a **symbol-major ordering
   artifact, not a contract**. Shared multi-position portfolio is explicitly out of scope (see Non-goals).
9. **Result aggregation — equal-weight basket:** each symbol's portfolio starts at
   `INITIAL_EQUITY = 10_000`; the aggregate equity curve is the **temporal sum** of per-symbol
   mark-to-market equity across the union timeline (absent symbols carry their last-known equity forward;
   before a symbol's first bar its equity is `INITIAL_EQUITY`). Aggregate baseline = `N × 10_000`;
   return = `totalPnL / (N × 10_000)` = equal-weight universe return ("N parallel single-symbol runs,
   summed").

## Architecture

`simulateTarget` branches on the flag:

```
if (barMajor && request.symbols.length > 1) → runBarMajor(...)
else                                        → <today's symbol-major loop, unchanged & byte-identical>
```

`runBarMajor` replaces the symbol loop with four phases. The per-bar functions `preBarStages` /
`processBar` are **reused unchanged** — they already take `(env, t)` and operate on `env.portfolio` /
`env.acc`; the driver only changes *which* env they run against and *in what order*.

### Phase 1 — Setup (all symbols)

For each symbol (in `request.symbols` order) build its `BarEnv` exactly as `runSymbol` does today, but
with **its own `Portfolio` (fresh, `INITIAL_EQUITY`) and its own `RunAccumulators`**: `candles`,
`PointInTimeContextBuilder`, a **fresh module instance** via `moduleFactory` (per-symbol FSM isolation,
unchanged), `gridMinutes`, `fundingCol`, `gridTs`. Call `strategyExec.initStrategy?.` for each symbol.
All N envs (each with its own portfolio + acc) stay live simultaneously, held in a map keyed by symbol —
the in-process mirror of the universe container's N resident instances.

### Phase 2 — Bar-major loop

Build the **sorted union of unique timestamps** across all symbols' candle arrays. Maintain a per-symbol
cursor (next candle index). For each `ts` in the union (ascending):

```
for (const symbol of request.symbols) {          // strict request order — tie-break contract
  const env = envs.get(symbol);
  if (env.candles[cursor[symbol]]?.ts !== ts) continue;   // symbol absent at this ts → skip
  const t_local = cursor[symbol];
  preBarStages(env, t_local);
  const base = firstDecision(await env.strategyExec.executeStrategyHook(
    env.module, 'onBarClose', env.builder.build(t_local, stateAt(env.portfolio, env.candles[t_local].close))));
  await processBar(env, t_local, base);
  cursor[symbol] += 1;
}
```

Each `processBar` mutates **only its own symbol's** portfolio + acc — no cross-symbol contention.
17b's `executeStrategyHookBatch` is **not used** in bar-major mode (flags are mutually exclusive).

### Phase 3 — Teardown (all symbols)

After the union is exhausted, for each symbol in **`request.symbols` order**: `expirePending`,
`forcedMtmClose(last bar of that symbol)`, `disposeStrategy?.` — each on its own portfolio + acc.

### Phase 4 — Aggregation → single `RunAccumulators`

Merge the N per-symbol accs into one `acc` for `assembleResult`. All list fields are already
symbol-tagged; ordering is the deterministic tie-break contract (Decision 5):

- **`equityCurve`** — rebuilt as the **temporal sum** (Decision 9): for each union index `u` with
  `ts = unionTs[u]`, aggregate equity `= Σ_symbol equityAtOrBefore(symbol, ts)`, where
  `equityAtOrBefore` is the symbol's equity from its own curve at the greatest bar `≤ ts`, or
  `INITIAL_EQUITY` before its first bar. Emit one point `{ barIndex: u, barTs: ts, equity: sum }`.
- **`trades`** — merge of all symbols' trades, sorted by `(exitTs asc, request.symbols order, per-symbol
  original order)`.
- **`decisionRecords`** — merge, sorted by `(barTs asc, request.symbols order, hook order)`.
- **`orders` / `fills` / `riskDecisions` / `fundingLedger` / `validationIssues`** — merge, each sorted by
  its natural `(barTs/barIndex asc, request.symbols order, per-symbol original order)`.
- **`barsProcessed`** — `Σ candles.length` (unchanged).

`assembleResult` then runs unchanged on the aggregated acc: `computeMetrics(request.metrics,
acc.equityCurve, acc.trades)` sees the equal-weight basket curve.

## Invariants & testing

- **N=1 byte-identity (regression gate):** a single-symbol run under `BACKTESTER_BAR_MAJOR=true`
  produces a `result_hash` byte-identical to the default path (bar-major does not engage at N=1).
- **Twin-equivalence:** trusted (in-process) and sandbox (universe) under bar-major produce a
  **byte-identical** `result_hash` to each other — existing invariant, asserted in bar-major mode too.
- **New N>1 golden:** a committed deterministic multi-symbol fixture yields a stable bar-major
  `result_hash` recorded as the golden for the **new semantics** (equal-weight basket). Determinism
  replay: same run twice → same hash. This is NOT compared against the symbol-major hash.
- **Aggregation unit tests:** temporal-sum equity with absent-symbol carry-forward (a symbol that starts
  late / ends early contributes `INITIAL_EQUITY` before its first bar and its last equity after its
  last); deterministic merge ordering of trades/decisionRecords under the tie-break contract.
- **Config fail-fast:** `BACKTESTER_BAR_MAJOR=true` + `BACKTESTER_BAR_BATCHING=true` → `loadConfig`
  throws a stable, asserted error message.
- **Universe interleaving (MANDATORY, low-level):** a dedicated test drives the universe session with
  interleaved per-symbol calls (`A0, B0, A1, B1, …`) — the order bar-major produces, exercised for the
  first time (today the session only ever sees symbol-major `A0, A1, …, B0, B1`). It asserts, via a
  spy/trace and NOT only the final hash:
  - the hook-call **order** is exactly the bar-major interleave, and
  - each symbol's `newBar` / bar-index bookkeeping is **monotonic per symbol** and matches the sequence
    it would receive symbol-major.

## Non-goals (out of Slice A)

- **Shared multi-position portfolio (Variant B) — explicitly out of scope.** That is a separate product
  epic: one account with concurrent positions across symbols, margin/allocation rules, equity
  attribution, per-symbol pending orders, cross-symbol close sequencing, and re-verification of every
  mutation chokepoint in `Portfolio`. Not this slice.
- No new IPC message type / transport collapse (that is Slice B).
- No change to portfolio position-sizing math, fill model, or risk/exec — only the **execution order**
  and the **result aggregation** change.
- No change to the symbol-major default path (byte-identical). Single-symbol behavior unchanged.

## Files (anticipated)

- `apps/backtester/src/engine/runner.ts` — flag param on `simulateTarget`; new `runBarMajor` driver +
  per-symbol env/acc setup + Phase-4 aggregation, reusing `preBarStages` / `processBar`.
- `apps/backtester/src/config.ts` — `barMajor` config + mutual-exclusion fail-fast.
- wiring: `RunDeps.barMajor` → `simulateTarget`; `AppConfig`/`buildApp`/worker deps.
- tests: N=1 byte-identity, N>1 golden + determinism replay, aggregation units (temporal-sum
  carry-forward, merge ordering), config fail-fast, universe interleaving trace; a committed multi-symbol
  fixture for the golden.
