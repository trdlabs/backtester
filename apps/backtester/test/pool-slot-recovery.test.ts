// #138 §3 — runBoundedPool used Promise.allSettled, so under concurrency > 1 a single slot throwing was
// masked until EVERY slot settled. With a sustained queue the sibling slots drain forever, allSettled
// never resolves, runWorkerLoop's outer catch/backoff never fires, and the failed slot is not recovered
// until the queue empties. A slot failure must instead cooperatively stop sibling pulls so the pool
// returns promptly and the caller (the loop's try/catch + bounded backoff) can restart full concurrency.
import { describe, expect, it } from 'vitest';
import { runBoundedPool } from '../src/jobs/pool.js';

describe('runBoundedPool — a slot failure returns promptly even under an unbounded sibling drain', () => {
  it('does not hang when one slot throws while another has a never-empty queue', async () => {
    let calls = 0;
    const next = async (): Promise<boolean> => {
      calls += 1;
      if (calls === 1) throw new Error('slot down'); // the first pull fails (one transient slot error)
      return true; // every other pull finds work ⇒ a sibling would otherwise drain forever
    };
    // Pre-fix: allSettled + an infinite sibling ⇒ the pool never resolves (this times out). It must
    // surface the error promptly instead, so the loop can back off and rebuild concurrency.
    await expect(runBoundedPool(2, next)).rejects.toThrow('slot down');
  }, 2_000);

  it('still surfaces a slot error at concurrency 1 (unchanged single-slot behavior)', async () => {
    const next = async (): Promise<boolean> => { throw new Error('boom'); };
    await expect(runBoundedPool(1, next)).rejects.toThrow('boom');
  }, 2_000);
});
