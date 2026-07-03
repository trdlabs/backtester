# Speculative Bar Batching (17b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Batch flat-stretch `onBarClose` calls into one `hookBatch` message with in-harness early-stop, byte-identical to lockstep by construction and by golden gate.

**Architecture:** Task 1 is a BEHAVIOR-PRESERVING refactor of `runSymbol` — the entire per-bar body (settle, protection, barClose stage, positionBar stage, same-bar settle, funding, equity) moves into `processBar(env, t, base)` where `base` is the module's onBarClose answer; lockstep obtains `base` from the executor, the batch path (Task 4) feeds prefix bars `base = null` and the stop bar its real decision — so the batched prefix runs the IDENTICAL bookkeeping code, never a re-implementation. Tasks 2–3 add the flag plumbing and the session/harness protocol (`hookBatch`/`okBatch` with `stoppedAt` + `barOffset` error attribution). Task 5 is the falsifiable gate: Docker goldens comparing `result_hash` lockstep vs N=2/3/64.

**Tech Stack:** TypeScript (Node 24, ESM), vitest, Docker sandbox harness (plain .mjs).

**Spec:** `docs/superpowers/specs/2026-07-05-batched-bars-design.md` (rev 2).

## Global Constraints

- Task 1 merges NOTHING new behaviorally: after the refactor, the FULL existing gate (incl. Docker goldens `dedup-equivalence`, `overlay-sandbox-equivalence`, momentum/overlay result-hash goldens) must pass unchanged — that green gate IS the proof of behavior preservation, required BEFORE any batch code lands.
- The batch path calls the SAME helpers as lockstep (`processBar` et al.) — hand-rebuilding decisionRecords/equityCurve/risk bookkeeping anywhere is a plan violation.
- Push-order inside a bar is byte-load-bearing and must not change: riskDecisions → orders → placePending → decisionRecords; validationIssues inside compose-error branches; equityCurve last.
- `BACKTESTER_BAR_BATCHING` default **false**; OFF ⇒ zero `hookBatch` messages AND regular `hook` messages byte-identical in shape (channel-spy test required). `BACKTESTER_BATCH_BARS` default **64**, clamped ≥2 (≤1 ⇒ lockstep).
- Batch gate: flag on AND executor exposes `executeStrategyHookBatch` AND hook is onBarClose AND `portfolio.position === null && portfolio.pending === null` AND zero overlays AND >1 bar remains.
- Error attribution: harness err carries `barOffset`; `SessionError.barIndex = batchFirstBarIndex + barOffset`; failure taxonomy codes unchanged; fail-closed semantics identical to lockstep (executor records error, returns empty decisions, run continues).
- Docker-gated goldens compare **`result_hash`** (`contentRef`) lockstep vs batched at N=2, N=3, N=64 — not statuses.
- Branch `feat/bar-batching` from main. `.js` import suffixes in src; tests from REPO ROOT (`pnpm vitest run apps/backtester/test/<f>`); full gate `pnpm check`. Plain Read/Edit/Write tools only. Commit trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Behavior-preserving refactor of `runSymbol` (THE RISK GATE — no batch code here)

**Files:**
- Modify: `apps/backtester/src/engine/runner.ts` (`runSymbol`, lines 310–509)
- Tests: NONE new — the deliverable is proven by the EXISTING suite.

**Interfaces:**
- Consumes: nothing new.
- Produces (module-internal, used by Task 4):
  - `interface BarEnv` — loop-invariant bundle: `{ symbol, candles, builder, strategy, overlays, portfolio, engine, acc, module, strategyExec, gridMinutes, fundingCol, gridTs }`.
  - `async function processBar(env: BarEnv, t: number, base: StrategyDecision | null): Promise<void>` — the ENTIRE per-bar body given the already-obtained onBarClose base decision (stages 1,2,3-apply,positionBar,same-bar-settle,funding,equity). The positionBar stage still calls the executor internally (it can only fire when a position is open — never during a batched prefix).

- [ ] **Step 0: Branch**

```bash
cd /home/alexxxnikolskiy/projects/trading-backtester
git checkout -b feat/bar-batching main
```

- [ ] **Step 1: Capture the pre-refactor baseline**

Run the result-hash-bearing suites and KEEP the output as the baseline evidence:

```bash
pnpm vitest run apps/backtester/test/dedup-equivalence.test.ts apps/backtester/test/overlay-sandbox-equivalence.test.ts apps/backtester/test/overlay-engine.test.ts 2>&1 | tail -5
```

Expected: all pass (Docker-gated legs run on this machine).

- [ ] **Step 2: Refactor**

In `runner.ts`, transform `runSymbol` as follows. RULES: every extracted block is MOVED VERBATIM (same expressions, same push order, same comments); the only new code is function signatures and the `env` object. The result should diff as pure movement plus plumbing.

New env type + construction (before the loop, replacing the current locals):

```typescript
/** Loop-invariant per-symbol environment shared by every per-bar stage (17b refactor). */
interface BarEnv {
  readonly symbol: string;
  readonly candles: readonly Readonly<Bar>[];
  readonly builder: PointInTimeContextBuilder;
  readonly strategy: ResolvedStrategy;
  readonly overlays: OverlaySplit;
  readonly portfolio: Portfolio;
  readonly engine: SimEngine;
  readonly acc: RunAccumulators;
  readonly module: StrategyModule;
  readonly strategyExec: ModuleExecutor;
  readonly gridMinutes: number;
  readonly fundingCol: ReturnType<NonNullable<MarketTapeDataset['funding']>> | undefined;
  readonly gridTs: readonly number[];
}
```

(Adapt the `fundingCol` type to the actual return type of `marketTape.funding(symbol)` — check the local's inferred type; if awkward, use `typeof fundingCol` extraction or an explicit import of the column type.)

`processBar` — the full former loop body with `base` injected (verbatim inner code; here in full):

```typescript
async function processBar(env: BarEnv, t: number, base: StrategyDecision | null): Promise<void> {
  const { symbol, candles, builder, overlays, portfolio, engine, acc, module, strategyExec, gridMinutes, fundingCol, gridTs } = env;
  const { router, risk, exec, composer } = engine;
  const bar = candles[t];

  // NOTE (17b): stages (1)+(2) intentionally do NOT live here — they run BEFORE the executor call
  // in lockstep, so they live in preBarStages() and the caller invokes preBarStages(t) → obtain
  // base → processBar(t, base). processBar covers stages (3)..(5) only. This split keeps the
  // lockstep order byte-identical and lets the batch path interleave the same pre-stages per bar.

  // (3) apply base → entry/signal overlay'и → risk → pending(open).
  const ctx = builder.build(t, stateAt(portfolio, bar.close));
  const comp = await composer.compose(base, overlays.entry, async (o) => {
    const ds = await router.forOverlay(o).executeOverlayApply(o.module, ctx);
    return ds.length > 0 ? ds[0] : null;
  });
  // ... [the ENTIRE remainder of the current loop body verbatim: comp.error push, risk branch with
  //      enter/add_to_position/update_protection, decisionRecords.push for onBarClose, the full
  //      onPositionBar block (its executor call included), the same_bar_close settle, the funding
  //      accrual block, and the equityCurve push — moved without ANY textual change beyond
  //      replacing loop-scope locals with env destructures] ...
}
```

and a tiny pre-stage helper:

```typescript
/** Stages (1)+(2): settle pending from t-1 at open(t), then intrabar protection check. */
function preBarStages(env: BarEnv, t: number): void {
  const { candles, portfolio, engine, acc, symbol } = env;
  const bar = candles[t];
  if (portfolio.pending !== null && portfolio.pending.decisionBarIndex === t - 1) {
    settlePending(bar, t, portfolio, engine.exec, acc, bar.open);
  }
  runProtectionCheck(bar, t, symbol, portfolio, engine.exec, acc);
}
```

The new `runSymbol` loop (everything before the loop unchanged except env construction; init/dispose calls unchanged):

```typescript
  const env: BarEnv = { symbol, candles, builder, strategy, overlays, portfolio, engine, acc, module, strategyExec, gridMinutes, fundingCol, gridTs };

  for (let t = 0; t < n; t += 1) {
    preBarStages(env, t);
    const ctx = builder.build(t, stateAt(portfolio, candles[t].close));
    const base = firstDecision(await strategyExec.executeStrategyHook(module, 'onBarClose', ctx));
    await processBar(env, t, base);
  }
```

CRITICAL SUBTLETY the implementer must preserve: today the `ctx` built for the hook call and the `ctx` used inside stage (3)'s compose are THE SAME object (built once). After the refactor, `runSymbol` builds `ctx` for the executor call and `processBar` builds its own `ctx` for compose — the two `builder.build(t, stateAt(...))` calls happen with IDENTICAL portfolio state (nothing mutates between them), so the snapshots are value-identical. IF `builder.build` has observable side effects or identity-sensitive consumers (check: overlay `executeOverlayApply(o.module, ctx)` uses ctx by value; PointInTimeContextBuilder — read its build() to confirm it's a pure constructor per call), this is safe; verify by reading `builder.build` and note the finding in the report. If build() turns out side-effecting, pass the lockstep ctx INTO processBar as an optional param (`ctxForBar?: StrategyContext`) and have lockstep supply it — batch path builds its own.

- [ ] **Step 3: Typecheck + focused suites**

```bash
npx tsc --noEmit -p apps/backtester
pnpm vitest run apps/backtester/test/dedup-equivalence.test.ts apps/backtester/test/overlay-sandbox-equivalence.test.ts apps/backtester/test/overlay-engine.test.ts
```

Expected: identical pass counts to Step 1 — the goldens hash full results, so green = byte-identical lockstep.

- [ ] **Step 4: FULL gate (the actual proof)**

Run: `pnpm check`
Expected: green, same totals as main. Paste the counts in the report next to Step 1's baseline.

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/engine/runner.ts
git commit -m "refactor(engine): extract per-bar stages of runSymbol into preBarStages/processBar (behavior-preserving, golden-proven)"
```

---

### Task 2: Config flags + engine plumbing

**Files:**
- Modify: `apps/backtester/src/config.ts` (flags near dedup/coalesce lines ~103–108 / ~247–249), `apps/backtester/src/engine/run-strategy.ts` (`StrategyRunDeps`), `apps/backtester/src/jobs/worker.ts` (thread from config where `runStrategyBacktest` is called, ~line 537), `apps/backtester/src/engine/runner.ts` (accept the option in `runBacktest` deps → pass into `runSymbol`/env)
- Test: `apps/backtester/test/config-batching.test.ts` (new, tiny)

**Interfaces:**
- Produces: `AppConfig.barBatching: boolean` (default false), `AppConfig.batchBars: number` (default 64, clamp ≥2 via `Math.max(2, Math.floor(Number(env.BACKTESTER_BATCH_BARS ?? 64)) || 64)`); `StrategyRunDeps.barBatching?: { readonly maxBars: number }` — absent ⇒ lockstep; `BarEnv.batch?: { maxBars: number }`.

- [ ] **Step 1: Failing test**

```typescript
// apps/backtester/test/config-batching.test.ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('bar-batching config', () => {
  it('defaults: off, 64 bars', () => {
    const c = loadConfig({} as NodeJS.ProcessEnv);
    expect(c.barBatching).toBe(false);
    expect(c.batchBars).toBe(64);
  });
  it('parses and clamps', () => {
    const c = loadConfig({ BACKTESTER_BAR_BATCHING: 'true', BACKTESTER_BATCH_BARS: '1' } as NodeJS.ProcessEnv);
    expect(c.barBatching).toBe(true);
    expect(c.batchBars).toBe(2); // clamped ≥2
    expect(loadConfig({ BACKTESTER_BATCH_BARS: 'garbage' } as NodeJS.ProcessEnv).batchBars).toBe(64);
  });
});
```

- [ ] **Step 2: Verify fail → implement**

config.ts (next to the dedup/coalesce flags — same style):

```typescript
  /** 17b: batch flat-stretch onBarClose calls into one sandbox message. Default off (dark launch). */
  readonly barBatching: boolean;
  /** 17b: max bars per hookBatch (clamped >= 2). */
  readonly batchBars: number;
```

```typescript
    barBatching: env.BACKTESTER_BAR_BATCHING === 'true',
    batchBars: Math.max(2, Math.floor(Number(env.BACKTESTER_BATCH_BARS ?? 64)) || 64),
```

`run-strategy.ts` `StrategyRunDeps` gains `readonly barBatching?: { readonly maxBars: number };` and passes it through to `runBacktest`'s deps (trace how `registry`/`router` flow — same object). `runner.ts`: `runBacktest` deps type gains the same optional field; `runSymbol` receives it and stores `batch` on `BarEnv`. `worker.ts` at the `runStrategyBacktest(...)` call site: `...(deps.barBatchingConfig ? { barBatching: { maxBars } } : {})` — concretely, add `barBatching?: boolean; batchBars?: number` to `WorkerDeps` (threaded in app.ts/worker-main.ts from config like `dedupEnabled` is) and build the option object at the call site when `deps.barBatching === true`. ONLY the strategy route passes it (`runOverlayBacktest` call sites untouched).

- [ ] **Step 3: Run + typecheck + commit**

```bash
pnpm vitest run apps/backtester/test/config-batching.test.ts && npx tsc --noEmit -p apps/backtester
git add apps/backtester/src/config.ts apps/backtester/src/engine/run-strategy.ts apps/backtester/src/engine/runner.ts apps/backtester/src/jobs/worker.ts apps/backtester/src/app.ts apps/backtester/src/worker-main.ts apps/backtester/test/config-batching.test.ts
git commit -m "feat(engine): BACKTESTER_BAR_BATCHING/BATCH_BARS flags threaded to the strategy engine (inert — no batch path yet)"
```

(Include only the files actually touched. The flag is INERT after this task — nothing consumes `env.batch` yet; full behavior change waits for Task 4.)

---

### Task 3: Protocol — session `callHookBatch`, channel `okBatch`, harness early-stop

**Files:**
- Modify: `apps/backtester/src/engine/sandbox/ipc.ts` (wire types), `apps/backtester/src/engine/sandbox/async-ipc-channel.ts` (parseLine accepts `okBatch`), `apps/backtester/src/engine/sandbox/sandbox-session.ts` (`callHookBatch`), `apps/backtester/sandbox-harness-overlay/entry.mjs` (`handleHookBatch` + dispatch)
- Test: `apps/backtester/test/harness-hook-batch.test.ts` (new — drives entry.mjs as a child process with fake module fixtures, no Docker), `apps/backtester/test/sandbox-session-batch.test.ts` (new — session unit against a scripted fake channel/container; mirror how existing sandbox-session unit tests fake the driver — find one via `grep -ln "SandboxSession" apps/backtester/test`)

**Interfaces:**
- Produces:
  - Wire: `HookBatchRequest { t:'hookBatch', seq, hook:'onBarClose', bars: Array<{ snapshot, newBar, newOi?, newLiq? }> }`; response `{ t:'okBatch', seq, stoppedAt, decisions }`; batch err lines gain `barOffset`.
  - `ReceiveOutcome` gains `| { kind: 'okBatch'; seq?: number; stoppedAt: number; decisions: readonly unknown[] }`.
  - `SandboxSession.callHookBatch(ctxs: readonly StrategyContext[]): Promise<BatchHookResult>` where `BatchHookResult = { ok: true; stoppedAt: number; decisions: readonly unknown[] } | { ok: false; stoppedAt: number; error?: SessionError }` — on err, `stoppedAt = barOffset - 1` (bars before the failure completed) and `SessionError.barIndex = firstBarIndex + barOffset`.

- [ ] **Step 1: Harness — failing test first**

`handleHookBatch(msg)` in entry.mjs (verbatim implementation to add after `handleHook`):

```javascript
async function handleHookBatch(msg) {
  const { seq, hook, bars } = msg;
  try {
    for (let j = 0; j < bars.length; j += 1) {
      const { snapshot, newBar, newOi, newLiq } = bars[j];
      if (newBar !== null && newBar !== undefined) buffer.push(newBar);
      if (newOi !== undefined) oiBuffer.push(newOi);
      if (newLiq !== undefined) liqBuffer.push(newLiq);
      const ctx = rehydrateContext(snapshot, buffer, rng, oiBuffer, liqBuffer);
      const fn = pickHook(hook);
      let out = [];
      if (fn !== undefined) {
        try {
          out = normalize(await fn.call(instance, ctx));
        } catch (e) {
          // Early failure: bars 0..j-1 completed; attribute the failing bar.
          errBatch(seq, hook, classifyError(e), e && e.message ? e.message : e, j);
          return;
        }
      }
      if (out.length > 0) {
        okBatch(seq, j, out); // early-stop: entries after j are NEVER executed
        return;
      }
    }
    okBatch(seq, bars.length - 1, []); // fully-empty batch
  } catch (e) {
    errBatch(seq, hook, classifyError(e), e && e.message ? e.message : e, 0);
  }
}
```

plus line builders next to `ok`/`err`:

```javascript
const okBatch = (seq, stoppedAt, decisions) =>
  process.stdout.write(`${JSON.stringify({ t: 'okBatch', seq, stoppedAt, decisions })}\n`);
const errBatch = (seq, hook, code, detail, barOffset) =>
  process.stdout.write(`${JSON.stringify({ t: 'err', seq, hook, code, detail: String(detail ?? '').slice(0, 4096), barOffset })}\n`);
```

and the dispatch branch in `main()` after the `t === 'hook'` case:

```javascript
    } else if (msg.t === 'hookBatch') {
      await handleHookBatch(msg);
```

Test `harness-hook-batch.test.ts`: spawn `node sandbox-harness-overlay/entry.mjs` (find how existing harness tests do it — `grep -ln "entry.mjs" apps/backtester/test`; if no direct-spawn precedent exists, drive it via child_process with a fixture bundle dir on the command line the same way the SANDBOX mounts it — read entry.mjs's init handling for the expected env/argv). Cases: (a) 5-bar batch, module signals on bar 2 ⇒ `okBatch stoppedAt=2` with those decisions, and a followup `hook` message for bar 3 sees history buffers advanced by exactly 3 bars (state continuity); (b) all-empty ⇒ `stoppedAt=4, decisions=[]`; (c) module throws on bar 1 ⇒ `err` with `barOffset:1`; (d) interleaving `hook` then `hookBatch` then `hook` keeps seq/ordering.

- [ ] **Step 2: Channel + session**

`ipc.ts`: add the two wire types + extend `Request`/`ReceiveOutcome` per Interfaces. `async-ipc-channel.ts` `parseLine`: accept `t === 'okBatch'` → the new outcome (validate `stoppedAt` is a number; malformed otherwise); `err` lines may carry `barOffset` (pass through on the err outcome: add optional `barOffset?: number`).

`sandbox-session.ts` `callHookBatch` (mirrors `callHook`'s per-entry newBar/newOi/newLiq increment logic — factor the increment block into a private `buildHookPayload(ctx)` used by BOTH `callHook` and `callHookBatch` so the two cannot drift):

```typescript
  async callHookBatch(ctxs: readonly StrategyContext[]): Promise<BatchHookResult> {
    if (this.failed) return { ok: false, stoppedAt: -1, error: this.lastError };
    if (this.channel === undefined) {
      const opened = await this.open();
      if (!opened.ok) return { ok: false, stoppedAt: -1, error: this.lastError };
    }
    const channel = this.channel;
    if (channel === undefined) return { ok: false, stoppedAt: -1, error: this.lastError };
    const firstBarIndexBefore = this.barIndex;
    const bars = ctxs.map((ctx) => this.buildHookPayload(ctx)); // advances barIndex/lastBarTs per entry
    this.seq += 1;
    channel.send({ t: 'hookBatch', seq: this.seq, hook: 'onBarClose', bars });
    const outcome = await channel.receive(this.callDeadline());
    if (outcome.kind === 'okBatch') {
      // Harness executed 0..stoppedAt; roll host-side bar bookkeeping back for the discarded tail
      // so the next lockstep/batch call re-sends those bars' newBar increments.
      this.rewindBars(bars.length - 1 - outcome.stoppedAt, ctxs, outcome.stoppedAt);
      return { ok: true, stoppedAt: outcome.stoppedAt, decisions: outcome.decisions };
    }
    if (outcome.kind === 'err' && outcome.barOffset !== undefined) {
      const failed = this.mapFailure(outcome, 'onBarClose', 'sandbox_crashed');
      // attribute the failing bar
      const err = { ...failed.error!, barIndex: firstBarIndexBefore + 1 + outcome.barOffset };
      this.fail(err);
      return { ok: false, stoppedAt: outcome.barOffset - 1, error: err };
    }
    const failedGeneric = this.fail(this.mapFailure(outcome, 'onBarClose', 'sandbox_crashed'));
    return { ok: false, stoppedAt: -1, error: failedGeneric.error };
  }
```

DESIGN NOTE the implementer must resolve against the real `callHook` internals (quoted in the research annex at the bottom of this plan): host-side `barIndex`/`lastBarTs` advance inside the payload build; after an early stop the DISCARDED tail bars were counted host-side but never consumed harness-side. Either (a) rewind host counters for the tail (shown above as `rewindBars` — implement it precisely: restore `barIndex`/`lastBarTs` to the values after entry `stoppedAt`), or (b) build payloads lazily one-at-a-time and only count consumed entries — pick whichever keeps `buildHookPayload` shared with `callHook`, document the choice, and pin it with the session unit test (next step). The harness-side buffers advanced only for executed entries — host and harness MUST agree on the resend boundary: the tail's `newBar`s must be re-sent by subsequent calls.

- [ ] **Step 3: Session unit test** (`sandbox-session-batch.test.ts`, scripted fake channel): okBatch mid-stop ⇒ stoppedAt propagated, host barIndex bookkeeping equals "stoppedAt+1 consumed" (verify by inspecting the NEXT call's payload: its `newBar` must be the first discarded bar); err with barOffset ⇒ `error.barIndex = firstBar + offset`, session fail-closed; fully-empty ⇒ stoppedAt = N-1; deadline/eof outcomes map exactly like callHook's.

- [ ] **Step 4: Run + typecheck + commit**

```bash
pnpm vitest run apps/backtester/test/harness-hook-batch.test.ts apps/backtester/test/sandbox-session-batch.test.ts && npx tsc --noEmit -p apps/backtester
git add apps/backtester/src/engine/sandbox/ipc.ts apps/backtester/src/engine/sandbox/async-ipc-channel.ts apps/backtester/src/engine/sandbox/sandbox-session.ts apps/backtester/sandbox-harness-overlay/entry.mjs apps/backtester/test/harness-hook-batch.test.ts apps/backtester/test/sandbox-session-batch.test.ts
git commit -m "feat(sandbox): hookBatch protocol — harness early-stop + barOffset attribution, session callHookBatch (inert — engine not wired)"
```

---

### Task 4: Executor batch method + engine batch path (reusing Task 1 helpers)

**Files:**
- Modify: `apps/backtester/src/engine/module-executor.ts` (interface — optional method), `apps/backtester/src/engine/sandbox/sandbox-executor.ts` (`SandboxModuleExecutor.executeStrategyHookBatch`), `apps/backtester/src/engine/runner.ts` (batch branch in `runSymbol`'s loop)
- Test: `apps/backtester/test/engine-bar-batching.test.ts` (new — scripted fake executor, NO Docker)

**Interfaces:**
- Produces: `ModuleExecutor.executeStrategyHookBatch?(module: StrategyModule, ctxs: readonly StrategyContext[]): Promise<{ stoppedAt: number; decisions: readonly StrategyDecision[] }>` — implemented ONLY by `SandboxModuleExecutor` (wraps `callHookBatch`, revalidates decisions through the SAME `revalidator.revalidateStrategy` as lockstep; on `!ok` records the error and returns `{ stoppedAt: max(error-implied consumed bars, 0), decisions: [] }` — mirroring lockstep's fail-closed empty-decisions semantics).

- [ ] **Step 1: Failing engine unit tests**

`engine-bar-batching.test.ts` drives `runSymbol` (via `runStrategyBacktest`/`runBacktest` on a small in-memory fixture tape — mirror how an existing runner unit test constructs deps; `grep -ln "runBacktest(" apps/backtester/test` and reuse the smallest) with a FAKE executor implementing both methods and scripted answers:

- cursor/off-by-one: scripted `stoppedAt` at 0, mid (2 of 5), and N-1 — assert per-run: decisionRecords count == bar count, each barIndex present exactly once, equityCurve length == bar count, loop terminates, and total executor calls == expected batch+lockstep sequence.
- gate: in-position bars and pending-present bars are NEVER in a batch call (fake records the ctxs it receives; assert every batched ctx has `position === null && pendingIntent === null`).
- executor WITHOUT the batch method (plain object with only executeStrategyHook) ⇒ zero batch calls, pure lockstep.
- flag-off (no `barBatching` in deps) ⇒ zero batch calls even when the method exists.
- error mid-batch: fake returns the fail-closed shape ⇒ run continues, affected bar's decisionRecord has base=null, subsequent bars proceed (lockstep-equivalent continuation).
- N clamp: `maxBars` given as 1 ⇒ lockstep (already clamped at config, but the engine guard must also treat <2 as lockstep).
- byte-shape spy: with flag OFF and the real `SandboxModuleExecutor` types unused, assert (unit level) that the lockstep path emits ONLY `executeStrategyHook` calls with the same (module, hook, ctx) triple as before the feature — i.e. the refactor left the lockstep call signature untouched.

- [ ] **Step 2: Implement**

`module-executor.ts` interface addition:

```typescript
  /**
   * 17b (опционально; только sandbox): пакет flat-баров onBarClose одним IPC-сообщением с ранней
   * остановкой на первом сигнале. Отсутствие метода ⇒ движок остаётся в lockstep.
   */
  executeStrategyHookBatch?(
    module: StrategyModule,
    ctxs: readonly StrategyContext[],
  ): Promise<{ stoppedAt: number; decisions: readonly StrategyDecision[] }>;
```

`sandbox-executor.ts`:

```typescript
  async executeStrategyHookBatch(
    _module: StrategyModule,
    ctxs: readonly StrategyContext[],
  ): Promise<{ stoppedAt: number; decisions: readonly StrategyDecision[] }> {
    const r = await this.sessionFor(ctxs[0]!).callHookBatch(ctxs);
    if (!r.ok) {
      if (r.error !== undefined) this.record(r.error, ctxs[Math.max(0, r.stoppedAt + 1)] ?? ctxs[0]!);
      // Fail-closed mirror of lockstep: completed prefix bars stand; the failing bar contributes
      // empty decisions; the run continues (subsequent calls fail fast on the dead session).
      return { stoppedAt: Math.max(0, Math.min(r.stoppedAt + 1, ctxs.length - 1)), decisions: [] };
    }
    const rv = this.revalidator.revalidateStrategy(r.decisions);
    if (!rv.ok) {
      this.record({ code: 'decision_schema_invalid', detail: rv.message, hook: 'onBarClose' }, ctxs[r.stoppedAt]!);
      return { stoppedAt: r.stoppedAt, decisions: [] };
    }
    return { stoppedAt: r.stoppedAt, decisions: rv.decisions };
  }
```

`runner.ts` — the loop from Task 1 gains the batch branch (the ONLY place batching exists; prefix bars flow through the SAME `preBarStages` + `processBar`):

```typescript
  for (let t = 0; t < n; t += 1) {
    preBarStages(env, t);

    const batchCfg = env.batch;
    if (
      batchCfg !== undefined &&
      batchCfg.maxBars >= 2 &&
      strategyExec.executeStrategyHookBatch !== undefined &&
      portfolio.position === null &&
      portfolio.pending === null &&
      overlays.entry.length === 0 &&
      overlays.post.length === 0 &&
      t + 1 < n
    ) {
      // Flat stretch: snapshots for t..t+k are a pure function of the tape (portfolio constant).
      const upTo = Math.min(n, t + batchCfg.maxBars);
      const ctxs: StrategyContext[] = [];
      for (let j = t; j < upTo; j += 1) {
        ctxs.push(builder.build(j, stateAt(portfolio, candles[j].close)));
      }
      const { stoppedAt, decisions } = await strategyExec.executeStrategyHookBatch(module, ctxs);
      // Empty prefix: SAME per-bar body with base = null (byte-identical bookkeeping).
      for (let j = 0; j < stoppedAt; j += 1) {
        await processBar(env, t + j, null);
        if (j < stoppedAt - 1) preBarStages(env, t + j + 1); // no-ops while flat; keeps stage order
      }
      if (stoppedAt > 0) preBarStages(env, t + stoppedAt);
      await processBar(env, t + stoppedAt, firstDecision(decisions));
      t += stoppedAt; // loop's t += 1 completes the stoppedAt + 1 advance
      continue;
    }

    const ctx = builder.build(t, stateAt(portfolio, candles[t].close));
    const base = firstDecision(await strategyExec.executeStrategyHook(module, 'onBarClose', ctx));
    await processBar(env, t, base);
  }
```

STAGE-ORDER CAVEAT (the implementer must verify and the cursor unit test pins): in lockstep the order is `preBarStages(t) → hook(t) → processBar(t)`. In the batch branch `preBarStages(t)` already ran before the batch call; for bars t+1..t+stoppedAt the pre-stages run interleaved as shown. Since every batched bar is flat with no pending BY GATE + prefix decisions are empty (nothing can place pending until the stop bar's decision), all interleaved `preBarStages` are provable no-ops until the stop bar — but they MUST still run in the same relative order for future-proofing (e.g. protection-check bookkeeping if it ever writes on flat). Assert in the cursor test that record/equity ordering equals lockstep's for the same scripted answers.

- [ ] **Step 3: Flag-off wire-shape test**

Add to `sandbox-session-batch.test.ts` (or a small addition to the engine test): with `barBatching` absent, a spy channel/executor sees ZERO `hookBatch`/`executeStrategyHookBatch` invocations and each `hook` envelope has exactly today's key set (`t, seq, hook, snapshot, newBar` + conditional `newOi/newLiq`) — byte-identical shape.

- [ ] **Step 4: Run + typecheck + commit**

```bash
pnpm vitest run apps/backtester/test/engine-bar-batching.test.ts apps/backtester/test/sandbox-session-batch.test.ts && npx tsc --noEmit -p apps/backtester
git add apps/backtester/src/engine/module-executor.ts apps/backtester/src/engine/sandbox/sandbox-executor.ts apps/backtester/src/engine/runner.ts apps/backtester/test/engine-bar-batching.test.ts apps/backtester/test/sandbox-session-batch.test.ts
git commit -m "feat(engine): flat-stretch bar batching behind BACKTESTER_BAR_BATCHING — batch path reuses lockstep per-bar helpers"
```

---

### Task 5: Docker-gated result_hash goldens (the falsifiable gate)

**Files:**
- Create: `apps/backtester/test/bar-batching-equivalence.test.ts`

**Interfaces:** consumes everything above; nothing new produced.

- [ ] **Step 1: Write the golden suite** (mirror `test/dedup-equivalence.test.ts:132–180` VERBATIM in structure — same `describe.skipIf(!DOCKER_AVAILABLE)`, same `materializeReadableBundle(loadInlineBundle('short-after-pump.bundle.json'))`, same `buildOverlayDataset(new FixtureDataPort(FIXTURES_DIR), ...)` on `strategyBaselineReq`):

```typescript
// Falsifiable gate (17b): lockstep vs batched result_hash must be byte-identical for N=2/3/64.
// The short_after_pump fixture SIGNALS mid-tape, so small N forces batch boundaries around both
// flat stretches and the in-position cluster.
for (const maxBars of [2, 3, 64]) {
  it(`batched (N=${maxBars}) result is byte-identical to lockstep`, async () => {
    // ... two materialized bundles + routers as in dedup-equivalence ...
    const lockstep = await runStrategyBacktest(
      { ...strategyBaselineReq, runId: 'run-AAAAAAAA', engine: 'strategy' },
      { registry: depsA.registry, marketTape, router: depsA.router },
    );
    const batched = await runStrategyBacktest(
      { ...strategyBaselineReq, runId: 'run-BBBBBBBB', engine: 'strategy' },
      { registry: depsB.registry, marketTape, router: depsB.router, barBatching: { maxBars } },
    );
    const restamped = restamp(normalize('strategy', lockstep, 'run-AAAAAAAA'), 'run-BBBBBBBB');
    expect(contentRef(restamped)).toBe(contentRef(batched)); // result_hash, not status
  }, 180_000);
}
```

Plus: determinism — batched (N=3) run twice ⇒ identical `contentRef` (reuse the same two-router pattern with equal runIds via restamp or fresh runIds compared through normalize).

- [ ] **Step 2: Run (Docker) + full gate**

```bash
pnpm vitest run apps/backtester/test/bar-batching-equivalence.test.ts
pnpm check
```

Expected: goldens PASS for all three N; full gate green (flag defaults off — everything else byte-identical). If ANY N diverges: STOP, do not weaken the assertion — bisect with the harness/engine unit tests (this is the gate doing its job).

- [ ] **Step 3: Commit**

```bash
git add apps/backtester/test/bar-batching-equivalence.test.ts
git commit -m "test(engine): bar-batching golden gate — lockstep vs N=2/3/64 result_hash byte-identity + determinism replay (Docker)"
```

---

### Task 6: Docs + final review + wrap-up

- [ ] **Step 1: OPERATIONS.md** — short section: flags, default off, dark-launch playbook (enable in env → VPS re-profile quantifies the win), the batching-never-changes-results invariant (golden-gated), and the coalesce/dedup note (computeIdentity unaffected BY DESIGN — batching must never enter the fingerprint).
- [ ] **Step 2: Full `pnpm check`** + diff scope check (`git diff main --stat`: runner.ts, config.ts, run-strategy.ts, worker.ts, app.ts/worker-main.ts (threading), module-executor.ts, sandbox-executor.ts, sandbox-session.ts, ipc.ts, async-ipc-channel.ts, entry.mjs, new tests, OPERATIONS.md, docs).
- [ ] **Step 3: Commit docs; finishing-a-development-branch (PR, squash convention).**

---

## Research annex (verbatim anchors for implementers)

- `runSymbol` original: `src/engine/runner.ts:310–509`; loop-mutated state: `t`, `portfolio` (settlePending/runProtectionCheck/placePending/updateProtection/chargeFunding + post-loop expirePending/forcedMtmClose), `acc.{orders,riskDecisions,decisionRecords,validationIssues,fundingLedger,equityCurve,trades}`.
- `callHook` increments (`sandbox-session.ts:132+`): `newBar`/`newOi`/`newLiq` computed off `ctx.bar.ts !== this.lastBarTs`, advancing `this.barIndex`/`this.lastBarTs` — the shared `buildHookPayload` extraction in Task 3 must carry this exactly, and the early-stop tail rewind must restore both fields.
- Harness state: `buffer/oiBuffer/liqBuffer` module-scope arrays; `barIndex` rides in `snapshot.barIndex` (harness keeps no cursor).
- `AsyncIpcChannel.send` is fire-and-forget; responses are seq'd lines via `parseLine`.
- Golden pattern: `test/dedup-equivalence.test.ts:132–180` (contentRef/normalize/restamp; `DOCKER_AVAILABLE` from `test/store-factories.ts:13`); strategy fixture `test/fixtures/overlay/bundles/short-after-pump.bundle.json` + request `baseline.json` (`datasetRef 'pump-fixture-1m'`).
- Config flag pattern: `src/config.ts:103–108` (fields) / `:247–249` (env parse); engine receives options via `StrategyRunDeps` (`src/engine/run-strategy.ts:8–12`) from `worker.ts:537` area.
