// Public wire types. Vendored in ./wire so the built dist is self-contained (no workspace dependency
// at consumer install). Parity with @trading/research-contracts is enforced by a compile-time test in
// apps/backtester/test/client-parity.test.ts.

export * from './wire';
