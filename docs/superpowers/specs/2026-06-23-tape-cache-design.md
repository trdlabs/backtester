# Cross-run tape cache (Feature 8 / perf #1) — Design

**Date:** 2026-06-23
**Status:** Approved (brainstorming), pending spec review
**Branch:** `feat/tape-cache`

## Problem

Every backtest run re-materializes its market data into a method-bearing
tape/dataset object before the engine runs. On native Linux this costs
~135 ms cold-start per symbol (measured, see Feature 8 bench). For workloads
that reuse the same data slice — multiple strategies on one symbol/window, and
especially parameter sweeps — this materialization is repeated identically on
every run with no benefit.

A parameter sweep is the ideal case: sweep points vary only **strategy**
parameters, never **data** parameters, so all N runs of a sweep rebuild the
exact same tape. The win is to materialize once per distinct data slice and
reuse the resulting object across runs.

## Scope / non-goals

In scope: an in-process, cross-run cache of the materialized tape/dataset,
behind a thin interface, for the single long-lived worker process.

Explicitly out (YAGNI, with rationale):

- **Redis / L2 / any shared store** — current topology is a single long-lived
  worker; no multi-replica and no warm-across-restart requirement in the
  foreseeable future. The interface leaves room to add L2 later without
  rewriting the engine.
- **TTL / staleness handling** — exchange data is downloaded and stored
  immutably; a closed `(symbol, tf, window)` slice never changes.
- **Byte-budget eviction** — working set is bounded by the number of distinct
  data slices (not run count), which is small; entry-count LRU suffices.
- **`materializerVersion` in the key** — an L1 cache lives and dies with the
  process, and a single process runs exactly one code version, so the
  materializer never changes within a cache's lifetime. (This becomes
  necessary only if/when a persistent L2 is added, and would be added with it.)
- **Deep-freezing the momentum candle arrays** — verified read-only by
  consumers today; protected by a regression test instead.

## Key facts (grounded in code)

- The worker is a single long-lived process: `app.ts` runs `setInterval(tick,
  200)` → `drainQueue`, started once in `index.ts`. A module-level cache
  therefore persists across runs.
- Two **separate** materialization seams inside `processNextQueued`
  (`apps/backtester/src/jobs/worker.ts`), reached via a mutually exclusive
  `if (engine === 'overlay')`:
  - Overlay: `worker.ts:132` → `buildOverlayDataset(deps.dataPort, {...})`
    (`engine/data-adapter.ts:61`) → `marketTapeFromCanonicalRows`
    (`engine/market-tape.ts`), returns `MarketTapeDataset`.
  - Momentum: `worker.ts:204` → `materialize(reader, datasetRef, {...})`
    (`data/reader.ts:116`), returns `MaterializedDataset`.
- The two return **different types**, so they cannot share cache entries.
- **Mutation safety: confirmed safe to share one instance across runs.** Both
  objects are effectively immutable value containers with no internal
  cursor/position. The overlay path freezes bars and snapshots. The momentum
  path's candle arrays are not frozen but are never mutated by the runner
  (`runner/run-backtest.ts` reads by index only). No clone needed on read.

## Design

### 1. Module and instances

New module `apps/backtester/src/data/tape-cache.ts` exposing a generic
entry-count LRU:

```ts
class TapeCache<V> {
  constructor(maxEntries: number)
  getOrBuild(key: string, build: () => Promise<V>): Promise<V>
}
```

Two module-level singletons (persist for the life of the worker process):

- `overlayTapeCache: TapeCache<MarketTapeDataset>`
- `momentumTapeCache: TapeCache<MaterializedDataset>`

Engine separation is **structural** (two typed instances), not encoded in the
key string. This is the thin seam for a future L2: a second tier can be added
inside `getOrBuild` without touching the worker.

### 2. Cache key

A pure key function builds a stable string per path. Because the two paths use
**separate instances**, their key shapes may differ; there is no
cross-instance collision risk.

- Overlay key: `datasetRef | timeframe | from | to | sym1,sym2,…`
  (window from the ISO-8601 half-open `period` `[from, to)`).
- Momentum key: `datasetRef | tsFrom | tsTo | sym1,sym2,…`
  (window in epoch-ms `tsFrom/tsTo`; `timeframe` is implied by `datasetRef` on
  this path and is omitted).

Rules for both:

- `symbols` are sorted before joining (request order must not affect the key).
- `kinds` are **not** in the key: on the overlay path they are derived from the
  data itself (composition-following over per-row `has_*` flags), i.e. they are
  a deterministic function of `(datasetRef, symbols, tf, window)`.

### 3. Eviction — entry-count LRU

Backed by a `Map` (insertion-ordered):

- Hit: `delete` then `set` to mark most-recently-used.
- Miss: build, `set`; if `size > maxEntries`, delete the oldest (first) entry.

`maxEntries` is read from env `TAPE_CACHE_MAX_ENTRIES` (default **16**).
`TAPE_CACHE_MAX_ENTRIES=0` disables caching (every call builds) as a
debug/safety valve.

### 4. Correctness semantics

- **Share, don't clone.** Confirmed immutable; no per-run state on the object.
- **In-flight de-duplication.** The `Map` stores the **Promise**, not the
  resolved value. Two concurrent callers for the same key await the same build
  (no thundering herd if the worker ever becomes concurrent).
- **Failures are not cached.** If `build()` rejects, the pending entry is
  removed and the error propagates; the next call retries.
- **Momentum read-only invariant.** The momentum candle arrays are shared
  unfrozen; the runner must not mutate them. Pinned by a regression test.

### 5. Data flow (worker.ts change)

```
processNextQueued:
  key = tapeCacheKey({ ...request })
  overlay:  marketTape = await overlayTapeCache.getOrBuild(
              key, () => buildOverlayDataset(deps.dataPort, {...}))
  momentum: dataset    = await momentumTapeCache.getOrBuild(
              key, () => materialize(reader, datasetRef, {...}))
  // remainder of the run is unchanged
```

Two lines per call site; the engine and runners are untouched.

### 6. Observability

Lightweight hit/miss counters logged from the cache, to confirm the cache
actually fires in real workloads.

## Testing (TDD)

- Key: stability for identical inputs; independence from symbol order.
- `getOrBuild`: a miss builds exactly once; a subsequent hit returns the cached
  value without rebuilding (assert builder call count via spy).
- LRU: exceeding `maxEntries` evicts the least-recently-used entry.
- In-flight de-dup: two concurrent same-key calls invoke the builder once.
- A rejected build is not cached; the next call retries.
- `TAPE_CACHE_MAX_ENTRIES=0` bypasses the cache (always builds).
- Integration (the actual payoff): two runs over the same data slice call
  `buildOverlayDataset` exactly once.
- Regression: momentum candle arrays are not mutated by the runner.

## Future extension (not built now)

A persistent L2 (e.g. Redis) can slot in behind `getOrBuild` if the topology
ever changes (multiple worker replicas, or warm cache across restarts). At that
point the key must additionally encode a materializer version, and the L2 must
cache raw rows and rebuild the method-bearing tape on read.
