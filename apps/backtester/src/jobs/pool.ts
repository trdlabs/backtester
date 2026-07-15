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
  // #138 §3: a slot that throws flips `stopped`, so sibling slots stop pulling NEW work after their
  // current in-flight run (allSettled still awaits them — no run is abandoned mid-flight). Under a
  // sustained queue this lets the pool RETURN promptly on the first error instead of blocking until the
  // siblings drain an unbounded queue, so the caller (runWorkerLoop's try/catch + bounded backoff) can
  // back off and rebuild full concurrency rather than silently running a slot short until the queue empties.
  let stopped = false;
  const worker = async (): Promise<void> => {
    while (!stopped && (await next())) processed += 1;
  };
  const results = await Promise.allSettled(
    Array.from({ length: slots }, () =>
      worker().catch((err: unknown) => {
        stopped = true;
        throw err;
      }),
    ),
  );
  const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failure) throw failure.reason;
  return processed;
}
