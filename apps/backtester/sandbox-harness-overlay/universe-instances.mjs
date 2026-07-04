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

/** Single routing key for init/hook/hookBatch messages. */
export function symbolOf(msg) {
  if (msg == null) return undefined;
  if (typeof msg.symbol === 'string') return msg.symbol;
  if (msg.snapshot != null && typeof msg.snapshot.symbol === 'string') return msg.snapshot.symbol;
  const b0 = Array.isArray(msg.bars) ? msg.bars[0] : undefined;
  if (b0 != null && b0.snapshot != null && typeof b0.snapshot.symbol === 'string') return b0.snapshot.symbol;
  return undefined;
}
