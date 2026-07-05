# Speculative bar batching (Phase D item 17b) — design

Date: 2026-07-05 (rev 2 — user review applied)
Status: approved for planning
Context: ROADMAP 17b. IPC profile (17a, WSL2): sandboxed strategy-run engine time ≈ 45–50%
IPC-wait (~3 ms/hook × ~1300 hooks), ~20% container open, ~30% host CPU. The per-hook round trip
is the single largest cost component. This spec batches the FLAT stretches — where snapshots are a
pure function of the tape — into one message per N bars, with an early-stop at the first signal.
Falsifiable gate: lockstep vs batched must be byte-identical (`result_hash`) on real bundles.
Final perf numbers come from the VPS re-profile; the correctness work is environment-independent.

## Goals

1. Cut per-bar IPC round trips on flat stretches (no position, no pending decisions) by batching
   up to `N` consecutive `onBarClose` calls into one NDJSON message with in-harness early-stop.
2. Byte-identical results: `result_hash` equal to lockstep for every module, every tape — enforced
   by golden equivalence tests on real bundles (INV-6 / twin-equivalence pattern).
3. Default OFF (`BACKTESTER_BAR_BATCHING`, batch size `BACKTESTER_BATCH_BARS`, default 64) — the
   OFF path stays byte-identical to today at the protocol level (no message shape changes seen by
   the harness).

## Non-goals

- No batching of `onPositionBar` (in-position state mutates host-side every bar), overlay hooks
  (`executeOverlayApply` — separate semantics), momentum/trusted executors (no IPC), or
  multi-symbol batching (that is 17c universe session; the two compose later).
- No protocol handshake/back-compat machinery: the harness is mounted per-container from the
  host's `harnessDir`, so host and harness versions move together by construction.
- No change to sandbox policy caps' MEANING (see §4 for how the per-call deadline applies).
- No default flip; no result/artifact/schema changes.

## Design

### 1. Why flat stretches are exactly batchable

At bar `t` with no open position and no pending decisions, the host applies nothing to the
portfolio; the bar `t+1` snapshot (`serializeContext`) is therefore a deterministic function of
the tape alone (cash-only portfolio is constant; history accumulates container-side from `newBar`
increments). So the host can precompute snapshots/increments for bars `t..t+N-1` WITHOUT knowing
the module's answers — as long as every answer in the prefix is EMPTY. The first non-empty answer
invalidates nothing: the harness stops exactly AT that bar, its module state equals lockstep state
after that bar's hook, and the host applies that decision through the normal path. No rollback,
no speculation debt — "speculative" only in that the host prepared inputs it may discard.

### 2. Protocol (one new message pair; lockstep messages unchanged)

Host → harness (only when batching is active AND the gate in §3 holds):

```
{ t: 'hookBatch', seq, hook: 'onBarClose',
  bars: [ { snapshot, newBar, newOi?, newLiq? }, ... ] }   // 1..N entries, bar order
```

Harness → host:

```
{ t: 'okBatch', seq, stoppedAt: k, decisions }   // executed bars 0..k inclusive;
                                                 // bars 0..k-1 returned empty decisions;
                                                 // `decisions` = bar k's (possibly empty) answer
```

Harness semantics: iterate entries in order against the live instance exactly as `handleHook`
does today (same barIndex/history advancement per entry); stop after the first entry whose
decisions are non-empty; entries after `stoppedAt` are NEVER executed (their inputs are
discarded).

**Error attribution:** an error in entry `j` fails the whole call with today's error SHAPE plus a
`barOffset: j` field on the error line; the host maps it so `SessionError.barIndex` points at the
FAILING bar (`batchFirstBarIndex + j`), not at the batch's first bar — failure taxonomy codes
unchanged, only the index is precise.

Host semantics (`runSymbol` loop): while the §3 gate holds, collect up to N bars, send one
`hookBatch`, then advance the loop cursor by `stoppedAt + 1` bars, apply bar-k decisions via the
normal path (risk/exec/portfolio), and continue — in lockstep while in-position, back to batching
when flat again. `seq` stays one-per-message; the host's barIndex bookkeeping mirrors the
harness's per-entry advancement (both sides advance by `stoppedAt + 1` bars).

**Host-side per-bar side effects for the empty prefix (byte-identity anchor):** for EVERY executed
bar `0..stoppedAt` the host runs the SAME per-bar bookkeeping it runs in lockstep — decision
records, equity-curve points, per-bar cursors/counters, and anything else that feeds artifacts or
`result_hash` — byte-for-byte, even when that bar's decisions are `[]`. Batching changes only how
the module's ANSWERS travel, never what the host records per bar. The plan must identify every
per-bar write in the lockstep loop and route the batched prefix through the identical code (shared
helper, not a re-implementation).

**Fully-empty batch:** all N answers empty ⇒ `stoppedAt = N - 1`, `decisions: []`; the host walks
the empty per-bar path for all N bars and the loop continues batching from bar N.

### 3. Batching gate (engine-side, conservative) + executor seam

**Seam:** `ModuleExecutor` gains an OPTIONAL method
`executeStrategyHookBatch?(module, bars): Promise<BatchHookResult>` implemented ONLY by
`SandboxModuleExecutor`; `TrustedMomentumExecutor` / `InProcessTrustedModuleExecutor` / overlay
paths do not implement it and stay lockstep untouched. The engine batches only when the method
exists AND the gate holds — no `instanceof` checks, no engine knowledge of executor internals.

Batch ONLY when ALL hold: flag on; the executor exposes the batch method (⇒ sandbox strategy
path); hook is `onBarClose`; no open position; no pending orders/decisions from the previous bar;
zero overlays attached (the strategy route passes none by construction); more than 1 bar remains.
Anything else ⇒ lockstep, bar by bar, exactly today's path. The gate is re-evaluated every
iteration — one in-position bar flips to lockstep, the first flat bar after close flips back.

### 4. Deadlines and caps

One `hookBatch` call uses ONE per-call deadline (`wallTimeMsPerCall`, default 2 s) — measured
in-sandbox compute is ≲0.3 ms/bar, so a 64-bar batch consumes <5% of the budget; the session
deadline is untouched. If a batch ever times out, the failure maps through the existing
`mapFailure` taxonomy (same codes), attributed to the batch's first bar. Stdout/stderr caps
unchanged (one response line per batch is SMALLER than N lockstep lines).

### 5. Config

| Env | Default | Effect |
|---|---|---|
| `BACKTESTER_BAR_BATCHING` | false | master flag; OFF ⇒ wire-identical to today |
| `BACKTESTER_BATCH_BARS` | 64 | max bars per hookBatch (clamped ≥ 2; 1 ⇒ effectively off) |

Batching participates in `computeIdentity`? NO — by the byte-identity invariant the result is
independent of batching, so dedup/coalescing keys stay untouched (this is exactly why the golden
gate must be strict).

## Testing (the falsifiable gate)

- **Golden byte-identity (REQUIRED, Docker-gated):** for real bundles (`short_after_pump`,
  `long_oi` fixture) and the existing golden tapes: run lockstep (flag off) and batched (flag on,
  **N=64, N=3 AND N=2** — small N forces many batch boundaries; N=2 is the minimal boundary case)
  ⇒ `result_hash` byte-identical. Include a tape where a signal fires MID-batch and one where
  trades cluster (in-position stretches interleave with flat ones).
- Harness unit (node, no Docker — drive entry.mjs's handler with a fake stdin): early-stop at
  first non-empty decisions; fully-empty batch returns `stoppedAt = N-1, decisions: []`; state
  continuity (batch of k then lockstep bar k+1 ≡ lockstep all the way — assert identical module
  outputs); error in entry j carries `barOffset: j`.
- Engine unit: gate never batches in-position / with pending decisions / for executors without
  the batch method (trusted/overlay); **dedicated cursor/off-by-one unit** — scripted fake channel
  returning `stoppedAt` at 0, mid, and N-1: assert the loop cursor, host `barIndex`, and per-bar
  bookkeeping counts advance by exactly `stoppedAt + 1` each time (the empty prefix writes the
  same decision-record/equity entries as lockstep); `SessionError.barIndex` = batchFirstBar +
  barOffset on a mid-batch error; N clamping (≤1 ⇒ lockstep).
- Default-off: flag unset ⇒ zero `hookBatch` messages (channel spy) and existing suites
  byte-identical (full gate).
- Determinism: batched run replayed twice ⇒ identical `result_hash` (existing replay pattern).

## Rollout

Flag-gated dark launch (same playbook as dedup/coalescing): merge default OFF → enable in the
working env → validate on the VPS re-profile (17a numbers will quantify the actual win; expected
−~40% engine time for rarely-trading strategies, degrading gracefully to ~0 for every-bar
traders). One PR, branch `feat/bar-batching`.

## Decisions taken (flag for review)

1. Early-stop INSTEAD of rollback: the harness never executes past the first signal, so no state
   rewind exists anywhere — simpler and provably lockstep-equivalent.
2. Batch replies return only `stoppedAt` + bar-k decisions (prefix is empty by protocol) — not
   N decision arrays; keeps the response line small and the invariant explicit.
3. `onPositionBar` stays lockstep forever in this spec (in-position batching would need real
   speculation; out of scope by design).
4. One per-call deadline per batch (not ×N) — documented, backed by measured per-bar compute.
5. No lookahead: the gate needs only CURRENT flatness — bars are batched optimistically up to N
   and the harness early-stops at the first signal. The host never predicts future position state.
