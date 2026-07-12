# Bar-major transport collapse (Slice B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the N per-`(symbol,bar)` `onBarClose` IPC round-trips of a universe bar-major run into ONE `hookBarMajor` message per bar, byte-identical to Slice A.

**Architecture:** A new `hookBarMajor` NDJSON message carries all N symbols' `onBarClose` increments for one bar; the universe harness dispatches to the N resident per-symbol instances (sequential, index order) and returns a tagged per-entry response; the host applies the N results via the unchanged `processBar`. `runBarMajor` runs a 3-phase batched inner loop (`preBarStages` all → one batched hook → `processBar` all) behind `BACKTESTER_BAR_MAJOR_BATCH`. Byte-identity holds because Slice A's per-symbol portfolios/accs are independent.

**Tech Stack:** TypeScript (engine/host), JavaScript ESM (`.mjs` harness), Vitest, NDJSON IPC over child stdio.

## Global Constraints

- Sub-flag `BACKTESTER_BAR_MAJOR_BATCH` default **OFF**. Engages ONLY when `barMajor && universe && sandbox && N>1`; degrades to the per-symbol loop (byte-identical) otherwise.
- Batches **`onBarClose` only**. `processBar` and its internal `onPositionBar` lockstep call are **unchanged**.
- Byte-identical to Slice A: batched result_hash == the frozen Slice A golden `sha256:9da2192a...` (the exact frozen value lives in `apps/backtester/test/bar-major-golden.test.ts` as `BAR_MAJOR_GOLDEN` — read it, don't retype it).
- Response is **tagged per-entry**: `{ t:'okBarMajor', seq, results: Array<{ok:true,decisions}|{ok:false,error}> }`. `results.length` MUST equal `bars.length` and each entry MUST be exactly one tagged variant, else the host treats it as a **channel-level malformed → session-fatal**.
- Per-symbol strategy exception (harness caught it, container alive) → that entry is `{ok:false,error}` → maps to the **same HookResult/SessionError path as `callHook`'s harness-level `err` for that symbol** (same `failedSymbols` latch, same downstream). Other symbols continue.
- Channel-level failure on the `hookBarMajor` round-trip (malformed / eof / timeout / overflow) → **whole-session fatal** (`this.fail(...)`), same as the lockstep `hook`/`hookBatch` paths.
- Harness dispatch is **sequential `for`, NEVER `Promise.all`** — deterministic index-order side effects; the perf win is the IPC round-trip, not parallel JS.
- `ipc_profile`: `hookCalls` stays **logical** (credited `+= healthy count`); add a distinct `barMajorBatches` counter (increments ONLY in `callHookBarMajor`, one per round-trip — NOT `ipcMessages`, which would imply all IPC receive paths count it). The collapse is in IPC round-trips, not logical hook executions.

Spec: `docs/superpowers/specs/2026-07-12-bar-major-transport-collapse-design.md`.

Key existing code to mirror (READ before writing):
- `apps/backtester/src/engine/sandbox/ipc.ts` — `HookBatchRequest`, `HookBatchEntry`, `ReceiveOutcome`.
- `apps/backtester/src/engine/sandbox/async-ipc-channel.ts:~114` — the `okBatch` parse branch.
- `apps/backtester/src/engine/sandbox/sandbox-session.ts` — `callHook` (per-symbol err→latch), `callHookBatch` (send/receive/finish), `buildHookPayload`, the `profOpenMs`/`profHookCalls`/`profInitCalls` counters + `close()` emit.
- `apps/backtester/src/engine/sandbox/sandbox-executor.ts` — `executeStrategyHook`, `executeStrategyHookBatch`, `sessionFor`.
- `apps/backtester/sandbox-harness-overlay/entry.mjs` — `handleHook`, `handleHookBatch`, `main` dispatch, `ok`/`err`/`okBatch` reply helpers; `universe-instances.mjs` (`makeInstanceStore`, `symbolOf`); `hook-batch.mjs` (`runHookBatch` pure helper pattern).
- `apps/backtester/src/engine/runner.ts` — `runBarMajor` (Slice A interleave, ~line 690), `RunDeps`, `simulateTarget`.

---

### Task 1: Wire types + host-side `okBarMajor` parse (with validation)

**Files:**
- Modify: `apps/backtester/src/engine/sandbox/ipc.ts`
- Modify: `apps/backtester/src/engine/sandbox/async-ipc-channel.ts` (the `parse`/receive function containing the `rec.t === 'okBatch'` branch, ~line 100-135)
- Test: `apps/backtester/test/async-ipc-bar-major-parse.test.ts`

**Interfaces:**
- Produces: `HookBarMajorRequest`; `ReceiveOutcome` gains a `okBarMajor` variant with `results: readonly ({readonly ok:true; readonly decisions: readonly unknown[]} | {readonly ok:false; readonly error:{readonly code:string; readonly detail:string}})[]`.

- [ ] **Step 1: Add the wire types**

In `ipc.ts`, after `HookBatchRequest`:

```typescript
/** hookBarMajor-конверт (host → harness; Slice B): один конверт на бар, по одному entry на КАЖДЫЙ
 *  символ того же бара (bars[i] = HookBatchEntry для символа i в порядке request.symbols). */
export interface HookBarMajorRequest {
  readonly t: 'hookBarMajor';
  readonly seq: number;
  readonly hook: 'onBarClose';
  readonly bars: readonly HookBatchEntry[];
}
```

Extend the `Request` union: `export type Request = InitRequest | HookRequest | HookBatchRequest | HookBarMajorRequest;`

In `ReceiveOutcome`, add a variant (alongside `okBatch`):

```typescript
  | {
      readonly kind: 'okBarMajor';
      readonly seq?: number;
      readonly results: readonly (
        | { readonly ok: true; readonly decisions: readonly unknown[] }
        | { readonly ok: false; readonly error: { readonly code: string; readonly detail: string } }
      )[];
    }
```

- [ ] **Step 2: Write the failing parse test**

```typescript
// apps/backtester/test/async-ipc-bar-major-parse.test.ts
import { describe, expect, it } from 'vitest';
import { parseResponseLine } from '../src/engine/sandbox/async-ipc-channel.js';

describe('okBarMajor response parse', () => {
  it('parses a well-formed tagged per-entry okBarMajor', () => {
    const line = JSON.stringify({ t: 'okBarMajor', seq: 5, results: [
      { ok: true, decisions: ['SIG'] },
      { ok: false, error: { code: 'sandbox_crashed', detail: 'boom' } },
    ]});
    expect(parseResponseLine(line)).toEqual({
      kind: 'okBarMajor', seq: 5, results: [
        { ok: true, decisions: ['SIG'] },
        { ok: false, error: { code: 'sandbox_crashed', detail: 'boom' } },
      ],
    });
  });

  it('rejects results that is not an array → malformed', () => {
    expect(parseResponseLine(JSON.stringify({ t: 'okBarMajor', seq: 1, results: 'x' })).kind).toBe('malformed');
  });

  it('rejects an entry that is neither a valid ok nor a valid err variant → malformed', () => {
    expect(parseResponseLine(JSON.stringify({ t: 'okBarMajor', seq: 1, results: [{ ok: true }] })).kind).toBe('malformed');
    expect(parseResponseLine(JSON.stringify({ t: 'okBarMajor', seq: 1, results: [{ nope: 1 }] })).kind).toBe('malformed');
  });

  it('rejects a false entry whose error lacks string code/detail → malformed (no defaulting)', () => {
    expect(parseResponseLine(JSON.stringify({ t: 'okBarMajor', seq: 1, results: [{ ok: false, error: { code: 'x' } }] })).kind).toBe('malformed');
    expect(parseResponseLine(JSON.stringify({ t: 'okBarMajor', seq: 1, results: [{ ok: false, error: {} }] })).kind).toBe('malformed');
    expect(parseResponseLine(JSON.stringify({ t: 'okBarMajor', seq: 1, results: [{ ok: false }] })).kind).toBe('malformed');
  });
});
```

Note: confirm the real name of the exported parse function in `async-ipc-channel.ts` (the one with the `rec.t === 'okBatch'` branch); if it is not exported or is named differently, export it / adjust the import. If it is a private method, add a thin exported `parseResponseLine(line: string): ReceiveOutcome` wrapper around the existing logic and route the internal caller through it.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run apps/backtester/test/async-ipc-bar-major-parse.test.ts`
Expected: FAIL (no `okBarMajor` branch / import missing).

- [ ] **Step 4: Add the parse branch**

In `async-ipc-channel.ts`, after the `rec.t === 'okBatch'` branch, add (mirror its shape, but validate the tagged array — this validation is load-bearing per the Global Constraints):

```typescript
    if (rec.t === 'okBarMajor') {
      if (!Array.isArray(rec.results)) {
        return { kind: 'malformed', detail: 'okBarMajor response missing results array' };
      }
      const results: ({ ok: true; decisions: unknown[] } | { ok: false; error: { code: string; detail: string } })[] = [];
      for (const raw of rec.results as unknown[]) {
        if (typeof raw !== 'object' || raw === null) {
          return { kind: 'malformed', detail: 'okBarMajor result entry is not an object' };
        }
        const e = raw as Record<string, unknown>;
        const err = e.error as Record<string, unknown> | undefined;
        if (e.ok === true && Array.isArray(e.decisions)) {
          results.push({ ok: true, decisions: e.decisions as unknown[] });
        } else if (
          e.ok === false && typeof e.error === 'object' && e.error !== null &&
          typeof err!.code === 'string' && typeof err!.detail === 'string'
        ) {
          // STRICT: a false entry is valid ONLY with string code AND string detail — no defaulting, so a
          // harness/protocol bug can't be silently laundered into a normal per-symbol error.
          results.push({ ok: false, error: { code: err!.code as string, detail: err!.detail as string } });
        } else {
          return { kind: 'malformed', detail: 'okBarMajor result entry is not a valid tagged ok/err variant' };
        }
      }
      return { kind: 'okBarMajor', seq: typeof rec.seq === 'number' ? rec.seq : undefined, results };
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run apps/backtester/test/async-ipc-bar-major-parse.test.ts` → PASS. Then `npx tsc --noEmit -p tsconfig.json` → clean.

- [ ] **Step 6: Commit**

```bash
git add apps/backtester/src/engine/sandbox/ipc.ts apps/backtester/src/engine/sandbox/async-ipc-channel.ts apps/backtester/test/async-ipc-bar-major-parse.test.ts
git commit -m "feat(ipc): hookBarMajor request type + tagged okBarMajor parse (Slice B)"
```

---

### Task 2: `SandboxSession.callHookBarMajor` + `ipcMessages` profile counter

**Files:**
- Modify: `apps/backtester/src/engine/sandbox/sandbox-session.ts`
- Test: `apps/backtester/test/sandbox-session-bar-major.test.ts`

**Interfaces:**
- Consumes: `HookBarMajorRequest`, `ReceiveOutcome.okBarMajor` (Task 1); existing `buildHookPayload`, `ensureSymbolInit`, `mapFailure`, `fail`, `failedSymbols`.
- Produces: `async callHookBarMajor(ctxs: readonly StrategyContext[]): Promise<readonly HookResult[]>` — one `HookResult` per ctx, index-aligned.

- [ ] **Step 1: Write the failing test (scripted driver — mirror `sandbox-session-batch.test.ts` harness)**

```typescript
// apps/backtester/test/sandbox-session-bar-major.test.ts
// Reuse the ScriptedDriver / RecordingWritable / bundle / makeCtx harness pattern from
// sandbox-session-universe.test.ts (universe cfg). Drive a universe session's callHookBarMajor.
import { describe, expect, it } from 'vitest';
// ... imports + ScriptedDriver harness copied from sandbox-session-universe.test.ts, cfg.universe=true ...

describe('SandboxSession.callHookBarMajor', () => {
  it('maps a tagged okBarMajor to per-ctx HookResults (ok + per-symbol error)', async () => {
    // 2 symbols AAA,BBB. Script: init replies for each symbol's first-seen (ensureSymbolInit), then
    // ONE okBarMajor reply with results [{ok:true,decisions:['SIG']},{ok:false,error:{...}}].
    // Assert callHookBarMajor([ctxAAA, ctxBBB]) resolves to
    //   [ {ok:true, decisions:['SIG']}, {ok:false, decisions:[], error:<SessionError>} ]
    // and that BBB is latched (a subsequent callHook('onBarClose', ctxBBB) fails closed WITHOUT sending).
  });

  it('a results-length mismatch is session-fatal (fail), not a per-symbol latch', async () => {
    // Script okBarMajor with results.length=1 for a 2-ctx call → the whole call fails (session dead);
    // a subsequent call returns the session error.
  });

  it('sends exactly ONE hookBarMajor envelope carrying N entries', async () => {
    // Assert driver.sent has exactly one {t:'hookBarMajor'} with bars.length===2 for a 2-ctx call
    // (after the per-symbol init handshakes).
  });

  it('a latched symbol is NOT re-sent; only the healthy symbol appears in bars (index remap)', async () => {
    // 1) First call: script BBB's result as {ok:false,error} → BBB is latched.
    // 2) Second callHookBarMajor([ctxAAA, ctxBBB]): assert the SECOND {t:'hookBarMajor'} envelope's
    //    bars has length 1 and its only entry's snapshot.symbol === 'AAA' (BBB not re-sent);
    //    the returned HookResult[] is length 2 with out[1] = BBB's prior fail-closed error (remapped
    //    to its original index) and out[0] = AAA's ok result. Mirrors lockstep callHook's
    //    fail-closed-without-send for a latched symbol.
  });
});
```

Fill in the harness by copying `sandbox-session-universe.test.ts`'s `ScriptedDriver`/`RecordingWritable`/`bundle`/`makeCtx` verbatim (universe cfg). Script replies by writing NDJSON lines to `driver.stdout` in response order, exactly as that file does.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run apps/backtester/test/sandbox-session-bar-major.test.ts`
Expected: FAIL (`callHookBarMajor` not defined).

- [ ] **Step 3: Implement `callHookBarMajor`**

Model on `callHookBatch` (same open/ensureSymbolInit guards, same profiling shape). Add near `callHookBatch`:

```typescript
  /**
   * Slice B: one IPC round-trip carrying all N symbols' onBarClose increments. Returns one HookResult
   * per ctx (index-aligned). Per-symbol harness error → that symbol's HookResult is fail-closed AND
   * latched (same path as callHook's universe err branch). A malformed/short response or channel death
   * is session-fatal.
   */
  async callHookBarMajor(ctxs: readonly StrategyContext[]): Promise<readonly HookResult[]> {
    if (this.failed) return ctxs.map(() => ({ ok: false, decisions: [], error: this.lastError }));
    // Latched symbols (universe per-symbol fail-closed) must NOT be re-sent — mirror callHook's early
    // fail-closed-WITHOUT-send. Partition into healthy (sent) and latched (resolved locally from the
    // prior error), send only healthy, then remap results back to the original ctx indices.
    const out: HookResult[] = new Array(ctxs.length);
    const healthy: { ctx: StrategyContext; idx: number }[] = [];
    for (let i = 0; i < ctxs.length; i += 1) {
      const prior = this.failedSymbols.get(ctxs[i]!.symbol);
      if (prior !== undefined) out[i] = { ok: false, decisions: [], error: prior };
      else healthy.push({ ctx: ctxs[i]!, idx: i });
    }
    if (healthy.length === 0) return out; // all latched → no IPC send, no counter increments

    const failHealthy = (error: SessionError | undefined): readonly HookResult[] => {
      for (const h of healthy) out[h.idx] = { ok: false, decisions: [], error };
      return out;
    };
    if (this.channel === undefined) {
      const opened = await this.open();
      if (!opened.ok) return failHealthy(this.lastError);
    }
    // Per-symbol lazy init handshakes (universe): one per not-yet-initialized HEALTHY symbol, in order.
    for (const h of healthy) {
      const f = await this.ensureSymbolInit(h.ctx);
      if (f !== undefined) return failHealthy(this.lastError);
    }
    const channel = this.channel;
    if (channel === undefined) return failHealthy(this.lastError);

    const bars = healthy.map((h) => this.buildHookPayload(h.ctx)); // only healthy symbols' bookkeeping advances
    this.seq += 1;
    channel.send({ t: 'hookBarMajor', seq: this.seq, hook: 'onBarClose', bars });

    const profT0 = SandboxSession.profileEnabled ? performance.now() : 0;
    const outcome = await channel.receive(this.callDeadline());
    if (SandboxSession.profileEnabled) {
      this.profIpcWaitMs += performance.now() - profT0;
      this.profHookCalls += healthy.length;   // logical hooks actually executed (latched excluded → parity with lockstep)
      this.profBarMajorBatches += 1;          // one hookBarMajor round-trip (the collapse)
    }

    if (outcome.kind !== 'okBarMajor') {
      // channel death (eof/timeout/overflow/malformed/wrong-kind) → session-fatal
      const error = this.mapFailure(outcome, 'onBarClose', 'sandbox_crashed');
      this.fail(error);
      return failHealthy(error);
    }
    if (outcome.results.length !== healthy.length) {
      const error = this.mapFailure(
        { kind: 'malformed', detail: `okBarMajor results length ${outcome.results.length} != ${healthy.length}` },
        'onBarClose', 'sandbox_crashed',
      );
      this.fail(error);
      return failHealthy(error);
    }
    for (let j = 0; j < healthy.length; j += 1) {
      const r = outcome.results[j]!;
      const h = healthy[j]!;
      if (r.ok) { out[h.idx] = { ok: true, decisions: r.decisions }; continue; }
      // per-symbol soft failure: latch THIS symbol (mirror callHook's universe err branch), keep session.
      const error = this.mapFailure({ kind: 'err', code: r.error.code, detail: r.error.detail }, 'onBarClose', 'sandbox_crashed');
      this.failedSymbols.set(h.ctx.symbol, error);
      out[h.idx] = { ok: false, decisions: [], error };
    }
    return out;
  }
```

Add the profile field near `profInitCalls`: `private profInitCalls = 0;` → add `private profBarMajorBatches = 0;`. In `close()`'s emitted object add `barMajorBatches: this.profBarMajorBatches,`. (Named `barMajorBatches`, NOT `ipcMessages`: it increments ONLY in `callHookBarMajor`, so it counts hookBarMajor round-trips, not all IPC receives — `hookCalls` stays the logical count.)

Note: confirm `mapFailure`'s accepted `outcome` shapes — reuse exactly the shapes `callHook`/`callHookBatch` pass it; if `mapFailure` needs a specific `err` object shape, match it (the `{ kind:'err', code, detail }` above must match what `mapFailure` reads — adjust to the real signature while implementing).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run apps/backtester/test/sandbox-session-bar-major.test.ts` → PASS. `npx tsc --noEmit -p tsconfig.json` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/engine/sandbox/sandbox-session.ts apps/backtester/test/sandbox-session-bar-major.test.ts
git commit -m "feat(sandbox): SandboxSession.callHookBarMajor + ipcMessages profile counter (Slice B)"
```

---

### Task 3: Harness `hookBarMajor` dispatch (pure helper + wiring)

**Files:**
- Create: `apps/backtester/sandbox-harness-overlay/hook-bar-major.mjs` (pure, importable/testable — mirrors `hook-batch.mjs`)
- Modify: `apps/backtester/sandbox-harness-overlay/entry.mjs` (add `handleHookBarMajor` + `okBarMajor` reply helper + `main` dispatch branch)
- Test: `apps/backtester/test/hook-bar-major.test.ts`

**Interfaces:**
- Produces: `runHookBarMajor(bars, hook, store, deps): { results: Array<{ok:true,decisions}|{ok:false,error:{code,detail}}> }` — sequential, index order.

- [ ] **Step 1: Write the failing test for the pure helper**

```typescript
// apps/backtester/test/hook-bar-major.test.ts
import { describe, expect, it } from 'vitest';
import { runHookBarMajor } from '../sandbox-harness-overlay/hook-bar-major.mjs';

function fakeStore(map) { return { get: (s) => map.get(s) }; }
const rehydrateContext = (snap) => ({ symbol: snap.symbol });
const normalize = (out) => (Array.isArray(out) ? out : out == null ? [] : [out]);
const pickHook = (inst) => inst.onBarClose;

describe('runHookBarMajor (sequential, index order, per-symbol fail-closed)', () => {
  it('runs each symbol in index order and returns tagged results', () => {
    const calls = [];
    const store = fakeStore(new Map([
      ['AAA', { instance: { onBarClose: () => { calls.push('AAA'); return ['SIG']; } }, buffer: [], oiBuffer: [], liqBuffer: [] }],
      ['BBB', { instance: { onBarClose: () => { calls.push('BBB'); throw new Error('boom'); } }, buffer: [], oiBuffer: [], liqBuffer: [] }],
    ]));
    const bars = [
      { snapshot: { symbol: 'AAA' }, newBar: null },
      { snapshot: { symbol: 'BBB' }, newBar: null },
    ];
    const r = runHookBarMajor(bars, 'onBarClose', store, { rehydrateContext, normalize, pickHook });
    expect(calls).toEqual(['AAA', 'BBB']);                       // sequential, index order
    expect(r.results[0]).toEqual({ ok: true, decisions: ['SIG'] });
    expect(r.results[1].ok).toBe(false);                        // BBB threw → tagged error, others ran
    expect(r.results[1].error.detail).toContain('boom');
  });

  it('a missing slot for an entry yields a tagged error for that entry only', () => {
    const store = fakeStore(new Map([['AAA', { instance: { onBarClose: () => [] }, buffer: [], oiBuffer: [], liqBuffer: [] }]]));
    const bars = [{ snapshot: { symbol: 'AAA' }, newBar: null }, { snapshot: { symbol: 'ZZZ' }, newBar: null }];
    const r = runHookBarMajor(bars, 'onBarClose', store, { rehydrateContext, normalize, pickHook });
    expect(r.results[0].ok).toBe(true);
    expect(r.results[1].ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run apps/backtester/test/hook-bar-major.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement the pure helper**

```javascript
// apps/backtester/sandbox-harness-overlay/hook-bar-major.mjs
// Slice B: run onBarClose for N symbols of the SAME bar, SEQUENTIALLY in index order (NEVER
// Promise.all — deterministic side effects; the perf win is the IPC round-trip, not parallel JS).
// Each entry is caught independently: one symbol throwing fails-closed ONLY that symbol.
export function runHookBarMajor(bars, hook, store, { rehydrateContext, normalize, pickHook }) {
  const results = [];
  for (const entry of bars) {
    const symbol = entry.snapshot && entry.snapshot.symbol;
    const slot = store.get(symbol);
    if (slot === undefined) {
      results.push({ ok: false, error: { code: 'sandbox_output_malformed', detail: `hookBarMajor before init for symbol ${String(symbol)}` } });
      continue;
    }
    try {
      if (entry.newBar !== null && entry.newBar !== undefined) slot.buffer.push(entry.newBar);
      if (entry.newOi !== undefined) slot.oiBuffer.push(entry.newOi);
      if (entry.newLiq !== undefined) slot.liqBuffer.push(entry.newLiq);
      const ctx = rehydrateContext(entry.snapshot, slot.buffer, slot.rng, slot.oiBuffer, slot.liqBuffer);
      const fn = pickHook(slot.instance, hook);
      if (fn === undefined) { results.push({ ok: true, decisions: [] }); continue; }
      const out = fn.call(slot.instance, ctx);
      results.push({ ok: true, decisions: normalize(out) });
    } catch (e) {
      results.push({ ok: false, error: { code: classifyOrCrashed(e), detail: e && e.message ? e.message : String(e) } });
    }
  }
  return { results };
}

// The harness passes its real classifyError via deps if it wants deny-shim codes; the pure helper
// falls back to sandbox_crashed so it stays importable from the host test without the deny-shim module.
function classifyOrCrashed(_e) { return 'sandbox_crashed'; }
```

Note: `onBarClose` is synchronous in the strategy contract; `runHookBatch` (the 17b sibling) is likewise synchronous per entry. Keep `runHookBarMajor` synchronous (no `await`) to match — if the real strategy hooks can be async, mirror exactly what `hook-batch.mjs` does (await per entry inside the sequential loop) — READ `hook-batch.mjs` and match its sync/async shape and its `classifyError` deps wiring.

- [ ] **Step 4: Wire `handleHookBarMajor` + reply helper + dispatch in entry.mjs**

Add an `okBarMajor` reply helper next to `ok`/`okBatch` (mirror how `okBatch` writes a line):

```javascript
function okBarMajor(seq, results) { write({ t: 'okBarMajor', seq, results }); } // use the same stdout writer ok()/okBatch() use
```

Add the handler (mirror `handleHookBatch`'s slot-guard + try/catch shape, but the per-entry guard lives inside `runHookBarMajor`, so the outer guard is only for a total escape):

```javascript
async function handleHookBarMajor(msg) {
  try {
    const r = runHookBarMajor(msg.bars, msg.hook, store, {
      rehydrateContext,
      normalize,
      pickHook: (inst, h) => pickHookFor(inst, h),
    });
    okBarMajor(msg.seq, r.results);
  } catch (e) {
    // A total escape (not a per-entry throw, which runHookBarMajor already caught) → coded error line.
    err(msg.seq, msg.hook, classifyError(e), e && e.message ? e.message : e);
  }
}
```

In `main`, add the dispatch branch after `hookBatch`:

```javascript
    } else if (msg.t === 'hookBarMajor') {
      await handleHookBarMajor(msg);
```

Match the exact writer/`classifyError`/`pickHookFor` names already in `entry.mjs`. If a second harness (`apps/backtester/sandbox-harness/entry.mjs`) is also used for strategy universe runs, add the same branch there; otherwise leave it (confirm which harness the overlay build mounts — the overlay one is the universe/strategy harness).

- [ ] **Step 5: Run to verify pure-helper test passes; rebuild harness overlay if the build step applies**

Run: `npx vitest run apps/backtester/test/hook-bar-major.test.ts` → PASS.
If the harness overlay is a built artifact, run the overlay build so entry.mjs changes are picked up: `pnpm run build:sandbox-harness-overlay` (this also runs in `pretest`).

- [ ] **Step 6: Commit**

```bash
git add apps/backtester/sandbox-harness-overlay/hook-bar-major.mjs apps/backtester/sandbox-harness-overlay/entry.mjs apps/backtester/test/hook-bar-major.test.ts
git commit -m "feat(harness): hookBarMajor sequential per-symbol dispatch (Slice B)"
```

---

### Task 4: `executeStrategyHookBarMajor` executor method (sandbox route + trusted loop)

**Files:**
- Modify: `apps/backtester/src/engine/sandbox/sandbox-executor.ts` (`SandboxModuleExecutor`)
- Modify: the trusted executor (`apps/backtester/src/engine/module-executor.ts`, `InProcessTrustedModuleExecutor`) + the `ModuleExecutor` interface it implements
- Test: `apps/backtester/test/sandbox-executor-bar-major.test.ts`

**Interfaces:**
- Consumes: `SandboxSession.callHookBarMajor` (Task 2); existing `sessionFor`, `revalidator`, `record`, `executeStrategyHook`.
- Produces: `executeStrategyHookBarMajor(items: readonly {module: StrategyModule; ctx: StrategyContext}[]): Promise<readonly StrategyDecision[]>` — one base decision per item (index-aligned; a failed/latched symbol yields `[]`→ caller's `firstDecision([])` = idle).

- [ ] **Step 1: Write the failing test**

```typescript
// apps/backtester/test/sandbox-executor-bar-major.test.ts
// Reuse the ScriptedDriver universe harness from sandbox-executor-universe.test.ts.
// 1. universe (Docker-free scripted): executeStrategyHookBarMajor sends ONE hookBarMajor; a per-symbol
//    error result is recorded (executor.errors has the symbol) and that item's decisions are [].
// 2. trusted degradation: with a trusted router, executeStrategyHookBarMajor([{module,ctxA},{module,ctxB}])
//    returns the same decisions as looping executeStrategyHook per item (byte-identical), NO batch call.
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run apps/backtester/test/sandbox-executor-bar-major.test.ts`
Expected: FAIL (method missing).

- [ ] **Step 3: Implement**

Add to the `ModuleExecutor` interface: `executeStrategyHookBarMajor(items: readonly { module: StrategyModule; ctx: StrategyContext }[]): Promise<readonly StrategyDecision[]>;` (optional `?` if the interface prefers optional capabilities — but the runner will require it, so make it required and implement in both executors).

In `SandboxModuleExecutor` (mirror `executeStrategyHookBatch`'s revalidate + record shape):

```typescript
  async executeStrategyHookBarMajor(
    items: readonly { module: StrategyModule; ctx: StrategyContext }[],
  ): Promise<readonly StrategyDecision[]> {
    if (items.length === 0) return [];
    if (this.universe?.enabled === true) {
      const session = this.sessionFor(items[0]!.ctx); // universe → one shared session
      const results = await session.callHookBarMajor(items.map((it) => it.ctx));
      return results.map((r, i) => {
        if (!r.ok) {
          if (r.error !== undefined) this.record(r.error, items[i]!.ctx);
          return { kind: 'idle' } as StrategyDecision; // fail-closed base (== firstDecision([]))
        }
        const rv = this.revalidator.revalidateStrategy(r.decisions);
        if (!rv.ok) {
          this.record({ code: 'decision_schema_invalid', detail: rv.message, hook: 'onBarClose' }, items[i]!.ctx);
          return { kind: 'idle' } as StrategyDecision;
        }
        return rv.decisions.length > 0 ? rv.decisions[0]! : ({ kind: 'idle' } as StrategyDecision);
      });
    }
    // non-universe sandbox → no batch collapse possible (per-symbol sessions); loop lockstep.
    const out: StrategyDecision[] = [];
    for (const it of items) out.push(firstDecisionOf(await this.executeStrategyHook(it.module, 'onBarClose', it.ctx)));
    return out;
  }
```

`firstDecisionOf` = the same "first or idle" reduction the runner's `firstDecision` uses; reuse/import it or inline `ds.length > 0 ? ds[0] : { kind:'idle' }`. Confirm `StrategyDecision` idle shape matches `firstDecision`'s fallback in `runner.ts` exactly.

In `InProcessTrustedModuleExecutor`: loop `executeStrategyHook` per item (byte-identical degradation):

```typescript
  async executeStrategyHookBarMajor(items) {
    const out = [];
    for (const it of items) out.push(firstDecisionOf(await this.executeStrategyHook(it.module, 'onBarClose', it.ctx)));
    return out;
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run apps/backtester/test/sandbox-executor-bar-major.test.ts` → PASS. `npx tsc --noEmit -p tsconfig.json` → clean (all `ModuleExecutor` implementors satisfy the new method).

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/engine/sandbox/sandbox-executor.ts apps/backtester/src/engine/module-executor.ts apps/backtester/test/sandbox-executor-bar-major.test.ts
git commit -m "feat(engine): executeStrategyHookBarMajor executor (sandbox batch + trusted loop) (Slice B)"
```

---

### Task 5: `runBarMajor` 3-phase batched loop behind the flag

**Files:**
- Modify: `apps/backtester/src/engine/runner.ts` (`runBarMajor` ~line 690; `RunDeps`; `simulateTarget` branch + call sites in `runBacktest`)
- Test: `apps/backtester/test/bar-major-batch-equiv.test.ts`

**Interfaces:**
- Consumes: `executeStrategyHookBarMajor` (Task 4); existing `preBarStages`, `processBar`, `stateAt`, `firstDecision`.
- Produces: `RunDeps.barMajorBatch?: boolean`; `runBarMajor` gains a `barMajorBatch: boolean` param.

- [ ] **Step 1: Write the failing test (byte-identity of the 3-phase reorder, Docker-free via trusted degradation)**

```typescript
// apps/backtester/test/bar-major-batch-equiv.test.ts
// Reuse the trusted multi-symbol fixture from bar-major-runner.test.ts (helpers/bar-major-fixture).
import { describe, expect, it } from 'vitest';
import { runBacktest } from '../src/engine/runner.js';
import { makeMultiSymbolDeps, makeRequest, resultHash } from './helpers/bar-major-fixture.js';

describe('bar-major batch 3-phase reorder is byte-identical to Slice A interleave', () => {
  it('trusted: barMajor + barMajorBatch ON == barMajor (batch OFF) result_hash (N=2)', async () => {
    const req = makeRequest(['BTCUSDT', 'ETHUSDT']);
    const interleave = await runBacktest(req, makeMultiSymbolDeps({ barMajor: true }));
    const batched = await runBacktest(req, makeMultiSymbolDeps({ barMajor: true, barMajorBatch: true }));
    expect(resultHash(batched)).toBe(resultHash(interleave));
  });
});
```

(Trusted `executeStrategyHookBarMajor` degrades to the per-symbol loop, so this pins the RUNNER's 3-phase reorder byte-identity independent of the sandbox transport. The real transport collapse is proven under Docker in Task 7.)

Extend `makeMultiSymbolDeps` in `helpers/bar-major-fixture.ts` to thread an optional `barMajorBatch` into the `RunDeps` (mirror how it threads `barMajor`).

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run apps/backtester/test/bar-major-batch-equiv.test.ts`
Expected: FAIL (`barMajorBatch` not accepted / no batched path).

- [ ] **Step 3: Thread the flag + add the batched inner loop**

Add `readonly barMajorBatch?: boolean;` to `RunDeps`. Add a `barMajorBatch: boolean` param to `simulateTarget` (after `barMajor`) and to `runBarMajor` (after `marketTape`); pass `deps.barMajorBatch === true` at both `simulateTarget` call sites in `runBacktest`, and pass it into `runBarMajor` from the bar-major branch of `simulateTarget`.

Replace Phase 2's inner loop in `runBarMajor` with a flag branch. The batched branch (guardrail: `cursor[s] += 1` happens in the collection phase, matching the interleave's consume-on-every-bar including failures):

```typescript
    // Phase 2 — bar-major loop over the sorted union timeline; per-symbol cursor.
    const cursor = envs.map(() => 0);
    const tsSet = new Set<number>();
    for (const env of envs) for (const c of env.candles) tsSet.add(c.ts);
    const unionTs = [...tsSet].sort((a, b) => a - b);
    for (const ts of unionTs) {
      if (barMajorBatch) {
        // 3-phase: preBarStages+build for all present symbols → ONE batched onBarClose → processBar all.
        // Byte-identical to the interleave below: per-symbol portfolios/accs are independent, so the
        // cross-symbol reorder within a bar cannot change any symbol's result.
        const active: Array<{ env: BarEnv; t: number; ctx: StrategyContext }> = [];
        for (let s = 0; s < envs.length; s += 1) {
          const env = envs[s];
          const t = cursor[s];
          if (env.candles[t]?.ts !== ts) continue;
          preBarStages(env, t);
          active.push({ env, t, ctx: env.builder.build(t, stateAt(env.portfolio, env.candles[t].close)) });
          cursor[s] += 1;
        }
        if (active.length === 0) continue;
        const bases = await active[0]!.env.strategyExec.executeStrategyHookBarMajor(
          active.map((a) => ({ module: a.env.module, ctx: a.ctx })),
        );
        for (let i = 0; i < active.length; i += 1) await processBar(active[i]!.env, active[i]!.t, bases[i]!);
      } else {
        for (let s = 0; s < envs.length; s += 1) {   // Slice A interleave — unchanged
          const env = envs[s];
          const t = cursor[s];
          if (env.candles[t]?.ts !== ts) continue;
          preBarStages(env, t);
          const ctx = env.builder.build(t, stateAt(env.portfolio, env.candles[t].close));
          const base = firstDecision(await env.strategyExec.executeStrategyHook(env.module, 'onBarClose', ctx));
          await processBar(env, t, base);
          cursor[s] += 1;
        }
      }
    }
```

Note: `executeStrategyHookBarMajor` returns per-item base decisions already reduced to a single decision (not a decision list), so no `firstDecision` wrap is needed on `bases[i]` — confirm the return type from Task 4 matches (one `StrategyDecision` per item). All active envs share the SAME `strategyExec` (the executor is per-target, not per-symbol), so `active[0].env.strategyExec` is correct for all.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run apps/backtester/test/bar-major-batch-equiv.test.ts` → PASS. Full suite `npx vitest run apps/backtester/test/` → green. `npx tsc --noEmit -p tsconfig.json` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/engine/runner.ts apps/backtester/test/bar-major-batch-equiv.test.ts apps/backtester/test/helpers/bar-major-fixture.ts
git commit -m "feat(engine): runBarMajor 3-phase batched loop behind barMajorBatch (Slice B)"
```

---

### Task 6: `BACKTESTER_BAR_MAJOR_BATCH` flag chain (config → app → worker → RunDeps)

**Files:**
- Modify: `apps/backtester/src/config.ts` (`AppConfig` + `loadConfig`)
- Modify: `apps/backtester/src/app.ts` (`buildApp` worker deps)
- Modify: `apps/backtester/src/jobs/worker.ts` (`WorkerDeps` + `processNextQueued` fold)
- Modify: `apps/backtester/src/engine/run-strategy.ts` (`StrategyRunDeps` + `runStrategyBacktest` fold)
- Test: `apps/backtester/test/bar-major-batch-wiring.test.ts`

**Interfaces:**
- Consumes: `RunDeps.barMajorBatch` (Task 5).
- Produces: `AppConfig.barMajorBatch: boolean`; the full config→RunDeps chain.

- [ ] **Step 1: Write the failing test** — mirror `bar-major-wiring.test.ts` (Slice A) for `barMajorBatch`:

```typescript
// apps/backtester/test/bar-major-batch-wiring.test.ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('BACKTESTER_BAR_MAJOR_BATCH config + wiring', () => {
  it('defaults barMajorBatch to false', () => {
    expect(loadConfig(/* env shape per loadConfig */ {}).barMajorBatch).toBe(false);
  });
  it('parses barMajorBatch=true', () => {
    expect(loadConfig({ BACKTESTER_BAR_MAJOR_BATCH: 'true' }).barMajorBatch).toBe(true);
  });
  // + a flow assertion mirroring bar-major-wiring.test.ts: config barMajorBatch → RunDeps.barMajorBatch.
});
```

Adjust the `loadConfig(...)` call to the real signature (as Slice A's config test does).

- [ ] **Step 2: Run to verify it fails** → `npx vitest run apps/backtester/test/bar-major-batch-wiring.test.ts` → FAIL.

- [ ] **Step 3: Add the field + thread every hop** (mirror `barMajor` exactly):

- `config.ts`: `AppConfig.barMajorBatch: boolean;` + `barMajorBatch: env.BACKTESTER_BAR_MAJOR_BATCH === 'true',` in `loadConfig`. (No mutual-exclusion needed — batch is a pure sub-mode of bar-major; it is simply inert unless `barMajor` is also on, enforced by the runner engaging it only inside `runBarMajor`.)
- `app.ts` `buildApp`: add `barMajorBatch: config.barMajorBatch,` next to `barMajor: config.barMajor,`.
- `worker.ts`: `WorkerDeps.barMajorBatch?: boolean;` + `...(deps.barMajorBatch === true ? { barMajorBatch: true } : {}),` next to the `barMajor` fold in `processNextQueued`.
- `run-strategy.ts`: `StrategyRunDeps.barMajorBatch?: boolean;` + `...(deps.barMajorBatch ? { barMajorBatch: true } : {}),` next to the `barMajor` fold in `runStrategyBacktest`.
- Also add `barMajorBatch: false,` to the `AppConfig` test-helper literal in `apps/backtester/test/helpers.ts` (next to `barMajor: false,`) so `tsc` stays clean.

- [ ] **Step 4: Run to verify it passes** → focused test PASS; `npx tsc --noEmit -p tsconfig.json` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/config.ts apps/backtester/src/app.ts apps/backtester/src/jobs/worker.ts apps/backtester/src/engine/run-strategy.ts apps/backtester/test/helpers.ts apps/backtester/test/bar-major-batch-wiring.test.ts
git commit -m "feat: wire BACKTESTER_BAR_MAJOR_BATCH from config into RunDeps (Slice B)"
```

---

### Task 7: Docker golden + wire/fail-closed/channel-fatal/ipc_profile tests

**Files:**
- Test: `apps/backtester/test/bar-major-batch-golden.test.ts` (Docker-gated)
- Test: extend `apps/backtester/test/sandbox-session-bar-major.test.ts` (channel-fatal + fail-closed already partly in Task 2 — add the ipc_profile assertion) and add a flag-off/on wire test.

**Interfaces:** Consumes everything above.

- [ ] **Step 1: Docker golden — batch ON == Slice A frozen golden**

Model on `apps/backtester/test/bar-major-golden.test.ts` (the Slice A twin/golden test). Add a `describe.skipIf(!DOCKER_AVAILABLE)` case: run the SAME universe fixture (short_after_pump + `universe-multi.json`, 3 symbols) through the sandbox path with `barMajor:true, barMajorBatch:true`, and assert its `result_hash` equals the frozen Slice A golden constant `BAR_MAJOR_GOLDEN` (import/read it from `bar-major-golden.test.ts` — do NOT retype the sha) AND equals the trusted `barMajor` hash. Assert `router.errors()` is empty before comparing. Runs on Docker; skips cleanly otherwise (report skip honestly).

```typescript
// key assertions
expect(resultHash(sandboxBatched)).toBe(BAR_MAJOR_GOLDEN);      // batch ON == Slice A golden
expect(resultHash(sandboxBatched)).toBe(resultHash(trustedBarMajor));
```

- [ ] **Step 2: Wire tests (channel-spy, Docker-free via ScriptedDriver)**

Add to the session test file:
- flag context OFF-equivalent: driving `callHook` per symbol (Slice A interleave) sends ZERO `{t:'hookBarMajor'}` envelopes.
- flag ON: `callHookBarMajor([ctxA,ctxB])` sends EXACTLY ONE `{t:'hookBarMajor'}` envelope with `bars.length===2` (the falsifiable round-trip-collapse proof).

- [ ] **Step 3: Per-symbol fail-closed vs channel-fatal (guardrails 1 & 2)**

- fail-closed: an `okBarMajor` with one `{ok:false,error}` entry → that symbol's HookResult is fail-closed and latched; the other symbol's HookResult is `{ok:true}`; the session stays alive (a follow-up call on the healthy symbol still works). (Guardrail 1: the failed symbol's bar is consumed exactly as the lockstep path consumes it — assert a subsequent bar for the latched symbol fails closed without a new send.)
- channel-fatal: a short `okBarMajor` (`results.length < bars.length`) or a non-`okBarMajor` reply → the whole call fails (session dead), NOT a per-symbol latch. (Guardrail 2.)

(These largely land in Task 2's test file; ensure all four are present and passing.)

- [ ] **Step 4: ipc_profile assertion**

With `BACKTESTER_IPC_PROFILE=true` (dynamic-import pattern from `sandbox-session-universe-profile.test.ts`), after a batched multi-bar run the emitted `ipc_profile` line has `barMajorBatches` == bar count and `hookCalls` == N × bar count (logical unchanged) — proving the collapse is in round-trips, not logical executions.

- [ ] **Step 5: Run + commit**

Run: `npx vitest run apps/backtester/test/bar-major-batch-golden.test.ts apps/backtester/test/sandbox-session-bar-major.test.ts` → PASS (golden runs on Docker or skips honestly). Full suite green; `tsc` clean.

```bash
git add apps/backtester/test/bar-major-batch-golden.test.ts apps/backtester/test/sandbox-session-bar-major.test.ts
git commit -m "test(engine): bar-major batch golden + wire/fail-closed/channel-fatal/ipc_profile (Slice B)"
```

---

## Final verification

- [ ] Full suite: `npx vitest run apps/backtester/test/` — all green (Docker golden runs or skips honestly).
- [ ] Typecheck: `npx tsc --noEmit -p tsconfig.json` — clean.
- [ ] `BACKTESTER_BAR_MAJOR_BATCH` unset → zero `hookBarMajor` envelopes anywhere in the suite output (grep), and the Slice A goldens are unchanged (byte-identical default).
- [ ] Update `docs/ROADMAP.md` 17c/bar-major note: Slice B (transport collapse) shipped, default OFF, pending VPS measurement to enable. Commit.
