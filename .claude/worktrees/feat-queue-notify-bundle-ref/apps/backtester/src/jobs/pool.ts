/**
 * Run `next` across up to `concurrency` concurrent slots until it returns false (queue drained).
 * Each slot loops independently; a slot exits when its `next()` resolves false. Returns the total
 * number of truthy `next()` results. `concurrency` is clamped to `>= 1` (non-finite -> 1).
 *
 * Uses allSettled so one slot's throw cannot abandon sibling runs mid-flight; the first error is
 * surfaced after all slots settle.
 */
export async function runBoundedPool(
  concurrency: number,
  next: () => Promise<boolean>,
): Promise<number> {
  const slots = Math.max(1, Math.floor(concurrency)) || 1;
  let processed = 0;
  const worker = async (): Promise<void> => {
    while (await next()) processed += 1;
  };
  const results = await Promise.allSettled(Array.from({ length: slots }, () => worker()));
  const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failure) throw failure.reason;
  return processed;
}
