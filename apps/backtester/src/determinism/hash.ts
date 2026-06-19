// Thin wrapper — content hashing now lives in `@trading-backtester/sdk`. This re-exports the single
// hash primitive so existing service imports (`../determinism/hash`) keep resolving with no behavior
// change. There is exactly one hash algorithm; do not copy it back here.

export { sha256Hex, contentRef } from '@trading-backtester/sdk/contracts';
