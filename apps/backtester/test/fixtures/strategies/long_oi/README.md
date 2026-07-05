# Vendored `long_oi` strategy module (fixture)

Vendored byte-identical from `trading-platform/src/strategies/long_oi` via
`trading-lab/docs/fixtures/strategies/long-oi-code`. Do not edit; re-vendor +
regenerate `CHECKSUMS.txt` to update.

The 7 files (`module.ts`, `manifest.ts`, `params.ts`, `flat_phase.ts`,
`position_phase.ts`, `signals.ts`, `state.ts`) were copied verbatim (bytes
unchanged, confirmed via `cmp`) — no import-specifier rewrite was needed. The
vendored files' sibling imports use `./x.js` specifiers pointing at `.ts`
files (e.g. `import { detectDump } from './signals.js'` in `module.ts`), which
already matches this repo's convention (see
`apps/backtester/test/exec-validation.test.ts`'s
`import { replayPnlPct } from './helpers-replay.js'`) and resolves as-is
under this repo's vitest/ESM setup.

`module.ts` exports `LONG_OI_MODULE: StrategyModule` (a ready singleton
instance) and `createLongOiModule()` (fresh, isolated FSM state per call).

## Regenerating `CHECKSUMS.txt`

From the repo root, after re-vendoring:

```bash
( cd apps/backtester/test/fixtures/strategies/long_oi && sha256sum *.ts | sort ) > apps/backtester/test/fixtures/strategies/long_oi/CHECKSUMS.txt
```

The drift-guard test (`apps/backtester/test/long-oi-vendored.test.ts`) fails
if any vendored `.ts` file's checksum no longer matches, or if a vendored
`.ts` file is missing from the manifest. This checksum drift guard is a re-vendor-time lock that detects accidental in-repo edits to the vendored copy, not continuous divergence from the upstream `trading-platform` source — upstream drift is only caught when someone re-vendors and regenerates CHECKSUMS.txt.
