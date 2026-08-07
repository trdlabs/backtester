import { Extractor, ExtractorConfig } from '@microsoft/api-extractor';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// DO NOT re-add `"bundledPackages": ["@trdlabs/sdk"]` to the api-extractor configs below.
//
// Each entry point is rolled up INDEPENDENTLY, so bundling inlined the kernel's declarations once
// per entry point: five copies of one type. That was harmless while the kernel's types were purely
// structural — TypeScript treats identically-shaped types as interchangeable. It stopped being
// harmless when the kernel introduced branded types (`declare const DURATION_US: unique symbol`,
// @trdlabs/sdk 0.14.0): `unique symbol` is nominal BY CONSTRUCTION, so three inlined copies of
// `DurationUs` (contracts / builder / client) were three mutually unassignable types, and none of
// them equal to the consumer's own `@trdlabs/sdk` `DurationUs`. The defect is in the packaging and
// predates 0.14.0; the brands only made it visible.
//
// Un-bundled, every rollup emits `import type { X } from '@trdlabs/sdk/...'` — one declaration,
// one identity, shared with the consumer. The price is that @trdlabs/sdk must be resolvable at
// the consumer to typecheck, which is why it is a real `dependency` in package.json. The runtime
// stays inlined by tsup (`noExternal`), so nothing resolves it at run time.
// The clean-consumer gate (scripts/verify-sdk-clean-consumer.ts, `skipLibCheck: false`) is what
// proves the external type surface still resolves.
const entries = ['index', 'contracts', 'builder', 'client', 'artifacts'];

for (const e of entries) {
  const cfg = ExtractorConfig.loadFileAndPrepare(join(sdkRoot, `api-extractor.${e}.json`));
  // localBuild:true tolerates api-extractor's cosmetic ae-* version-lag warnings; real errors still fail (res.succeeded). Do not flip to false without re-checking the TS/api-extractor version pair.
  const res = Extractor.invoke(cfg, { localBuild: true, showVerboseMessages: false });
  if (!res.succeeded) {
    console.error(`api-extractor failed for ${e}: ${res.errorCount} errors`);
    process.exit(1);
  }
}
console.log('api-extractor: rolled up 5 entrypoints');
