// apps/backtester/sandbox-harness-overlay/universe-instances.mjs
/** Per-symbol harness state for a universe session (one container hosting N instances). */
export function makeInstanceStore() {
  const slots = new Map(); // symbol -> { instance, rng, buffer, oiBuffer, liqBuffer }
  return {
    get: (symbol) => slots.get(symbol),
    ensure(symbol, factory) {
      let s = slots.get(symbol);
      if (s === undefined) {
        s = { instance: undefined, rng: undefined, buffer: [], oiBuffer: [], liqBuffer: [] };
        const built = factory();
        s.instance = built.instance;
        s.rng = built.rng;
        slots.set(symbol, s);
      }
      return s;
    },
    all: () => slots.values(),
  };
}

/**
 * Resolve the module instance from an imported bundle module (`loadedModule.default`).
 *
 * A FUNCTION default export is a factory: called fresh each time → always per-symbol isolated
 * (`{ ok: true, instance }`), regardless of universe mode.
 *
 * A NON-FUNCTION default export (a plain object, or the module itself when there's no default) is
 * a SHARED reference — safe only when the caller lives in its own per-symbol container (pre-Task-5
 * one-container-per-symbol; `universe` false/absent), which is why that path stays `{ ok: true,
 * instance }` unchanged. Under a universe container (N symbols sharing one process) that same
 * shared object would leak `this`-state across symbols, silently breaking byte-identity — so in
 * universe mode this shape FAILS CLOSED (`{ ok: false, code, reason }`) instead of being accepted.
 */
export function resolveInstance(loadedModule, { universe } = {}) {
  const factory = loadedModule.default;
  if (typeof factory === 'function') {
    return { ok: true, instance: factory() };
  }
  if (universe === true) {
    return {
      ok: false,
      code: 'bundle_load_failed',
      reason: 'universe session requires a factory-function default export for per-symbol isolation',
    };
  }
  return { ok: true, instance: factory ?? loadedModule };
}

/** Single routing key for init/hook/hookBatch messages. */
export function symbolOf(msg) {
  if (msg == null) return undefined;
  if (typeof msg.symbol === 'string') return msg.symbol;
  if (msg.snapshot != null && typeof msg.snapshot.symbol === 'string') return msg.snapshot.symbol;
  const b0 = Array.isArray(msg.bars) ? msg.bars[0] : undefined;
  if (b0 != null && b0.snapshot != null && typeof b0.snapshot.symbol === 'string') return b0.snapshot.symbol;
  return undefined;
}
