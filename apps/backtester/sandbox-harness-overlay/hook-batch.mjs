// Pure batch iteration (17b) — shared by entry.mjs and host-side unit tests. `deps` carries the
// harness's live closures so this file owns NO module state.
// deps: { buffer, oiBuffer, liqBuffer, rng, instance, rehydrateContext, pickHook, normalize }
export async function runHookBatch(bars, hook, deps) {
  const { buffer, oiBuffer, liqBuffer, rng, instance, rehydrateContext, pickHook, normalize } = deps;
  for (let j = 0; j < bars.length; j += 1) {
    const { snapshot, newBar, newOi, newLiq } = bars[j];
    if (newBar !== null && newBar !== undefined) buffer.push(newBar);
    if (newOi !== undefined) oiBuffer.push(newOi);
    if (newLiq !== undefined) liqBuffer.push(newLiq);
    const ctx = rehydrateContext(snapshot, buffer, rng, oiBuffer, liqBuffer);
    const fn = pickHook(hook);
    let out = [];
    if (fn !== undefined) {
      try {
        out = normalize(await fn.call(instance, ctx));
      } catch (e) {
        return { kind: 'err', barOffset: j, cause: e }; // bars 0..j-1 completed
      }
    }
    if (out.length > 0) return { kind: 'ok', stoppedAt: j, decisions: out };
  }
  return { kind: 'ok', stoppedAt: bars.length - 1, decisions: [] };
}
