// A minimal insertion-order LRU over a Map (Map preserves insertion order, so the first key is always
// the least-recently-used). `get` on a hit and `set` on an existing key promote the entry to
// most-recently-used; `set` beyond capacity evicts the oldest. Used by the SDK client's bundle-bytes
// cache to bound memory while keeping the recently-put bundles the 409 self-heal needs.

export class LruCache<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`LruCache capacity must be a positive integer, got ${capacity}`);
    }
  }

  get size(): number {
    return this.map.size;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  /** Returns the value and promotes the key to most-recently-used, or undefined on a miss. */
  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key)!;
    this.map.delete(key); // re-insert to move to the most-recent position
    this.map.set(key, value);
    return value;
  }

  /** Inserts/refreshes the entry as most-recently-used, evicting the LRU entry if over capacity. */
  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key); // refresh: drop the stale position first
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      const lruKey = this.map.keys().next().value as K; // oldest = least-recently-used
      this.map.delete(lruKey);
    }
  }
}
