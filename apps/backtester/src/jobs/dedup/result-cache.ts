export interface CacheEntry {
  readonly computeIdentity: string;
  readonly requestFingerprint: string;
  readonly datasetFingerprint: string;
  readonly computeVersion: string;
  readonly sandboxPolicyVersion: string;
  readonly templateRef: string;
  readonly createdAtMs: number;
}

export interface ResultCache {
  lookup(computeIdentity: string): Promise<CacheEntry | undefined>;
  /** Idempotent: first writer wins (identical content anyway). */
  put(entry: CacheEntry): Promise<void>;
  /** P3-6b: TTL eviction — DELETE up to `batchLimit` entries older than the TTL (createdAtMs <
   *  nowMs - ttlMs), oldest first. Removes ONLY cache rows; the content-addressed artifacts they point
   *  at (templateRef) are NOT touched (artifact GC is a separate reachability/retention concern).
   *  No refresh-on-hit: eviction is from the original createdAtMs. Returns the count. */
  sweepExpired(nowMs: number, ttlMs: number, batchLimit: number): Promise<number>;
}

export class InMemoryResultCache implements ResultCache {
  private readonly rows = new Map<string, CacheEntry>();
  async lookup(computeIdentity: string): Promise<CacheEntry | undefined> {
    return this.rows.get(computeIdentity);
  }
  async put(entry: CacheEntry): Promise<void> {
    if (!this.rows.has(entry.computeIdentity)) this.rows.set(entry.computeIdentity, entry);
  }

  async sweepExpired(nowMs: number, ttlMs: number, batchLimit: number): Promise<number> {
    const threshold = nowMs - ttlMs;
    const expired = [...this.rows.values()]
      .filter((e) => e.createdAtMs < threshold)
      .sort((a, b) => a.createdAtMs - b.createdAtMs) // oldest first — mirrors the Pg ORDER BY … LIMIT
      .slice(0, Math.max(0, batchLimit));
    for (const e of expired) this.rows.delete(e.computeIdentity);
    return expired.length;
  }
}
