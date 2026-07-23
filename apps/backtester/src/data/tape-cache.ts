import type { MarketTapeDataset } from '@trading/research-contracts/research';
import { readEnvVar } from '../env.js';
import type { MaterializedDataset } from './reader.js';

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

/**
 * In-process, entry-count LRU cache for materialized tape/dataset objects.
 *
 * Ordering: MRU is at the front of the Map, LRU is at the back.
 * - Cache hits promote an entry to the front (MRU).
 * - New builds are inserted at the back (LRU) — they start cold; a subsequent
 *   hit will promote them. This ensures a hit entry is always preferred over a
 *   freshly-built entry when eviction is needed.
 * - Eviction removes the last entry (LRU) before a new build is stored.
 * - Stores the in-flight Promise so concurrent callers share one build.
 * - Never caches a rejected build: the entry is evicted so the next call retries.
 * - `maxEntries <= 0` disables caching (every call builds).
 *
 * The cached objects are shared, not cloned — they are immutable for their consumers.
 */
export class TapeCache<V> {
  /** Map iteration order: front = MRU, back = LRU. */
  private entries = new Map<string, Promise<V>>();
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
      // promote to MRU (front): rebuild map with this key first
      this.entries.delete(key);
      const promoted = new Map<string, Promise<V>>();
      promoted.set(key, existing);
      for (const [k, v] of this.entries) promoted.set(k, v);
      this.entries = promoted;
      return existing;
    }
    this.misses++;
    // evict LRU (back/last entry) before inserting if already at capacity
    if (this.entries.size >= this.maxEntries) {
      let lruKey: string | undefined;
      for (lruKey of this.entries.keys()) { /* iterate to last */ }
      if (lruKey !== undefined) this.entries.delete(lruKey);
    }
    const pending = build();
    // insert at LRU end (back): new builds start cold
    this.entries.set(key, pending);
    // do not cache rejections — drop the entry so the next call retries
    pending.catch(() => {
      if (this.entries.get(key) === pending) this.entries.delete(key);
    });
    return pending;
  }

  stats(): { hits: number; misses: number; size: number } {
    return { hits: this.hits, misses: this.misses, size: this.entries.size };
  }

  /** Test-only: empties all entries so the next `getOrBuild` for any key is a cold miss. */
  clear(): void {
    this.entries.clear();
  }
}

/** Read `TAPE_CACHE_MAX_ENTRIES` (default 16; 0 disables; garbage falls back to 16). */
export function readMaxEntries(): number {
  const raw = readEnvVar('TAPE_CACHE_MAX_ENTRIES');
  if (raw === undefined || raw === '') return 16;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 16;
}

/** Long-lived singletons — persist across runs for the life of the worker process. */
export const overlayTapeCache = new TapeCache<MarketTapeDataset>(readMaxEntries());
export const momentumTapeCache = new TapeCache<MaterializedDataset>(readMaxEntries());

/**
 * Test-only: empties both singleton caches so a subsequent `getOrBuild` call for either cache is
 * guaranteed to miss and rebuild. Needed by tests that must prove two nominally-"identical" requests
 * each independently exercise the real data-fetch/build path rather than the second one silently
 * short-circuiting on the shared in-memory object from the first (the singletons persist across
 * separate `buildApp()` calls within the same worker process — `app.dispose()` does not touch them).
 */
export function __resetTapeCachesForTest(): void {
  overlayTapeCache.clear();
  momentumTapeCache.clear();
}
