# Async IPC for the overlay engine (perf #2, realized) — Design

**Date:** 2026-06-24
**Status:** Approved (brainstorming), pending spec review
**Branch:** `feat/async-ipc`
**Base:** `main` @ `10f7421` (perf #2 pool merged)

## Problem

Perf #2 (PR #44, merged) added a bounded in-process worker pool (`runBoundedPool`,
`drainQueue(deps, concurrency)`) so a parameter sweep of N sandboxed strategies can
run concurrently. **Measured result: it does not.** The Docker-gated
`bench-parallel-drain.test.ts` (branch `bench/parallel-drain`, native-Linux CI, N=6)
reports **1.02× speedup** for real sandbox runs while a pure-async control through the
same pool shows **5.99×**. The pool is correct; the runs serialize.

Root cause (grounded in code): the sandbox run path is **synchronous and blocks the
event loop**. `SyncIpcChannel.receive` (`engine/sandbox/ipc.ts`) reads the container's
reply via raw-fd `fs.readSync` in a poll loop with `Atomics.wait(1ms)` — the file's own
comment states it "блокирует event loop на время round-trip'а". `SandboxSession.open()`
/ `callHook()` are synchronous; `runBacktest` / `runSymbol` (`engine/runner.ts`) is a
plain (non-async) function with a synchronous per-bar `for` loop; the `ModuleExecutor`
interface methods (`executeStrategyHook` / `executeOverlayApply`) return synchronously.
So one run is a single non-yielding block — the pool's N slots cannot interleave during
the part of the run where ~all wall-clock lives.

The premise in the perf #2 design ("the sandbox run awaits an I/O round-trip so the
event loop drives the others") was factually wrong: the IPC is synchronous.

## Approach (and why)

Make the overlay-engine run path **yield the event loop while waiting on container
IPC**, so the existing pool overlaps N runs. Concretely: convert the call chain
`runBacktest → simulateTarget → runSymbol → per-bar loop → ModuleExecutor → SandboxSession.callHook`
to `async`, and replace the blocking IPC read with an event-driven (Promise-based) read.

Rejected alternatives (YAGNI / re-open closed decisions):

- **Worker threads** — would let the blocking IPC live off the main thread, but threads
  don't share the JS heap, so the in-process tape cache (perf #1) can't be shared.
- **Multiple processes** — true overlap, but each process gets its own tape cache,
  reopening the L2/Redis question we deliberately closed.
- **Move the bar loop into the sandbox / batch K bars per round-trip** — that is ladder
  #4 (IPC amortization); a larger redesign that changes the point-in-time contract.
  Out of scope here.

Async IPC is the only option that **preserves the shared in-process tape cache** and
makes the *already-merged* pool pay off without new processes/threads.

## Key facts (grounded in code, 2026-06-24)

- Two distinct runners. The OVERLAY engine `runBacktest` lives in `engine/runner.ts`
  (called by `run-overlay.ts::runOverlayBacktest`, in turn called by `worker.ts:180` —
  **not awaited today**). The MOMENTUM runner is a separate file
  (`runner/run-backtest.ts`, `worker.ts:245`) and is **already async** — out of scope.
- `engine/runner.ts`: `runBacktest` (sync) → `simulateTarget` (loops symbols) →
  `runSymbol` (sync per-bar `for`) → `strategyExec.executeStrategyHook(...)` /
  `router.forOverlay(o).executeOverlayApply(...)` (sync). Async must propagate through
  all four.
- `ModuleExecutor` (`engine/module-executor.ts`) is the shared seam routed by provenance
  (`sandbox/routing.ts`: trusted → `InProcessTrustedModuleExecutor`; bundle →
  `SandboxModuleExecutor`). Methods are synchronous today.
- `SyncIpcChannel` (`engine/sandbox/ipc.ts`) is consumed **only** by `SandboxSession`
  (confirmed) → safe to convert in place.
- `DockerDriver.spawnSession` already returns `SpawnedContainer` carrying the live
  `child` (`ChildProcessWithoutNullStreams`) — so `child.stdin/stdout/stderr` **streams
  are already available**; the async channel reads them directly. The `stdinFd/stdoutFd/
  stderrFd` raw fds become unused for IPC and are dropped.
- Container session is strictly sequential (host: send → await reply → send next), so
  within a single channel there is no response interleaving; concurrency is purely
  ACROSS sessions. `seq` matching stays trivial.
- Pool/claim safety unchanged: `runBoundedPool`, `InMemoryJobStore` sync-CAS claim, and
  `PgJobStore` `FOR UPDATE SKIP LOCKED` already hold under real overlap.

## Design

### 1. Async ModuleExecutor seam

`ModuleExecutor.executeStrategyHook` / `executeOverlayApply` / `initStrategy` /
`disposeStrategy` return `Promise<…>` (a single uniform seam — chosen over a dual
sync/async seam to avoid two bar loops). `InProcessTrustedModuleExecutor` wraps its
synchronous computation in `Promise.resolve(...)` (cost: +1 microtask per bar on the
trusted overlay path — negligible). `SandboxModuleExecutor` awaits the now-async
`SandboxSession` hooks. `close?()` stays sync (teardown).

### 2. Async run loop

`runBacktest`, `simulateTarget`, `runSymbol` (`engine/runner.ts`) and
`runOverlayBacktest` (`run-overlay.ts`) become `async`; the per-bar loop `await`s each
executor call. `worker.ts:180` becomes `await runOverlayBacktest(...)`. No change to bar
ordering, decision sequencing, portfolio/PnL math, or the one-bar-at-a-time
point-in-time drip — only the calls now yield while a container reply is pending.

### 3. Async IPC channel

Replace `SyncIpcChannel`'s blocking read with an event-driven, Promise-based channel
over the container's streams:

- `send(req)` → `child.stdin.write(JSON + '\n')`.
- `receive(deadlineEpochMs)` → resolves on the next complete NDJSON line from a buffer
  fed by `child.stdout`'s `'data'` handler; the per-call deadline is a timer
  (`Promise.race` / `AbortController`) instead of inline `Date.now()` polling.
- stderr drained by a `child.stderr` `'data'` handler into the same bounded buffer.
- Stream/quota accounting preserved exactly: `maxDecisionBytes`, `maxStdoutBytes`,
  `maxStderrBytes`, the malformed/overflow/eof/timeout `ReceiveOutcome` variants, and
  `wallTimeMsPerSession`. `readSync` / `writeSync` / `Atomics.wait` / the 1 ms sleep are
  removed (a small per-bar latency win as a side effect).

`DockerDriver` needs no behavioral change (the `child` is already returned); raw-fd
plumbing for IPC is dropped.

### 4. Determinism invariant

Async changes only *when the run yields*, never *what it computes*. Same bars, same
intra-run order, same seeds/RNG, same immutable shared tape. Overlay goldens and the
momentum golden `sha256:eff10116147933c96d92ae50071ef66339467fb69545c38855dcd50c2c0b43ba`
MUST NOT move. Only cross-run completion *ordering* may differ.

## Testing / acceptance

- **Deterministic overlap test (load-bearing, CI, Docker-free).** Inject a test
  `ModuleExecutor` through the real seam whose async hook waits on a shared barrier that
  releases only once N hooks are waiting concurrently. Drain N jobs at `concurrency=N`:
  overlap → barrier reaches N → all complete; serialization → timeout → fail. Pins
  runner+pool+seam overlap without any wall-clock assertion.
- **Docker-gated overlap assertion (CI when Docker present).** During a parallel drain,
  assert ≥2 sandbox containers are alive simultaneously (e.g. via `docker ps` /
  `inspectState`), proving the real IPC yields.
- **parallel-drain bench (manual gate, native Linux).** `bench-parallel-drain.test.ts`
  should flip from 1.02× to ~N× (log-only, no flaky timing assertion in CI).
- **Goldens unchanged.** Existing overlay + momentum golden tests stay green.
- **Full suite + typecheck green**; `check:018` overlay parity gate stays green.

## Scope / non-goals (YAGNI)

Out: worker threads, multi-process workers, Redis/L2, moving the bar loop into the
sandbox or batching K bars per round-trip (ladder #4), the momentum runner (already
async, in-process CPU — single-thread, not helped by the pool), dynamic concurrency
auto-tuning. This change is exactly: async the overlay-engine run path + async IPC, so
the merged perf #2 pool delivers the sweep speedup it was built for.
