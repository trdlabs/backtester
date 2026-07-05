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
}

export class InMemoryResultCache implements ResultCache {
  private readonly rows = new Map<string, CacheEntry>();
  async lookup(computeIdentity: string): Promise<CacheEntry | undefined> {
    return this.rows.get(computeIdentity);
  }
  async put(entry: CacheEntry): Promise<void> {
    if (!this.rows.has(entry.computeIdentity)) this.rows.set(entry.computeIdentity, entry);
  }
}
