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

/**
 * СИНХРОННОЕ ядро batch-итерации — для isolate-бэкенда (analysis/18 loop-in-isolate).
 * Семантика байт-в-байт с runHookBatch на sync-хуках (push-before-invoke, стоп на непустом
 * решении, err с barOffset); НЕТ await: внутри V8-изолята каждый await гоняет promise-машинерию
 * isolated-vm через host event loop (~мс/бар), sync-цикл исполняется нативно. Async-хуки —
 * забота вызывающего (isolate-entry оборачивает pickHook sync-гардом, бросающим на thenable).
 */
export function runHookBatchSync(bars, hook, deps) {
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
        out = normalize(fn.call(instance, ctx));
      } catch (e) {
        return { kind: 'err', barOffset: j, cause: e }; // bars 0..j-1 completed
      }
    }
    // {kind:'idle'} ≡ пустой выход (runner: firstDecision([]) === {kind:'idle'}) — НЕ рвать батч:
    // реальные бандлы всегда отдают явный idle-объект, и стоп на нём вырождает батч в per-bar
    // (исторический «17b медленнее» — ровно это). Прерываемся только на содержательном решении.
    const meaningful = out.length > 0 && !out.every((d) => d !== null && typeof d === 'object' && d.kind === 'idle');
    if (meaningful) return { kind: 'ok', stoppedAt: j, decisions: out };
  }
  return { kind: 'ok', stoppedAt: bars.length - 1, decisions: [] };
}
