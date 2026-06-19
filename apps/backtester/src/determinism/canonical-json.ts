// Thin wrapper — the determinism core now lives in `@trading-backtester/sdk`. This re-exports the
// single canonical serializer so existing service imports (`../determinism/canonical-json`) keep
// resolving with no behavior change. There is exactly one serializer; do not copy it back here.

export { canonicalJson } from '@trading-backtester/sdk/contracts';
export { quantizeContractNumber as quantize } from '@trading-backtester/sdk/contracts';
