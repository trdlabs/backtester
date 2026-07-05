# Cross-run Tape Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Materialize each distinct market-data slice once per worker process and reuse the resulting tape/dataset object across runs, behind a thin in-memory cache interface.

**Architecture:** A generic entry-count LRU `TapeCache<V>` lives in `apps/backtester/src/data/tape-cache.ts`. Two module-level singletons (`overlayTapeCache`, `momentumTapeCache`) are consulted at the two materialization seams in `processNextQueued` (`jobs/worker.ts`) via `getOrBuild(key, builder)`. The cache stores the in-flight Promise (de-dups concurrent builds), never caches rejections, and evicts least-recently-used entries past a configurable bound. The cached objects are shared, not cloned — they are verified immutable for the consumers.

**Tech Stack:** TypeScript (ESM, strict), Node ≥ 22, Vitest 2.

## Global Constraints

- ESM with explicit `.js` import extensions on relative imports (e.g. `'../src/data/reader.js'`).
- Engine types imported into the data layer MUST use `import type` (erased at compile) to preserve the momentum/data path's runtime independence from `src/engine/**`.
- No new runtime dependencies.
- The frozen momentum golden `result_hash` MUST NOT move: `sha256:eff10116147933c96d92ae50071ef66339467fb69545c38855dcd50c2c0b43ba`. The overlay golden must not move either. Wiring the cache must be behavior-preserving.
- Test runner: Vitest. Fast single-file run (skips the slow `pretest` SDK/harness build): `npx vitest run apps/backtester/test/<file>.test.ts`. Full gate (used before merge): `pnpm test`.
- Cache size config: env `TAPE_CACHE_MAX_ENTRIES` (default `16`); `0` disables caching.

---

## File Structure

- **Create** `apps/backtester/src/data/tape-cache.ts` — `tapeCacheKey()`, `TapeCache<V>`, `readMaxEntries()`, and the two singletons. One responsibility: cross-run caching of materialized data.
- **Create** `apps/backtester/test/tape-cache.test.ts` — unit tests for the key and the cache logic.
- **Create** `apps/backtester/test/tape-cache-mutation-safety.test.ts` — regression test pinning the shared-array invariant on the momentum path.
- **Modify** `apps/backtester/src/jobs/worker.ts` — consult the singletons at both seams (overlay ~line 132; momentum ~lines 198–208).

---

### Task 1: Cache key function

**Files:**
- Create: `apps/backtester/src/data/tape-cache.ts`
- Test: `apps/backtester/test/tape-cache.test.ts`

**Interfaces:**
- Produces: `tapeCacheKey(parts: { datasetRef: string; symbols: readonly string[]; from: string | number; to: string | number; timeframe?: string }): string`

- [ ] **Step 1: Write the failing test**

Create `apps/backtester/test/tape-cache.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { tapeCacheKey } from '../src/data/tape-cache.js';

describe('tapeCacheKey', () => {
  it('is independent of symbol order', () => {
    const a = tapeCacheKey({ datasetRef: 'ds', symbols: ['BTC', 'ETH'], from: '1', to: '2', timeframe: '1m' });
    const b = tapeCacheKey({ datasetRef: 'ds', symbols: ['ETH', 'BTC'], from: '1', to: '2', timeframe: '1m' });
    expect(a).toBe(b);
  });

  it('distinguishes different windows', () => {
    const a = tapeCacheKey({ datasetRef: 'ds', symbols: ['BTC'], from: '1', to: '2' });
    const b = tapeCacheKey({ datasetRef: 'ds', symbols: ['BTC'], from: '1', to: '3' });
    expect(a).not.toBe(b);
  });

  it('distinguishes datasetRef and timeframe', () => {
    const base = { symbols: ['BTC'], from: '1', to: '2' } as const;
    expect(tapeCacheKey({ ...base, datasetRef: 'a' })).not.toBe(tapeCacheKey({ ...base, datasetRef: 'b' }));
    expect(tapeCacheKey({ ...base, datasetRef: 'a', timeframe: '1m' })).not.toBe(
      tapeCacheKey({ ...base, datasetRef: 'a', timeframe: '5m' }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/backtester/test/tape-cache.test.ts`
Expected: FAIL — cannot resolve `'../src/data/tape-cache.js'` / `tapeCacheKey` is not a function.

- [ ] **Step 3: Write minimal implementation**

Create `apps/backtester/src/data/tape-cache.ts`:

```ts
/** Build a stable cross-run cache key from the DATA dimensions of a run. Symbol order is normalized. */
export function tapeCacheKey(parts: {
  datasetRef: string;
  symbols: readonly string[];
  from: string | number;
  to: string | number;
  timeframe?: string;
}): string {
  const syms = [...parts.symbols].sort().join(',');
  return `${parts.datasetRef}|${parts.timeframe ?? ''}|${parts.from}|${parts.to}|${syms}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/backtester/test/tape-cache.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backtester/src/data/tape-cache.ts apps/backtester/test/tape-cache.test.ts
git commit -m "feat(data): tapeCacheKey — stable cross-run cache key

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: TapeCache (entry-count LRU) + config + singletons

**Files:**
- Modify: `apps/backtester/src/data/tape-cache.ts`
- Test: `apps/backtester/test/tape-cache.test.ts`

**Interfaces:**
- Consumes: `tapeCacheKey` (Task 1)
- Produces:
  - `class TapeCache<V> { constructor(maxEntries: number); getOrBuild(key: string, build: () => Promise<V>): Promise<V>; stats(): { hits: number; misses: number; size: number } }`
  - `readMaxEntries(): number`
  - `overlayTapeCache: TapeCache<MarketTapeDataset>`
  - `momentumTapeCache: TapeCache<MaterializedDataset>`

- [ ] **Step 1: Write the failing tests**

Append to `apps/backtester/test/tape-cache.test.ts`:

```ts
import { TapeCache, readMaxEntries } from '../src/data/tape-cache.js';
import { vi } from 'vitest';

describe('TapeCache', () => {
  it('builds once on miss and serves the cached value on hit', async () => {
    const cache = new TapeCache<number>(16);
    const build = vi.fn(async () => 42);
    expect(await cache.getOrBuild('k', build)).toBe(42);
    expect(await cache.getOrBuild('k', build)).toBe(42);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('de-duplicates concurrent builds for the same key', async () => {
    const cache = new TapeCache<number>(16);
    let resolve!: (v: number) => void;
    const build = vi.fn(() => new Promise<number>((r) => { resolve = r; }));
    const p1 = cache.getOrBuild('k', build);
    const p2 = cache.getOrBuild('k', build);
    resolve(7);
    expect(await p1).toBe(7);
    expect(await p2).toBe(7);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('evicts the least-recently-used entry beyond maxEntries', async () => {
    const cache = new TapeCache<string>(2);
    const bA = vi.fn(async () => 'A');
    const bB = vi.fn(async () => 'B');
    const bC = vi.fn(async () => 'C');
    await cache.getOrBuild('a', bA);          // [a]
    await cache.getOrBuild('b', bB);          // [a,b]
    await cache.getOrBuild('a', bA);          // hit a -> order [b,a]
    await cache.getOrBuild('c', bC);          // miss c -> evict LRU 'b' -> [a,c]
    await cache.getOrBuild('b', bB);          // 'b' was evicted -> rebuild
    expect(bB).toHaveBeenCalledTimes(2);
    await cache.getOrBuild('a', bA);          // 'a' still cached
    expect(bA).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed build; the next call retries', async () => {
    const cache = new TapeCache<number>(16);
    const build = vi.fn<[], Promise<number>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(5);
    await expect(cache.getOrBuild('k', build)).rejects.toThrow('boom');
    expect(await cache.getOrBuild('k', build)).toBe(5);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('bypasses caching when maxEntries is 0', async () => {
    const cache = new TapeCache<number>(0);
    const build = vi.fn(async () => 1);
    await cache.getOrBuild('k', build);
    await cache.getOrBuild('k', build);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('reports hit/miss/size stats', async () => {
    const cache = new TapeCache<number>(16);
    const build = vi.fn(async () => 1);
    await cache.getOrBuild('k', build); // miss
    await cache.getOrBuild('k', build); // hit
    expect(cache.stats()).toEqual({ hits: 1, misses: 1, size: 1 });
  });
});

describe('readMaxEntries', () => {
  it('defaults to 16 when unset', () => {
    delete process.env.TAPE_CACHE_MAX_ENTRIES;
    expect(readMaxEntries()).toBe(16);
  });
  it('parses an explicit value', () => {
    process.env.TAPE_CACHE_MAX_ENTRIES = '4';
    expect(readMaxEntries()).toBe(4);
    delete process.env.TAPE_CACHE_MAX_ENTRIES;
  });
  it('accepts 0 (disabled)', () => {
    process.env.TAPE_CACHE_MAX_ENTRIES = '0';
    expect(readMaxEntries()).toBe(0);
    delete process.env.TAPE_CACHE_MAX_ENTRIES;
  });
  it('falls back to 16 on garbage', () => {
    process.env.TAPE_CACHE_MAX_ENTRIES = 'nope';
    expect(readMaxEntries()).toBe(16);
    delete process.env.TAPE_CACHE_MAX_ENTRIES;
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/backtester/test/tape-cache.test.ts`
Expected: FAIL — `TapeCache` / `readMaxEntries` not exported.

- [ ] **Step 3: Write the implementation**

Append to `apps/backtester/src/data/tape-cache.ts`:

```ts
import type { MarketTapeDataset } from '../engine/market-tape.js';
import type { MaterializedDataset } from './reader.js';

/**
 * In-process, entry-count LRU cache for materialized tape/dataset objects.
 *
 * - Stores the in-flight Promise, so concurrent callers for the same key share one build.
 * - Never caches a rejected build: a failed entry is evicted so the next call retries.
 * - Evicts the least-recently-used entry once `size > maxEntries`.
 * - `maxEntries <= 0` disables caching (every call builds).
 *
 * The cached objects are shared, not cloned — they are immutable for their consumers.
 */
export class TapeCache<V> {
  private readonly entries = new Map<string, Promise<V>>();
  private hits = 0;
  private misses = 0;

  constructor(private readonly maxEntries: number) {}

  getOrBuild(key: string, build: () => Promise<V>): Promise<V> {
    if (this.maxEntries <= 0) {
      this.misses++;
      return build();
    }
    const existing = this.entries.get(key);
    if (existing) {
      this.hits++;
      // mark most-recently-used
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing;
    }
    this.misses++;
    const pending = build();
    this.entries.set(key, pending);
    // do not cache rejections — drop the entry so the next call retries
    pending.catch(() => {
      if (this.entries.get(key) === pending) this.entries.delete(key);
    });
    // evict LRU if over capacity
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return pending;
  }

  stats(): { hits: number; misses: number; size: number } {
    return { hits: this.hits, misses: this.misses, size: this.entries.size };
  }
}

/** Read `TAPE_CACHE_MAX_ENTRIES` (default 16; 0 disables; garbage falls back to 16). */
export function readMaxEntries(): number {
  const raw = process.env.TAPE_CACHE_MAX_ENTRIES;
  if (raw === undefined || raw === '') return 16;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 16;
}

/** Long-lived singletons — persist across runs for the life of the worker process. */
export const overlayTapeCache = new TapeCache<MarketTapeDataset>(readMaxEntries());
export const momentumTapeCache = new TapeCache<MaterializedDataset>(readMaxEntries());
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/backtester/test/tape-cache.test.ts`
Expected: PASS (all key + cache + config tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (confirms the `import type` engine references resolve and the generics line up).

- [ ] **Step 6: Commit**

```bash
git add apps/backtester/src/data/tape-cache.ts apps/backtester/test/tape-cache.test.ts
git commit -m "feat(data): TapeCache entry-count LRU + singletons

In-flight de-dup, no-cache-on-failure, env-configurable bound. Engine type
imported type-only to keep the data path runtime-independent of src/engine.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Wire the cache into both worker seams

**Files:**
- Modify: `apps/backtester/src/jobs/worker.ts` (overlay ~line 132; momentum ~lines 198–208; plus one import)

**Interfaces:**
- Consumes: `overlayTapeCache`, `momentumTapeCache`, `tapeCacheKey` (Task 2)

This task is behavior-preserving — the engine and runners are untouched. Its test is that existing goldens do not move.

- [ ] **Step 1: Add the import**

In `apps/backtester/src/jobs/worker.ts`, add to the imports:

```ts
import { overlayTapeCache, momentumTapeCache, tapeCacheKey } from '../data/tape-cache.js';
```

- [ ] **Step 2: Wrap the overlay seam**

Replace the overlay construction (currently `worker.ts:132-137`):

```ts
      const marketTape = await buildOverlayDataset(deps.dataPort, {
        datasetRef: r.datasetRef,
        symbols: r.symbols,
        timeframe: r.timeframe,
        period: r.period,
      });
```

with:

```ts
      const marketTape = await overlayTapeCache.getOrBuild(
        tapeCacheKey({
          datasetRef: r.datasetRef,
          symbols: r.symbols,
          timeframe: r.timeframe,
          from: r.period.from,
          to: r.period.to,
        }),
        () =>
          buildOverlayDataset(deps.dataPort, {
            datasetRef: r.datasetRef,
            symbols: r.symbols,
            timeframe: r.timeframe,
            period: r.period,
          }),
      );
```

- [ ] **Step 3: Wrap the momentum seam (move `openDataset` into the builder)**

Replace the momentum construction (currently `worker.ts:198-208`):

```ts
      const reader = await deps.dataPort.openDataset(claimed.datasetRef);
      if (!reader) {
        throw new RunnerError('missing_dataset', `unknown dataset: ${claimed.datasetRef}`);
      }

      const { tsFrom, tsTo } = periodMs(claimed.request.period);
      const dataset = await materialize(reader, claimed.datasetRef, {
        tsFrom,
        tsTo,
        symbols: claimed.request.symbols,
      });
```

with:

```ts
      const { tsFrom, tsTo } = periodMs(claimed.request.period);
      const dataset = await momentumTapeCache.getOrBuild(
        tapeCacheKey({
          datasetRef: claimed.datasetRef,
          symbols: claimed.request.symbols,
          from: tsFrom,
          to: tsTo,
        }),
        async () => {
          const reader = await deps.dataPort.openDataset(claimed.datasetRef);
          if (!reader) {
            throw new RunnerError('missing_dataset', `unknown dataset: ${claimed.datasetRef}`);
          }
          return materialize(reader, claimed.datasetRef, {
            tsFrom,
            tsTo,
            symbols: claimed.request.symbols,
          });
        },
      );
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Prove no behavior drift — momentum & overlay goldens**

Run: `npx vitest run apps/backtester/test/momentum-guardrail.test.ts apps/backtester/test/determinism.test.ts apps/backtester/test/overlay-golden.test.ts`
Expected: PASS — momentum `result_hash` still equals `sha256:eff10116…`; overlay golden unchanged.

- [ ] **Step 6: Commit**

```bash
git add apps/backtester/src/jobs/worker.ts
git commit -m "feat(worker): serve materialized tape/dataset from the cross-run cache

Both seams in processNextQueued now go through getOrBuild; momentum opens the
reader inside the builder so a cache hit skips openDataset too. Behavior-
preserving — momentum and overlay goldens unchanged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Mutation-safety regression test (momentum shared-array invariant)

**Files:**
- Test: `apps/backtester/test/tape-cache-mutation-safety.test.ts`

**Interfaces:**
- Consumes: `FixtureDataPort`, `materialize` from `src/data/reader`; `runBacktest` from `src/runner/run-backtest` (both engine-independent — this test must not import `src/engine/**`).

- [ ] **Step 1: Write the test**

Create `apps/backtester/test/tape-cache-mutation-safety.test.ts`:

```ts
// Pins the cache's "share, don't clone" invariant: the momentum runner must not mutate the candle
// arrays it reads, so a single cached MaterializedDataset can safely serve many runs. Engine-
// independent on purpose (imports only the legacy runner + fixture data port), mirroring the
// momentum-guardrail setup.

import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BacktestRunRequest } from '@trading/research-contracts';
import { FixtureDataPort, materialize } from '../src/data/reader.js';
import { runBacktest } from '../src/runner/run-backtest.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(HERE, '../fixtures/candles');

const REQ: BacktestRunRequest = {
  runId: 'mut-run',
  mode: 'research',
  moduleRef: { id: 'smoke', version: '1.0.0' },
  datasetRef: 'smoke-btc-1m',
  symbols: ['BTCUSDT'],
  timeframe: '1m',
  period: { from: '2023-11-14T00:00:00.000Z', to: '2023-11-15T00:00:00.000Z' },
  seed: 42,
  metrics: [],
};

async function loadDataset() {
  const port = new FixtureDataPort(FIXTURES_DIR);
  const reader = await port.openDataset('smoke-btc-1m');
  if (!reader) throw new Error('fixture missing');
  return materialize(reader, 'smoke-btc-1m', {
    tsFrom: 0,
    tsTo: Number.MAX_SAFE_INTEGER,
    symbols: ['BTCUSDT'],
  });
}

describe('momentum candle arrays are not mutated by the runner (cache share invariant)', () => {
  it('leaves the shared candle array reference- and content-identical after a run', async () => {
    const dataset = await loadDataset();
    const beforeRef = dataset.candles('BTCUSDT');
    const beforeLen = beforeRef.length;
    const beforeJson = JSON.stringify(beforeRef);

    await runBacktest(REQ, { dataset });

    const after = dataset.candles('BTCUSDT');
    expect(after).toBe(beforeRef); // same array instance — not replaced
    expect(after.length).toBe(beforeLen); // no push/pop/splice
    expect(JSON.stringify(after)).toBe(beforeJson); // no in-place field edits or re-sort
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run apps/backtester/test/tape-cache-mutation-safety.test.ts`
Expected: PASS — confirms the runner reads the candle arrays without mutating them.

- [ ] **Step 3: Full gate**

Run: `pnpm test`
Expected: PASS (entire suite, including the new tests and the unchanged goldens).

- [ ] **Step 4: Commit**

```bash
git add apps/backtester/test/tape-cache-mutation-safety.test.ts
git commit -m "test(data): pin momentum shared-array invariant for tape cache

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage**
- In-memory L1, thin interface, no Redis → `TapeCache` + singletons (Task 2). ✓
- Key `datasetRef + symbols + timeframe + window`, kinds/version dropped, symbol-order-normalized → `tapeCacheKey` (Task 1). ✓
- Entry-count LRU, env-config, `0` disables → `TapeCache` + `readMaxEntries` (Task 2). ✓
- Share-don't-clone; in-flight de-dup; failures not cached → `TapeCache` semantics + tests (Task 2). ✓
- Two separate seams wired; momentum opens reader inside builder → Task 3. ✓
- Observability hit/miss/size counters → `TapeCache.stats()` (Task 2). ✓
- Momentum read-only invariant pinned by a regression test → Task 4. ✓
- Goldens must not move → Task 3 Step 5 + Task 4 Step 3. ✓

**2. Placeholder scan:** No TBD/TODO; every code/test/command step is concrete. ✓

**3. Type consistency:** `tapeCacheKey` signature is identical across Tasks 1 and 3 call sites; `getOrBuild(key, build)`, `stats()`, `readMaxEntries()` names match between Task 2 definition and Task 3 usage; `overlayTapeCache`/`momentumTapeCache` names consistent. ✓

## Notes / deferred (per spec, not built here)

- Persistent L2 (Redis) behind `getOrBuild`; would add `materializerVersion` to the key and cache raw rows. Not built.
- Periodic logging of `stats()` from the worker — trivial follow-up; the counters exist now, no forced log wired to avoid coupling to a specific logger.
