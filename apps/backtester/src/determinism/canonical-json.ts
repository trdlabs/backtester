// Thin wrapper — the determinism core now lives in `@trdlabs/backtester-sdk`. This re-exports the
// single canonical serializer so existing service imports (`../determinism/canonical-json`) keep
// resolving with no behavior change. There is exactly one serializer; do not copy it back here.

export { canonicalJson } from '@trdlabs/backtester-sdk/contracts';
export { quantizeContractNumber as quantize } from '@trdlabs/backtester-sdk/contracts';
