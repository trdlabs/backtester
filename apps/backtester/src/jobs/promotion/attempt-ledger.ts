// E4b — promotion attempt ledger. Atomic monotonic numbering per epoch; dedupe by (epoch, attemptIdentity).
export interface PromotionAttemptRecord {
  readonly qualificationEpochKey: string;
  readonly attemptIdentity: string;
  readonly requestFingerprint: string;
  readonly datasetFingerprint: string;
  readonly runId: string;
  readonly resultHash: string;
  readonly verdict: 'passed' | 'failed';
  readonly createdAtMs: number;
}
export interface PromotionAttemptLedger {
  recordIfNewAndGetAttempt(r: PromotionAttemptRecord): Promise<{ attemptNumber: number; inserted: boolean }>;
}

export class InMemoryPromotionAttemptLedger implements PromotionAttemptLedger {
  private readonly next = new Map<string, number>();                 // epochKey → next attempt
  private readonly attempts = new Map<string, number>();             // `${epochKey}\0${attemptIdentity}` → number
  async recordIfNewAndGetAttempt(r: PromotionAttemptRecord): Promise<{ attemptNumber: number; inserted: boolean }> {
    const key = `${r.qualificationEpochKey}\0${r.attemptIdentity}`;
    const existing = this.attempts.get(key);
    if (existing !== undefined) return { attemptNumber: existing, inserted: false };
    const n = this.next.get(r.qualificationEpochKey) ?? 1;
    this.attempts.set(key, n);
    this.next.set(r.qualificationEpochKey, n + 1);
    return { attemptNumber: n, inserted: true };
  }
}
