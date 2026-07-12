// Slice B — pure per-symbol iteration for a single hookBarMajor envelope, shared by entry.mjs and
// host-side unit tests. `bars[i]` is a HookBatchEntry (snapshot/newBar/newOi/newLiq) for symbol i
// of the SAME bar; each entry's own `snapshot.symbol` is the routing key into `store` (multi-symbol
// message — do NOT reuse the single-symbol `symbolOf(msg)` helper here).
//
// SEQUENTIAL, index order, NEVER Promise.all: the perf win is collapsing N hooks into ONE IPC
// round-trip, not running them concurrently — running them out of order (or concurrently) would
// make cross-symbol side effects (shared instance state, rng draws, log ordering) nondeterministic.
//
// Each entry is caught independently: a missing store slot OR a thrown/rejected hook for entry i
// yields a tagged `{ok:false,error:{code,detail}}` for THAT entry only; every other entry still
// runs. Mirrors hook-batch.mjs's runHookBatch async/await-per-entry shape (onBarClose is awaited,
// so an async hook is supported) — but where runHookBatch iterates N bars for ONE symbol/slot, this
// iterates N symbols (one store slot per entry) for ONE bar.
export async function runHookBarMajor(bars, hook, store, { rehydrateContext, normalize, pickHook }) {
  const results = [];
  for (let i = 0; i < bars.length; i += 1) {
    const entry = bars[i];
    const symbol = entry.snapshot && entry.snapshot.symbol;
    const slot = store.get(symbol);
    if (slot === undefined) {
      results.push({
        ok: false,
        error: { code: 'sandbox_output_malformed', detail: `hookBarMajor before init for symbol ${String(symbol)}` },
      });
      continue;
    }
    try {
      if (entry.newBar !== null && entry.newBar !== undefined) slot.buffer.push(entry.newBar);
      if (entry.newOi !== undefined) slot.oiBuffer.push(entry.newOi);
      if (entry.newLiq !== undefined) slot.liqBuffer.push(entry.newLiq);
      const ctx = rehydrateContext(entry.snapshot, slot.buffer, slot.rng, slot.oiBuffer, slot.liqBuffer);
      const fn = pickHook(slot.instance, hook);
      if (fn === undefined) {
        results.push({ ok: true, decisions: [] }); // missing hook → empty result, mirrors handleHook
        continue;
      }
      const out = await fn.call(slot.instance, ctx);
      results.push({ ok: true, decisions: normalize(out) });
    } catch (e) {
      results.push({ ok: false, error: { code: classifyOrCrashed(e), detail: e && e.message ? e.message : String(e) } });
    }
  }
  return { results };
}

// The harness (entry.mjs) passes its real classifyError via deps if it wants deny-shim codes; this
// pure helper falls back to sandbox_crashed so it stays importable from the host test without the
// deny-shim/container modules.
function classifyOrCrashed(_e) {
  return 'sandbox_crashed';
}
