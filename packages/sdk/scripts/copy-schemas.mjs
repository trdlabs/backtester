// Post-build: copy the kernel's 5 fs-read 017 JSON schemas next to EACH dist entry whose
// bundled code resolves them via import.meta.url. The spike showed the schema-assets fs-read lands
// in dist/contracts/index.js AND dist/builder/index.js, so both need a sibling schemas/017 dir.
// Source of truth = the installed pinned kernel release (drift-free; no hand-vendored copies).
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sdkRoot = resolve(here, '..'); // packages/sdk

// The kernel's validation entry sits next to its schemas/017 dir (schema-assets.js uses the same).
// Use import.meta.resolve (sync since Node 20.6) to honour the ESM-only exports map.
const kernelValidationEntry = fileURLToPath(import.meta.resolve('@trdlabs/sdk/validation'));
const kernelSchemasDir = join(dirname(kernelValidationEntry), 'schemas', '017');

const EXPECTED = [
  'module-manifest.schema.json',
  'strategy-decision.schema.json',
  'overlay-decision.schema.json',
  'backtest-run-request.schema.json',
  'validation-result.schema.json',
];

if (!existsSync(kernelSchemasDir)) {
  throw new Error(`copy-schemas: kernel schemas dir not found: ${kernelSchemasDir}`);
}
const present = new Set(readdirSync(kernelSchemasDir));
for (const f of EXPECTED) {
  if (!present.has(f)) throw new Error(`copy-schemas: missing kernel schema "${f}" in ${kernelSchemasDir}`);
}

const targets = [
  join(sdkRoot, 'dist', 'contracts', 'schemas', '017'),
  join(sdkRoot, 'dist', 'builder', 'schemas', '017'),
];
for (const dir of targets) {
  mkdirSync(dir, { recursive: true });
  for (const f of EXPECTED) cpSync(join(kernelSchemasDir, f), join(dir, f));
}
console.log(`copy-schemas: copied ${EXPECTED.length} schemas into ${targets.length} dirs`);
