# Universe Session (17c) — container-collapse — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace one sandbox container per (module, symbol) with **one container per bundle hosting N per-symbol instances**, flag-gated and byte-identical, so top-300/400-symbol universes run on small hardware.

**Architecture:** The host keeps today's **symbol-major** execution order (`for (const symbol of request.symbols)`), so `result_hash` is byte-identical. Only the sandbox *transport* changes: `SandboxModuleExecutor` opens ONE `SandboxSession` per bundle (was per symbol); the session multiplexes N per-symbol instances over one container; per-symbol bar bookkeeping and the harness's instance/buffer state become keyed by symbol. A harness-level error stays per-symbol fail-closed (session survives); only a container death degrades all N. Behind `BACKTESTER_UNIVERSE_SESSION` (default OFF ⇒ today's per-symbol path unchanged).

**Tech Stack:** TypeScript, Node child_process/docker, vitest. Repo `trading-backtester` (`apps/backtester`). Design: `docs/superpowers/specs/2026-07-05-universe-session-design.md`.

## Global Constraints

- **Byte-identical.** Symbol-major order is NOT changed. `result_hash`/`contentRef` over the assembled `RunOutcome` is identical whether a run executes as N per-symbol containers (flag OFF) or one universe container (flag ON). This is the merge gate (Task 9).
- **Flag posture.** `BACKTESTER_UNIVERSE_SESSION` default **false**. Flag OFF ⇒ `sessionFor` per-symbol path byte-for-byte today's; no universe session constructed, no scaled policy, no naming change reachable.
- **No public/SDK contract change.** Do NOT edit `packages/sdk/src/contracts/**` or add breaking members. The `maxUniverseN` rejection MUST reuse an EXISTING `ValidationCode` (read the union in `@trading/research-contracts`; do not add a new member) — if no existing code fits, STOP and escalate rather than editing the contract.
- **No sandbox weakening.** Isolation params (network none, read-only rootfs, cap-drop ALL, no-new-privileges, non-root user, pids-limit) are unchanged. The security boundary stays bundle↔host; N same-bundle instances co-resident is already the trust model.
- **Cap = pre-execution validation, NOT HTTP submit.** The symbol-count check lives in `runBacktest`'s validation block (alongside the market-kind gate), returning a `rejected` `RunOutcome`. It is NOT added to `POST /v1/runs`.
- **Conservative defaults ship as-is:** `universeMaxN=64`, memory `base=128 MiB` / `k=8 MiB/symbol`, `perSymbolSessionMs=30_000`. VPS only tunes later.
- **Target harness:** `apps/backtester/sandbox-harness-overlay/` (the current per-bar engine harness — serves both strategy and overlay bundles). The legacy `apps/backtester/sandbox-harness/entry.mjs` (Slice-1 batch) is NOT on this path; do not modify it. Verify in Task 7 that production wiring (`SandboxExecutorDeps.harnessDir`) resolves to the overlay harness.
- **Commands.** Backtester tests: `pnpm test <pattern>` from repo root (root `test` = `vitest run`). With Docker+Pg: `export DATABASE_URL="postgres://bt:bt@127.0.0.1:15455/bt" && pnpm test <pattern>`. Typecheck: `pnpm typecheck`. Full gate: `pnpm check`. Harness `.mjs` unit tests run under the same vitest. Run every command in the FOREGROUND (never background / Monitor / `git stash`); stage only the files you changed (a stray `.claude/worktrees/` exists — never `git add -A`).

---

## Task 1: Config flag + universe knobs

**Files:**
- Modify: `apps/backtester/src/config.ts` (`AppConfig` + `loadConfig`)
- Modify: `apps/backtester/test/helpers.ts` (`testConfig` — add the new fields, mirror how `barBatching`/`batchBars` were added)
- Test: `apps/backtester/test/config-universe-session.test.ts`

**Interfaces:**
- Produces: `AppConfig.universeSession: boolean`, `AppConfig.universeMaxN: number`, `AppConfig.universeMemBaseMb: number`, `AppConfig.universeMemPerSymbolMb: number`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/backtester/test/config-universe-session.test.ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('universe-session config', () => {
  it('defaults: flag off, sane numeric knobs', () => {
    const c = loadConfig({} as NodeJS.ProcessEnv);
    expect(c.universeSession).toBe(false);
    expect(c.universeMaxN).toBe(64);
    expect(c.universeMemBaseMb).toBe(128);
    expect(c.universeMemPerSymbolMb).toBe(8);
  });
  it('flag true only for exact "true"', () => {
    expect(loadConfig({ BACKTESTER_UNIVERSE_SESSION: 'true' } as NodeJS.ProcessEnv).universeSession).toBe(true);
    expect(loadConfig({ BACKTESTER_UNIVERSE_SESSION: '1' } as NodeJS.ProcessEnv).universeSession).toBe(false);
  });
  it('numeric knobs parse with NaN-guard floors', () => {
    expect(loadConfig({ BACKTESTER_UNIVERSE_MAX_N: '300' } as NodeJS.ProcessEnv).universeMaxN).toBe(300);
    expect(loadConfig({ BACKTESTER_UNIVERSE_MAX_N: 'x' } as NodeJS.ProcessEnv).universeMaxN).toBe(64);   // NaN → default
    expect(loadConfig({ BACKTESTER_UNIVERSE_MEM_PER_SYMBOL_MB: '16' } as NodeJS.ProcessEnv).universeMemPerSymbolMb).toBe(16);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test config-universe-session`
Expected: FAIL (`universeSession` etc. undefined).

- [ ] **Step 3: Add the fields to `AppConfig`**

In `apps/backtester/src/config.ts`, in the `AppConfig` interface right after `batchBars` (near the other Phase-D flags):

```ts
  /** 17c: run all symbols of a bundle in ONE container (N per-symbol instances). Default off (dark launch). */
  readonly universeSession: boolean;
  /** 17c: reject a universe run whose symbol count exceeds this (pre-exec validation). */
  readonly universeMaxN: number;
  /** 17c: per-container memory floor (MiB), added to universeMemPerSymbolMb × N. */
  readonly universeMemBaseMb: number;
  /** 17c: per-symbol memory (MiB) added on top of the base for a universe container. */
  readonly universeMemPerSymbolMb: number;
```

- [ ] **Step 4: Add the `loadConfig` lines**

In `loadConfig`'s returned object, right after `batchBars: …`, mirroring the NaN-guarded numeric pattern (`Math.max(floor, Number(env.X ?? default)) || default`):

```ts
    universeSession: env.BACKTESTER_UNIVERSE_SESSION === 'true',
    universeMaxN: Math.max(1, Math.floor(Number(env.BACKTESTER_UNIVERSE_MAX_N ?? 64))) || 64,
    universeMemBaseMb: Math.max(1, Math.floor(Number(env.BACKTESTER_UNIVERSE_MEM_BASE_MB ?? 128))) || 128,
    universeMemPerSymbolMb: Math.max(1, Math.floor(Number(env.BACKTESTER_UNIVERSE_MEM_PER_SYMBOL_MB ?? 8))) || 8,
```

- [ ] **Step 5: Keep `testConfig` typechecking**

In `apps/backtester/test/helpers.ts`, add to the `testConfig` object literal (near `barBatching: false`):

```ts
    universeSession: false,
    universeMaxN: 64,
    universeMemBaseMb: 128,
    universeMemPerSymbolMb: 8,
```

- [ ] **Step 6: Run test + typecheck**

Run: `pnpm test config-universe-session` → PASS (3 tests).
Run: `pnpm typecheck` → exit 0.

- [ ] **Step 7: Commit**

```bash
git add apps/backtester/src/config.ts apps/backtester/test/config-universe-session.test.ts apps/backtester/test/helpers.ts
git commit -m "feat(universe): BACKTESTER_UNIVERSE_SESSION flag + maxN/memory knobs (default off)"
```

---

## Task 2: `deriveUniversePolicy` — N-aware memory + session wall-time

**Files:**
- Create: `apps/backtester/src/engine/sandbox/universe-policy.ts`
- Test: `apps/backtester/test/universe-policy.test.ts`

**Interfaces:**
- Consumes: `SandboxPolicy` from `../sandbox-policy.js`.
- Produces: `deriveUniversePolicy(base: SandboxPolicy, n: number, opts: { memBaseMb: number; memPerSymbolMb: number; perSymbolSessionMs?: number }): SandboxPolicy` — returns a copy with `limits.memoryBytes = (memBaseMb + memPerSymbolMb × n) × 2^20` and `limits.wallTimeMsPerSession = (perSymbolSessionMs ?? base.limits.wallTimeMsPerSession) × n`; everything else (isolation, cpus, wallTimeMsPerCall, byte caps) unchanged.

- [ ] **Step 1: Write the failing test**

```ts
// apps/backtester/test/universe-policy.test.ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_SANDBOX } from '../src/engine/sandbox-policy.js';
import { deriveUniversePolicy } from '../src/engine/sandbox/universe-policy.js';

const MiB = 1024 * 1024;

describe('deriveUniversePolicy', () => {
  it('scales memory = (base + k×N) MiB and session wall-time × N; leaves the rest intact', () => {
    const p = deriveUniversePolicy(DEFAULT_SANDBOX, 10, { memBaseMb: 128, memPerSymbolMb: 8 });
    expect(p.limits.memoryBytes).toBe((128 + 8 * 10) * MiB); // 208 MiB
    expect(p.limits.wallTimeMsPerSession).toBe(30_000 * 10);
    expect(p.limits.wallTimeMsPerCall).toBe(DEFAULT_SANDBOX.limits.wallTimeMsPerCall); // unchanged
    expect(p.limits.cpus).toBe(DEFAULT_SANDBOX.limits.cpus);
    expect(p.isolation).toEqual(DEFAULT_SANDBOX.isolation); // isolation untouched (no sandbox weakening)
  });
  it('N=1 still scales cleanly', () => {
    const p = deriveUniversePolicy(DEFAULT_SANDBOX, 1, { memBaseMb: 128, memPerSymbolMb: 8 });
    expect(p.limits.memoryBytes).toBe((128 + 8) * MiB);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test universe-policy`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// apps/backtester/src/engine/sandbox/universe-policy.ts
import type { SandboxPolicy } from '../sandbox-policy.js';

const MiB = 1024 * 1024;

/**
 * Derive a universe-session policy: memory grows with the symbol count N and the session wall-time
 * budget scales with N (the one container runs all N symbols sequentially). Isolation, cpus, per-call
 * wall-time and byte caps are unchanged — this never weakens the sandbox.
 */
export function deriveUniversePolicy(
  base: SandboxPolicy,
  n: number,
  opts: { memBaseMb: number; memPerSymbolMb: number; perSymbolSessionMs?: number },
): SandboxPolicy {
  const perSymbolSessionMs = opts.perSymbolSessionMs ?? base.limits.wallTimeMsPerSession;
  return {
    ...base,
    limits: {
      ...base.limits,
      memoryBytes: (opts.memBaseMb + opts.memPerSymbolMb * n) * MiB,
      wallTimeMsPerSession: perSymbolSessionMs * n,
    },
  };
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm test universe-policy` → PASS. `pnpm typecheck` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/engine/sandbox/universe-policy.ts apps/backtester/test/universe-policy.test.ts
git commit -m "feat(universe): deriveUniversePolicy (memory base+k×N, session wall-time ×N, isolation intact)"
```

---

## Task 3: `universeContainerName` — kind + bundleHash (no strategy/overlay collision)

**Files:**
- Modify: `apps/backtester/src/engine/sandbox/docker-driver.ts` (add the fn next to `sessionContainerName`)
- Test: `apps/backtester/test/universe-container-name.test.ts`

**Interfaces:**
- Consumes: `dockerSanitize` (existing, `docker-driver.ts`).
- Produces: `universeContainerName(runId: string, kind: 'strategy' | 'overlay', bundleHash: string, suffix?: string): string` — `sbx-<runId>-<kind>-<bundleHash first 8 hex>[-suffix]`, sanitized, ≤200 chars. The `kind` + bundle-hash segments guarantee a strategy and an overlay bundle sharing a moduleId/version never collide.

- [ ] **Step 1: Write the failing test**

```ts
// apps/backtester/test/universe-container-name.test.ts
import { describe, expect, it } from 'vitest';
import { universeContainerName } from '../src/engine/sandbox/docker-driver.js';

describe('universeContainerName', () => {
  it('includes kind + bundle-hash so strategy and overlay do not collide', () => {
    const strat = universeContainerName('run-1', 'strategy', 'sha256:abcdef0123456789');
    const over = universeContainerName('run-1', 'overlay', 'sha256:abcdef0123456789');
    expect(strat).not.toBe(over);
    expect(strat).toContain('strategy');
    expect(over).toContain('overlay');
    expect(strat.startsWith('sbx-run-1-strategy-')).toBe(true);
  });
  it('sanitizes and caps at 200 chars', () => {
    const n = universeContainerName('run/with:bad', 'strategy', 'sha256:' + 'a'.repeat(64), 'x'.repeat(300));
    expect(n).toMatch(/^[a-zA-Z0-9_.-]+$/);
    expect(n.length).toBeLessThanOrEqual(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test universe-container-name`
Expected: FAIL (fn not exported).

- [ ] **Step 3: Implement**

In `docker-driver.ts`, right after `sessionContainerName`:

```ts
/**
 * Container name for a universe session (one container per bundle, N symbols inside). Drops the symbol
 * segment `sessionContainerName` used; includes `kind` + the bundle-hash prefix so a strategy and an
 * overlay bundle sharing a moduleId/version cannot collide on the same runId.
 */
export function universeContainerName(
  runId: string,
  kind: 'strategy' | 'overlay',
  bundleHash: string,
  suffix?: string,
): string {
  const hash8 = bundleHash.replace(/^sha256:/, '').slice(0, 8);
  const raw = `sbx-${runId}-${kind}-${hash8}${suffix !== undefined ? `-${suffix}` : ''}`;
  return dockerSanitize(raw).slice(0, 200);
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm test universe-container-name` → PASS. `pnpm typecheck` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/engine/sandbox/docker-driver.ts apps/backtester/test/universe-container-name.test.ts
git commit -m "feat(universe): universeContainerName (kind+bundleHash, no strategy/overlay collision)"
```

---

## Task 4: Harness — per-symbol instance state (overlay harness)

**Files:**
- Create: `apps/backtester/sandbox-harness-overlay/universe-instances.mjs`
- Modify: `apps/backtester/sandbox-harness-overlay/entry.mjs` (route by symbol)
- Modify: `apps/backtester/sandbox-harness-overlay/hook-batch.mjs` (accept a per-symbol state object — minor)
- Test: `apps/backtester/test/universe-instances.test.mjs.test.ts` (a `.test.ts` that imports the `.mjs` helper)

**Interfaces:**
- Produces: `universe-instances.mjs` exports:
  - `makeInstanceStore()` → `{ get(symbol), ensure(symbol, factory), all() }` where a per-symbol slot is `{ instance, rng, buffer, oiBuffer, liqBuffer }`.
  - `symbolOf(msg)` → reads `msg.symbol ?? msg.snapshot?.symbol ?? (msg.bars?.[0]?.snapshot?.symbol)` (single routing key for init/hook/hookBatch).

**Context:** Today `entry.mjs` holds module-level singletons `instance`/`rng`/`buffer`/`oiBuffer`/`liqBuffer` (`entry.mjs:21-25`). A universe container hosts N symbols, so each needs its own slot. `init` carries `msg.symbol`; `hook`/`hookBatch` carry the symbol inside `msg.snapshot.symbol` / `msg.bars[0].snapshot.symbol` (the ContextSnapshot already includes `symbol`). A per-symbol instance throw must still emit a normal `err` line (the container stays alive → the host keeps the session; see Task 6).

- [ ] **Step 1: Write the failing test**

```ts
// apps/backtester/test/universe-instances.test.mjs.test.ts
import { describe, expect, it } from 'vitest';
import { makeInstanceStore, symbolOf } from '../sandbox-harness-overlay/universe-instances.mjs';

describe('universe-instances', () => {
  it('ensure() creates one isolated slot per symbol; get() returns it', () => {
    const store = makeInstanceStore();
    const a = store.ensure('AAA', () => ({ tag: 'A' }));
    const b = store.ensure('BBB', () => ({ tag: 'B' }));
    expect(a.instance.tag).toBe('A');
    expect(b.instance.tag).toBe('B');
    a.buffer.push(1);
    expect(b.buffer).toEqual([]);           // isolated buffers
    expect(store.get('AAA')).toBe(a);        // stable identity
    expect(store.ensure('AAA', () => ({ tag: 'X' })).instance.tag).toBe('A'); // ensure is idempotent
  });
  it('symbolOf reads symbol from init/hook/hookBatch shapes', () => {
    expect(symbolOf({ t: 'init', symbol: 'S1' })).toBe('S1');
    expect(symbolOf({ t: 'hook', snapshot: { symbol: 'S2' } })).toBe('S2');
    expect(symbolOf({ t: 'hookBatch', bars: [{ snapshot: { symbol: 'S3' } }] })).toBe('S3');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test universe-instances`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `universe-instances.mjs`**

```js
// apps/backtester/sandbox-harness-overlay/universe-instances.mjs
/** Per-symbol harness state for a universe session (one container hosting N instances). */
export function makeInstanceStore() {
  const slots = new Map(); // symbol -> { instance, rng, buffer, oiBuffer, liqBuffer }
  return {
    get: (symbol) => slots.get(symbol),
    ensure(symbol, factory) {
      let s = slots.get(symbol);
      if (s === undefined) {
        s = { instance: undefined, rng: undefined, buffer: [], oiBuffer: [], liqBuffer: [] };
        const built = factory();
        s.instance = built.instance;
        s.rng = built.rng;
        slots.set(symbol, s);
      }
      return s;
    },
    all: () => slots.values(),
  };
}

/** Single routing key for init/hook/hookBatch messages. */
export function symbolOf(msg) {
  if (msg == null) return undefined;
  if (typeof msg.symbol === 'string') return msg.symbol;
  if (msg.snapshot != null && typeof msg.snapshot.symbol === 'string') return msg.snapshot.symbol;
  const b0 = Array.isArray(msg.bars) ? msg.bars[0] : undefined;
  if (b0 != null && b0.snapshot != null && typeof b0.snapshot.symbol === 'string') return b0.snapshot.symbol;
  return undefined;
}
```

- [ ] **Step 4: Run the helper test to verify it passes**

Run: `pnpm test universe-instances` → PASS (2 tests).

- [ ] **Step 5: Wire `entry.mjs` to per-symbol state**

Replace the module-level singletons (`entry.mjs:21-25`) with a store, and route each handler by symbol. The instance module import is cached once (same bundle); only the per-symbol `instance = factory()` differs.

```js
// entry.mjs — near the top, replace `let instance; let rng; const buffer=[]; ...`
import { makeInstanceStore, symbolOf } from './universe-instances.mjs';
const store = makeInstanceStore();
let loadedModule;               // the imported bundle module, cached across symbols

async function loadFactory(entryPoint) {
  if (loadedModule === undefined) {
    const url = pathToFileURL(`/sandbox/bundle/${entryPoint}`).href;
    loadedModule = await import(url);
  }
  const factory = loadedModule.default;
  const instance = typeof factory === 'function' ? factory() : (factory ?? loadedModule);
  return instance;
}
```

Rewrite `handleInit` to create the symbol's slot:

```js
async function handleInit(msg) {
  const symbol = symbolOf(msg);
  try {
    const built = { instance: await loadFactory(msg.entryPoint), rng: createSeededRng(typeof msg.seed === 'number' ? msg.seed : 0) };
    if (built.instance === undefined || built.instance === null) { err(undefined, 'init', 'bundle_load_failed', 'entry produced no module instance'); return; }
    store.ensure(symbol, () => built);
    ok(undefined, []);
  } catch (e) {
    const code = classifyError(e);
    err(undefined, 'init', code === 'sandbox_crashed' ? 'bundle_load_failed' : code, e && e.message ? e.message : e);
  }
}
```

Rewrite `handleHook` to resolve the slot and use its buffers/instance (a per-symbol throw still emits `err`, container stays alive):

```js
async function handleHook(msg) {
  const { seq, hook, snapshot, newBar, newOi, newLiq } = msg;
  const slot = store.get(symbolOf(msg));
  if (slot === undefined) { err(seq, hook, 'sandbox_output_malformed', `hook before init for symbol ${String(symbolOf(msg))}`); return; }
  try {
    if (newBar !== null && newBar !== undefined) slot.buffer.push(newBar);
    if (newOi !== undefined) slot.oiBuffer.push(newOi);
    if (newLiq !== undefined) slot.liqBuffer.push(newLiq);
    const ctx = rehydrateContext(snapshot, slot.buffer, slot.rng, slot.oiBuffer, slot.liqBuffer);
    const fn = pickHookFor(slot.instance, hook);
    if (fn === undefined) { ok(seq, []); return; }
    const out = await fn.call(slot.instance, ctx);
    if (hook === 'init' || hook === 'dispose') { ok(seq, []); return; }
    ok(seq, normalize(out));
  } catch (e) {
    err(seq, hook, classifyError(e), e && e.message ? e.message : e); // per-symbol soft error, container alive
  }
}
```

`pickHook` currently closes over the module-level `instance`; change it to take the instance explicitly: `function pickHookFor(instance, hook) { … same dispatch on `instance` … }`. Update `handleHookBatch` to resolve the slot and pass its state into `runHookBatch`:

```js
async function handleHookBatch(msg) {
  const slot = store.get(symbolOf(msg));
  if (slot === undefined) { errBatch(msg.seq, msg.hook, 'sandbox_output_malformed', 'hookBatch before init', 0); return; }
  try {
    const r = await runHookBatch(msg.bars, msg.hook, {
      buffer: slot.buffer, oiBuffer: slot.oiBuffer, liqBuffer: slot.liqBuffer,
      rng: slot.rng, instance: slot.instance, rehydrateContext, pickHook: (h) => pickHookFor(slot.instance, h), normalize,
    });
    if (r.kind === 'ok') okBatch(msg.seq, r.stoppedAt, r.decisions);
    else errBatch(msg.seq, msg.hook, classifyError(r.cause), r.cause?.message ?? r.cause, r.barOffset);
  } catch (e) {
    errBatch(msg.seq, msg.hook, classifyError(e), e?.message ?? e, 0);
  }
}
```

`hook-batch.mjs::runHookBatch` already receives `pickHook` in `deps` and calls `pickHook(hook)` — it needs NO change if the caller passes `pickHook: (h) => pickHookFor(slot.instance, h)` as above (verify `runHookBatch` uses `deps.pickHook(hook)`, not a closed-over `instance`; if it references `deps.instance` for anything other than `fn.call`, thread the slot's instance — it already receives `instance` in deps).

> Implementer note: this is a pure refactor of harness dispatch — behavior for a SINGLE symbol must be identical to today (one slot, same buffers, same instance). The Docker golden (Task 9) is the end-to-end proof; the unit test above covers the store/routing logic. Keep `sandbox-harness/entry.mjs` (legacy) untouched.

- [ ] **Step 6: Run helper test + full harness-adjacent suites + typecheck**

Run: `pnpm test universe-instances` → PASS.
Run: `pnpm typecheck` → exit 0 (the `.mjs` isn't typechecked, but the `.test.ts` import is).

- [ ] **Step 7: Commit**

```bash
git add apps/backtester/sandbox-harness-overlay/universe-instances.mjs apps/backtester/sandbox-harness-overlay/entry.mjs apps/backtester/sandbox-harness-overlay/hook-batch.mjs apps/backtester/test/universe-instances.test.mjs.test.ts
git commit -m "feat(universe): harness routes init/hook/hookBatch to per-symbol instance slots"
```

---

## Task 5: `SandboxSession` universe mode — one container, per-symbol init + bar bookkeeping

**Files:**
- Modify: `apps/backtester/src/engine/sandbox/sandbox-session.ts`
- Test: `apps/backtester/test/sandbox-session-universe.test.ts` (unit test with a FAKE `DockerDriver`, no real Docker)

**Interfaces:**
- Consumes: `SessionConfig` (existing), `universeContainerName` (Task 3).
- Produces: `SessionConfig` gains `readonly universe?: boolean`. In universe mode: (a) the container name comes from `universeContainerName(runId, kind, bundleHash, suffix)`; (b) `barIndex`/`lastBarTs` become **per-symbol** (`Map<string, { barIndex: number; lastBarTs?: number }>`); (c) the container spawns once, and each new symbol gets its own `init` envelope over the same channel before its first hook.

**Context:** Today `open()` spawns the container AND sends one `init` for `cfg.symbol`; `buildHookPayload` mutates scalar `this.barIndex`/`this.lastBarTs` (`sandbox-session.ts:161-184`). In universe mode the session serves many symbols, so per-symbol state must be keyed, and `init` must be sent per symbol (the harness creates a slot per `init`, Task 4). The host still drives symbol-major, so within one symbol the sequence is unchanged.

- [ ] **Step 1: Write the failing test (fake driver captures the wire)**

```ts
// apps/backtester/test/sandbox-session-universe.test.ts
// A fake DockerDriver + fake channel to assert: one spawn for N symbols, one init per symbol,
// per-symbol barIndex. Uses the real SandboxSession with cfg.universe = true.
import { describe, expect, it } from 'vitest';
import { SandboxSession } from '../src/engine/sandbox/sandbox-session.js';
// Build a fake driver whose spawnSession returns a scripted duplex that replies `{t:'ok'}` to every
// init/hook. Capture container names + the sent envelopes. (Copy the fake-driver pattern from an
// existing sandbox unit test if one exists; otherwise implement a minimal EventEmitter-backed stub.)
// … construct sessionCfg with universe:true, two symbols 'AAA' and 'BBB' …

describe('SandboxSession universe mode', () => {
  it('spawns exactly ONE container for N symbols and sends one init per symbol', async () => {
    // drive: initStrategy(AAA) → callHook(onBarClose, AAA bar0) → initStrategy(BBB) → callHook(onBarClose, BBB bar0)
    // assert: driver.spawnSession called once; container name from universeContainerName (contains kind+hash8);
    //         two 'init' envelopes seen (symbol AAA, symbol BBB).
  });
  it('keeps per-symbol barIndex (AAA bar0 and BBB bar0 both serialize barIndex 0)', async () => {
    // assert the snapshot barIndex for each symbol's first bar is 0 (not shared/global).
  });
});
```

> Implementer note: read the repo for an existing `SandboxSession` unit test with a fake driver/channel (grep `spawnSession` in `test/`). Reuse that harness. If none exists, build a minimal fake `DockerDriver` returning a child with scriptable stdin/stdout streams that echo `{t:'ok'}` per request line. The ASSERTIONS above are the spec: one spawn, one init/symbol, per-symbol barIndex.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test sandbox-session-universe`
Expected: FAIL (universe mode not implemented — either a type error on `cfg.universe` or wrong spawn count/barIndex).

- [ ] **Step 3: Add `universe` to `SessionConfig` + per-symbol state**

In `sandbox-session.ts`, add to `SessionConfig`: `readonly universe?: boolean;` and `readonly bundleHash?: string;` (needed for the universe container name).

Replace the scalar bar counters with a per-symbol map (keep the scalar path for non-universe to stay byte-identical):

```ts
  private barIndex = -1;                 // non-universe (single symbol) — unchanged
  private lastBarTs: number | undefined; // non-universe — unchanged
  private readonly perSymbol = new Map<string, { barIndex: number; lastBarTs?: number }>(); // universe
  private readonly initializedSymbols = new Set<string>(); // universe: symbols whose init was sent
```

- [ ] **Step 4: Universe container name + spawn-once in `openInner`**

In `openInner`, choose the name by mode and DON'T re-spawn if already open:

```ts
    if (this.container !== undefined) return { ok: true, decisions: [] }; // universe: container already up
    const name = this.cfg.universe === true
      ? universeContainerName(this.cfg.runId, this.cfg.kind, this.cfg.bundleHash ?? '', this.cfg.containerSuffix)
      : sessionContainerName(this.cfg.runId, manifest.id, manifest.version, this.cfg.symbol, this.cfg.containerSuffix);
```

Import `universeContainerName` at the top. In universe mode, DO NOT send the `init` inside `openInner` (init is per-symbol — Step 5 handles it); guard the existing `channel.send({ t:'init', … })` so it only runs in non-universe mode. In universe mode, `openInner` just spawns + sets `sessionDeadlineEpoch` and returns ok.

- [ ] **Step 5: Per-symbol init on first hook + per-symbol bar bookkeeping**

Add a helper and call it at the top of `callHook`/`callHookBatch` in universe mode:

```ts
  private async ensureSymbolInit(ctx: StrategyContext): Promise<HookResult | undefined> {
    if (this.cfg.universe !== true || this.initializedSymbols.has(ctx.symbol)) return undefined;
    const { manifest, descriptor } = this.bundle;
    this.channel!.send({
      t: 'init', runId: this.cfg.runId, moduleRef: { id: manifest.id, version: manifest.version },
      symbol: ctx.symbol, kind: this.cfg.kind, seed: this.cfg.seed, params: this.cfg.params,
      manifestHooks: manifest.hooks, entryPoint: descriptor.entryPoint,
    });
    const outcome = await this.channel!.receive(Date.now() + CONTAINER_STARTUP_GRACE_MS);
    if (outcome.kind !== 'ok') return this.fail(this.mapFailure(outcome, 'init', 'bundle_load_failed'));
    this.initializedSymbols.add(ctx.symbol);
    return undefined;
  }
```

In `callHook`, after ensuring the container is open, add: `if (this.cfg.universe === true) { const f = await this.ensureSymbolInit(ctx); if (f !== undefined) return f; }`.

Make `buildHookPayload` read/write the counter from EITHER the per-symbol map (universe) or the existing scalars (non-universe). Only WHERE the counter lives changes; the newBar/oi/liq logic is untouched:

```ts
  private buildHookPayload(ctx: StrategyContext): HookBatchEntry {
    const useMap = this.cfg.universe === true;
    let st: { barIndex: number; lastBarTs?: number };
    if (useMap) {
      st = this.perSymbol.get(ctx.symbol) ?? { barIndex: -1 };
      this.perSymbol.set(ctx.symbol, st);
    } else {
      st = { barIndex: this.barIndex, lastBarTs: this.lastBarTs };
    }

    let newBar = null as ReturnType<typeof plainBar> | null;
    let newOi: { ts: number; oiTotalUsd: number } | null | undefined;
    let newLiq: { ts: number; longUsd: number; shortUsd: number } | null | undefined;
    if (ctx.bar.ts !== st.lastBarTs) {
      st.barIndex += 1;
      st.lastBarTs = ctx.bar.ts;
      newBar = plainBar(ctx.bar);
      const m = ctx.market;
      if (m !== undefined) {
        if (m.oiWindow(1).length > 0) newOi = m.oiAsOf() ?? null;
        if (m.liqWindow(1).length > 0) newLiq = m.liqAsOf() ?? null;
      }
    }
    if (!useMap) { this.barIndex = st.barIndex; this.lastBarTs = st.lastBarTs; } // write scalars back (non-universe)

    return {
      snapshot: serializeContext(ctx, st.barIndex),
      newBar,
      ...(newOi !== undefined ? { newOi } : {}),
      ...(newLiq !== undefined ? { newLiq } : {}),
    };
  }
```

> Implementer note: for a single-symbol non-universe run this is behaviorally identical to today (the scalar is read into `st`, mutated, written back — same increments, same `serializeContext(ctx, barIndex)`). In universe mode `st` is the persisted per-symbol slot, so each symbol's `barIndex` advances independently. This is exactly the field whose sharing would break byte-identity — the Task-9 multi-symbol golden is the proof.

- [ ] **Step 6: Run test + typecheck**

Run: `pnpm test sandbox-session-universe` → PASS (one spawn, one init/symbol, per-symbol barIndex).
Run: `pnpm typecheck` → exit 0.
Run the existing session/sandbox suites to confirm the non-universe path is unchanged: `pnpm test sandbox-session sandbox` → PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/backtester/src/engine/sandbox/sandbox-session.ts apps/backtester/test/sandbox-session-universe.test.ts
git commit -m "feat(universe): SandboxSession one-container + per-symbol init + per-symbol bar bookkeeping"
```

---

## Task 6: `SandboxSession` universe mode — per-symbol fail-closed

**Files:**
- Modify: `apps/backtester/src/engine/sandbox/sandbox-session.ts`
- Test: extend `apps/backtester/test/sandbox-session-universe.test.ts`

**Interfaces:**
- Consumes: `HookResult`, `SessionError` (existing).
- Produces: in universe mode, a HARNESS-level `err` outcome (container alive) returns `{ ok:false, decisions:[], error }` for THAT symbol WITHOUT latching `failed`/closing the container; a channel-level death (`eof`/`timeout`/`overflow`/`malformed`) still calls `this.fail()` (session-fatal → every subsequent symbol degrades). Non-universe behavior is unchanged (any failure latches, as today).

**Context:** Today `callHook`'s non-ok outcome always calls `this.fail(...)` (`sandbox-session.ts:216`), which closes the container. In a universe session that would kill all N symbols on the first symbol's strategy exception. The spec requires per-symbol fail-closed: one instance throwing degrades only that symbol; only a real container death degrades all.

- [ ] **Step 1: Write the failing test**

Extend `sandbox-session-universe.test.ts`:

```ts
  it('a harness err for symbol AAA fails-closed AAA only — the container stays up and BBB still runs', async () => {
    // script the fake channel: reply {t:'err',...} to AAA's onBarClose, {t:'ok',decisions:[...]} to BBB's.
    // assert: callHook(AAA) → ok:false (fail-closed), driver NOT disposed (container alive),
    //         callHook(BBB) → ok:true with decisions (session survived).
  });
  it('an eof (container death) is session-fatal — subsequent symbols also fail-closed', async () => {
    // script: reply eof to AAA. assert callHook(AAA) fails AND the session is closed (driver disposed),
    // and a later callHook(BBB) returns ok:false without a new spawn.
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test sandbox-session-universe`
Expected: FAIL (today's `err` path calls `this.fail()` → container disposed → BBB can't run).

- [ ] **Step 3: Split soft vs fatal in `callHook` (universe only)**

In `callHook`, replace the tail `return this.fail(this.mapFailure(outcome, hook, 'sandbox_crashed'));` with:

```ts
    if (outcome.kind === 'ok') return { ok: true, decisions: outcome.decisions };
    const error = this.mapFailure(outcome, hook, 'sandbox_crashed');
    if (this.cfg.universe === true && outcome.kind === 'err') {
      // per-symbol soft failure: the harness caught a strategy exception; the container is alive.
      // Fail-closed for THIS symbol only — do not latch/close the session.
      return { ok: false, decisions: [], error };
    }
    return this.fail(error); // container death (eof/timeout/overflow/malformed) or non-universe: session-fatal
```

Apply the same soft-vs-fatal split in `callHookBatch`'s non-ok path (an `err` outcome with the container alive → return `{ ok:false, stoppedAt, error }` without `this.fail()` in universe mode; a channel death → `this.fail()`).

> Implementer note: `mapFailure` maps `outcome.kind` to a `SessionError`; keep using it for the error VALUE, only change whether `this.fail()` (which closes the container) is invoked. The executor already records the returned `error` per symbol via `record(err, ctx)` (Task 7 keeps that), so the degraded symbol stays observable.

- [ ] **Step 4: Run test + regression + typecheck**

Run: `pnpm test sandbox-session-universe` → PASS (soft err keeps session; eof kills it).
Run: `pnpm test sandbox-session sandbox` → non-universe path unchanged.
Run: `pnpm typecheck` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/engine/sandbox/sandbox-session.ts apps/backtester/test/sandbox-session-universe.test.ts
git commit -m "feat(universe): per-symbol fail-closed (harness err soft; container death session-fatal)"
```

---

## Task 7: Executor collapse + router threading

**Files:**
- Modify: `apps/backtester/src/engine/sandbox/sandbox-executor.ts` (universe mode: one shared session)
- Modify: `apps/backtester/src/engine/sandbox/routing.ts` (thread universe deps → scaled policy + universe cfg)
- Test: `apps/backtester/test/sandbox-executor-universe.test.ts`

**Interfaces:**
- Consumes: `deriveUniversePolicy` (Task 2), `universeContainerName` (Task 3), `SessionConfig.universe`/`bundleHash` (Task 5).
- Produces:
  - `SandboxExecutorDeps` gains `readonly universe?: { readonly enabled: boolean; readonly n: number; readonly memBaseMb: number; readonly memPerSymbolMb: number }`.
  - `ExecutorRouterDeps` gains the same `universe?` field; `sandboxFor(bundle)` derives `deriveUniversePolicy(policy, n, …)` and passes `universe:true` + `bundleHash` into the executor when enabled.

**Context:** `SandboxModuleExecutor.sessionFor` keys `sessions` by `ctx.symbol` (`sandbox-executor.ts:69-90`). In universe mode it must return ONE shared session (keyed by a constant). `createExecutorRouter.sandboxFor` caches one executor per `bundleHash` already (`routing.ts:187-194`) — the natural place to inject the scaled policy + universe cfg.

- [ ] **Step 1: Write the failing test**

```ts
// apps/backtester/test/sandbox-executor-universe.test.ts
import { describe, expect, it } from 'vitest';
import { SandboxModuleExecutor } from '../src/engine/sandbox/sandbox-executor.js';
// Fake DockerDriver capturing spawnSession calls. Build an executor with deps.universe = {enabled:true,n:3,...}.
// Drive initStrategy + executeStrategyHook for 3 different ctx.symbol values.
describe('SandboxModuleExecutor universe mode', () => {
  it('uses ONE session (one spawn) across all symbols; records per-symbol errors', async () => {
    // assert driver.spawnSession called exactly once for 3 symbols; a scripted err for symbol[1]
    // shows up in executor.errors with symbol === symbols[1] and the run keeps going for symbol[2].
  });
  it('flag off ⇒ one session per symbol (today’s behavior)', async () => {
    // deps.universe undefined ⇒ 3 spawns for 3 symbols (byte-identical baseline).
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test sandbox-executor-universe`
Expected: FAIL (universe mode not implemented — 3 spawns instead of 1).

- [ ] **Step 3: Executor universe mode**

In `sandbox-executor.ts`, add `universe` to `SandboxExecutorDeps` and a field `private readonly universe?: {...}` set in the constructor. Change `sessionFor` so universe mode returns one shared session:

```ts
  private sessionFor(ctx: StrategyContext): SandboxSession {
    const key = this.universe?.enabled === true ? '__universe__' : ctx.symbol;
    let s = this.sessions.get(key);
    if (s === undefined) {
      s = new SandboxSession(this.bundle, this.policy, {
        runId: ctx.run.runId,
        symbol: ctx.symbol,                       // seeds the first symbol; universe uses per-symbol init
        seed: ctx.run.seed,
        params: ctx.params,
        kind: this.bundle.manifest.kind === 'overlay' ? 'overlay' : 'strategy',
        containerSuffix: this.containerSuffix,
        universe: this.universe?.enabled === true,
        bundleHash: this.bundle.descriptor.bundleHash,
      }, this.driver, this.harnessDir, this.mount);
      this.sessions.set(key, s);
    }
    return s;
  }
```

`disposeStrategy` uses `this.sessions.get(ctx.symbol)` — in universe mode look up the `'__universe__'` key (or skip the per-symbol dispose lookup: `const s = this.sessions.get(this.universe?.enabled === true ? '__universe__' : ctx.symbol)`). `record()` already tags by `ctx.symbol`, so per-symbol error observability is preserved unchanged.

- [ ] **Step 4: Router threading + scaled policy**

In `routing.ts`, add `universe?: {...}` to `ExecutorRouterDeps`. In `sandboxFor`, when `deps.universe?.enabled`, derive the scaled policy and pass the universe cfg into the executor:

```ts
  function sandboxFor(bundle: ModuleBundle): ModuleExecutor {
    const existing = sandboxExecutors.get(bundle.descriptor.bundleHash);
    if (existing !== undefined) return existing;
    const basePolicy = policies.resolve(policyRef) ?? DEFAULT_SANDBOX;
    const u = deps.universe;
    const policy = u?.enabled === true
      ? deriveUniversePolicy(basePolicy, u.n, { memBaseMb: u.memBaseMb, memPerSymbolMb: u.memPerSymbolMb })
      : basePolicy;
    const exec = new SandboxModuleExecutor(bundle, policy, { ...deps.sandboxDeps, universe: u });
    sandboxExecutors.set(bundle.descriptor.bundleHash, exec);
    return exec;
  }
```

Import `deriveUniversePolicy`. Confirm production wiring: grep for `createExecutorRouter(` in `buildApp`/engine deps and the `sandboxDeps.harnessDir` source — verify it resolves to the OVERLAY harness dir (`config.overlaySandbox.harnessDir`) so the Task-4 harness change is the one that runs. Note the finding in your report.

- [ ] **Step 5: Run test + regression + typecheck**

Run: `pnpm test sandbox-executor-universe` → PASS (1 spawn universe / 3 spawns off).
Run: `pnpm test routing sandbox-executor` → existing behavior intact.
Run: `pnpm typecheck` → exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/backtester/src/engine/sandbox/sandbox-executor.ts apps/backtester/src/engine/sandbox/routing.ts apps/backtester/test/sandbox-executor-universe.test.ts
git commit -m "feat(universe): executor one-session collapse + router scaled-policy/universe threading"
```

---

## Task 8: `runBacktest` cap validation + config→engine wiring (flag turns on)

**Files:**
- Modify: `apps/backtester/src/engine/runner.ts` (maxUniverseN pre-exec validation + `universe` in `RunDeps`)
- Modify: the engine-deps assembly that builds `RunDeps`/the router from `AppConfig` (grep for where `barBatching` is threaded from config into the run — mirror it for `universe`)
- Test: `apps/backtester/test/runner-universe-cap.test.ts`

**Interfaces:**
- Consumes: `AppConfig.universeSession`/`universeMaxN`/`universeMemBaseMb`/`universeMemPerSymbolMb` (Task 1); `createExecutorRouter` `universe` deps (Task 7).
- Produces: `RunDeps` gains an optional `universe?: { enabled: boolean; maxN: number; memBaseMb: number; memPerSymbolMb: number }` (mirroring how `barBatching?: { maxBars }` is passed). When `universe.enabled` and `request.symbols.length > universe.maxN`, `runBacktest` returns a `rejected` outcome (pre-exec validation). When enabled, the constructed router receives `universe: { enabled:true, n: request.symbols.length, memBaseMb, memPerSymbolMb }`.

- [ ] **Step 1: Determine the reject code (no new contract member)**

Read the `ValidationCode` union in `@trading/research-contracts` (grep `ValidationCode`). Pick the EXISTING code that best fits "request exceeds a capacity limit" (candidates in priority order: a generic request/limit/config code if present). Record the chosen code in your report. If NONE is a reasonable fit, STOP and report NEEDS_CONTEXT (do not add a member — Global Constraint: no contract change).

- [ ] **Step 2: Write the failing test**

```ts
// apps/backtester/test/runner-universe-cap.test.ts
import { describe, expect, it } from 'vitest';
import { runBacktest } from '../src/engine/runner.js';
// Build a minimal valid BacktestRunRequest with symbols.length = 3 and RunDeps with
// universe: { enabled:true, maxN:2, memBaseMb:128, memPerSymbolMb:8 }. Reuse an existing runner test's
// request/deps builder (grep test/ for runBacktest usage; e.g. a runner unit test with a trusted registry).
describe('runBacktest maxUniverseN', () => {
  it('rejects a run whose symbol count exceeds maxN (pre-exec, nothing spawned)', async () => {
    const out = await runBacktest(reqWithSymbols(3), depsWithUniverse({ enabled: true, maxN: 2 }));
    expect(out.status).toBe('rejected');
    expect(out.validation?.issues?.[0]?.message).toMatch(/universe|symbols|limit/i);
  });
  it('does not reject when universe disabled or within maxN', async () => {
    expect((await runBacktest(reqWithSymbols(3), depsWithUniverse({ enabled: false, maxN: 2 }))).status).not.toBe('rejected');
    expect((await runBacktest(reqWithSymbols(2), depsWithUniverse({ enabled: true, maxN: 2 }))).status).not.toBe('rejected');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test runner-universe-cap`
Expected: FAIL (no cap check; `universe` not on `RunDeps`).

- [ ] **Step 4: Add the cap block in `runBacktest`**

Add `universe?` to `RunDeps`. Insert a validation block right AFTER the 023 market-kind coverage gate (`runner.ts` ~L792), before router/engine construction, using the existing `rejected(code, message, path)` helper (`runner.ts:71`) and the code chosen in Step 1:

```ts
  if (deps.universe?.enabled === true && request.symbols.length > deps.universe.maxN) {
    return rejected(
      <CHOSEN_VALIDATION_CODE>,
      `universe run has ${request.symbols.length} symbols, exceeding the configured limit of ${deps.universe.maxN}`,
      '/symbols',
    );
  }
```

- [ ] **Step 5: Thread `universe` into the router**

Where `runBacktest` builds the router (`const router = deps.router ?? createTrustedRouter(...)` / the sandbox router path), pass the universe deps through so `createExecutorRouter` receives `universe: { enabled: true, n: request.symbols.length, memBaseMb: deps.universe.memBaseMb, memPerSymbolMb: deps.universe.memPerSymbolMb }` when enabled. (If the router is injected via `deps.router` in tests, ensure the production assembly — Step 6 — sets it.)

- [ ] **Step 6: Wire `AppConfig` → `RunDeps.universe` in the engine-deps assembly**

Grep for where `barBatching` flows from `AppConfig` into a run (the worker/engine deps builder). Mirror it: when `config.universeSession`, set `universe: { enabled: true, maxN: config.universeMaxN, memBaseMb: config.universeMemBaseMb, memPerSymbolMb: config.universeMemPerSymbolMb }`. Flag OFF ⇒ `universe` undefined ⇒ byte-identical today.

- [ ] **Step 7: Run test + regression + typecheck**

Run: `pnpm test runner-universe-cap` → PASS.
Run: `pnpm test runner` → existing runner tests intact.
Run: `pnpm typecheck` → exit 0.

- [ ] **Step 8: Commit**

```bash
git add apps/backtester/src/engine/runner.ts apps/backtester/test/runner-universe-cap.test.ts <engine-deps-assembly-file>
git commit -m "feat(universe): maxN pre-exec validation + AppConfig→RunDeps→router wiring (flag on)"
```

---

## Task 9: Golden gate — universe ON vs per-symbol OFF byte-identical (+ failure/cap tests)

**Files:**
- Test: `apps/backtester/test/universe-session-equivalence.test.ts` (Docker-gated golden)
- Modify (if needed): a fixture request with ≥3 symbols (see Step 1)

**Interfaces:**
- Consumes: everything above + the existing golden helpers (`materializeReadableBundle`, `buildSandboxStrategyBaselineDeps`, `buildOverlayDataset`, `runStrategyBacktest`/`runBacktest`, `normalize`/`restamp`/`contentRef`).

**Context:** Mirror `apps/backtester/test/bar-batching-equivalence.test.ts` exactly (the flag-ON-vs-OFF golden precedent): run the SAME multi-symbol request twice with different runIds — once per-symbol (universe off), once universe — `normalize`+`restamp` one to the other's runId, assert `contentRef` equality. This is the load-bearing merge gate.

- [ ] **Step 1: Ensure a ≥3-symbol fixture request**

Check the fixture request used by the strategy golden (`test/fixtures/overlay/requests/baseline.json`, `strategyBaselineReq.symbols`). If it is single-symbol, add a multi-symbol variant fixture (≥3 symbols the FixtureDataPort has candles for — grep `FIXTURES_DIR`/`fixtures/candles` for available symbols) and a `loadOverlayRequest('universe-multi.json')` entry. A single-symbol golden would NOT exercise the collapse; the gate MUST be multi-symbol.

- [ ] **Step 2: Write the Docker-gated golden**

```ts
// apps/backtester/test/universe-session-equivalence.test.ts
import { describe, expect, it } from 'vitest';
import { DOCKER_AVAILABLE } from './store-factories.js';
import { contentRef } from '../src/determinism/hash.js';
import { normalize } from '../src/jobs/dedup/restamp.js'; // confirm exact import path from bar-batching-equivalence.test.ts
import { restamp } from '../src/jobs/dedup/restamp.js';
// … reuse the imports + helpers from bar-batching-equivalence.test.ts (materializeReadableBundle,
//    buildSandboxStrategyBaselineDeps, buildOverlayDataset, FixtureDataPort, runStrategyBacktest) …

const req = loadOverlayRequest('universe-multi.json'); // ≥3 symbols

describe.skipIf(!DOCKER_AVAILABLE)('universe-session golden gate (Docker)', () => {
  it('universe ON (one container, N instances) is byte-identical to per-symbol OFF', async () => {
    const spA = await materializeReadableBundle(loadInlineBundle('short-after-pump.bundle.json'));
    const spB = await materializeReadableBundle(loadInlineBundle('short-after-pump.bundle.json'));
    try {
      const marketTape = await buildOverlayDataset(new FixtureDataPort(FIXTURES_DIR), {
        datasetRef: req.datasetRef, symbols: req.symbols, timeframe: req.timeframe, period: req.period,
      });
      const depsA = buildSandboxStrategyBaselineDeps({ spDir: spA.bundleDir });
      const depsB = buildSandboxStrategyBaselineDeps({ spDir: spB.bundleDir });
      try {
        const perSymbol = await runStrategyBacktest(
          { ...req, runId: 'run-AAAAAAAA', engine: 'strategy' },
          { registry: depsA.registry, marketTape, router: depsA.router }, // universe OFF
        );
        const universe = await runStrategyBacktest(
          { ...req, runId: 'run-BBBBBBBB', engine: 'strategy' },
          { registry: depsB.registry, marketTape, router: depsB.router,
            universe: { enabled: true, maxN: 64, memBaseMb: 128, memPerSymbolMb: 8 } },
        );
        const restamped = restamp(normalize('strategy', perSymbol, 'run-AAAAAAAA'), 'run-BBBBBBBB');
        expect(contentRef(restamped)).toBe(contentRef(universe)); // result_hash byte-identical
      } finally { depsA.router.closeAll(); depsB.router.closeAll(); }
    } finally { await spA.cleanup(); await spB.cleanup(); }
  }, 300_000);
});
```

> Implementer note: the universe run's `router` must be a router constructed with the `universe` deps (Task 7). If `buildSandboxStrategyBaselineDeps` doesn't accept universe deps, either extend it or build the universe router inline via `createExecutorRouter({ ...sameSandboxDeps, universe: {...} })`. Copy the EXACT `normalize`/`restamp`/`contentRef` import paths and helper wiring from `bar-batching-equivalence.test.ts` — do not guess.

- [ ] **Step 3: Run the golden (real Docker)**

Run: `export DATABASE_URL="postgres://bt:bt@127.0.0.1:15455/bt" && pnpm test universe-session-equivalence`
Expected: PASS (byte-identical) if Docker is available; a clean SKIP otherwise. A skipped run is NOT acceptance — it MUST actually run against Docker here (Docker is available in this env). If it FAILS on a hash mismatch, that localizes a determinism regression in the collapse (per-symbol barIndex, init order, or buffer isolation) — fix in Tasks 4–7.

- [ ] **Step 4: Add per-symbol fail-closed + cap-reject tests**

Add two more tests (the fail-closed one Docker-gated, the cap one not):

```ts
  it('one symbol’s instance failure degrades only that symbol; the run still completes', async () => {
    // Use a bundle/fixture where symbol[1] throws (or inject a failing bundle for one symbol). Assert the
    // run status is completed, symbol[1] contributes idle/zero trades, the other symbols produce their
    // normal trades, and executor errors contain a symbol[1]-tagged entry. (Docker-gated.)
  });
```

```ts
// cap reject (no Docker needed) — can live in runner-universe-cap.test.ts (Task 8) or here:
  it('rejects when symbols exceed maxN', async () => {
    const out = await runStrategyBacktest({ ...req, runId: 'run-C' },
      { registry: depsA.registry, marketTape, router: depsA.router, universe: { enabled: true, maxN: 1, memBaseMb: 128, memPerSymbolMb: 8 } });
    expect(out.status).toBe('rejected');
  });
```

- [ ] **Step 5: Confirm existing goldens hold with the flag ON and OFF**

Run the existing byte-identity goldens and the full sandbox suite: `export DATABASE_URL="postgres://bt:bt@127.0.0.1:15455/bt" && pnpm test bar-batching-equivalence sandbox dedup-equivalence` → all PASS (universe flag OFF path unchanged).

- [ ] **Step 6: Full gate**

Run: `export DATABASE_URL="postgres://bt:bt@127.0.0.1:15455/bt" && pnpm check` (typecheck + full suite).
Expected: green (Docker-gated universe golden RUNS here; on a Docker-less CI lane it skips — CI's Docker lane covers it).

- [ ] **Step 7: Commit**

```bash
git add apps/backtester/test/universe-session-equivalence.test.ts apps/backtester/test/fixtures/overlay/requests/universe-multi.json
git commit -m "test(universe): golden gate — universe ON vs per-symbol OFF byte-identical + fail-closed + cap"
```

---

## Notes for the executor

- **Byte-identity is the merge bar.** Task 9's multi-symbol golden (universe ON vs per-symbol OFF) MUST actually run against Docker (available here) and pass; a skip is not acceptance. Existing goldens (bar-batching, dedup-equivalence, sandbox) must stay green with the flag OFF — the default path is byte-for-byte today's.
- **Keep the non-universe path pristine.** Every session/executor change branches on `universe === true`; the `false`/absent branch must be the exact prior code. The `SandboxSession` scalar `barIndex`/`lastBarTs` path and per-symbol `sessions` map stay for flag-OFF.
- **No contract change.** The cap reject reuses an existing `ValidationCode` (Task 8 Step 1); do not touch `packages/sdk` or `@trading/research-contracts` type unions.
- **Harness verification.** Confirm (Task 7 Step 4) that production strategy+overlay runs use `sandbox-harness-overlay/` (the harness Task 4 modifies), not the legacy `sandbox-harness/entry.mjs`.
- **One PR.** Final whole-branch review on the most capable model; the golden gate is the headline check.
```
