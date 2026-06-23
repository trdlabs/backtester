/**
 * Run `next` across up to `concurrency` concurrent slots until it returns false (queue drained).
 * Each slot loops independently; a slot exits when its `next()` resolves false. Returns the total
 * number of truthy `next()` results. `concurrency` is clamped to `>= 1`.
 */
export async function runBoundedPool(
  concurrency: number,
  next: () => Promise<boolean>,
): Promise<number> {
  const slots = Math.max(1, Math.floor(concurrency));
  let processed = 0;
  const worker = async (): Promise<void> => {
    while (await next()) processed += 1;
  };
  await Promise.all(Array.from({ length: slots }, () => worker()));
  return processed;
}
