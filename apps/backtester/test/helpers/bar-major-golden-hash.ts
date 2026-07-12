// Task 6 froze this hash for Task 4's fixture (`makeMultiSymbolDeps`/`makeRequest` from
// `./bar-major-fixture.js`), bar-major ON, N=2 (BTCUSDT/ETHUSDT), AFTER Task 5 (so it includes the
// `capitalModel` evidence field Task 5 added to bar-major N>1 outcomes).
//
// Lives in its own (non-`.test.ts`) module so consumers can `import` the constant without
// triggering Vitest to collect and re-run the `describe`/`it` blocks in `bar-major-golden.test.ts`
// as a side effect of the import (Vitest test files are plain ES modules — importing one for a
// constant executes its top-level `describe(...)` calls too). `bar-major-golden.test.ts` and
// Task 7's `bar-major-batch-golden.test.ts` both import from here instead.
export const BAR_MAJOR_GOLDEN = 'sha256:9da2192a459e6147bd4d5d52de6a327ed7b40b6520e107f93dabc3cff53ef977';
