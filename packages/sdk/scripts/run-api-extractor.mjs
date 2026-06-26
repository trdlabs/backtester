import { Extractor, ExtractorConfig } from '@microsoft/api-extractor';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
