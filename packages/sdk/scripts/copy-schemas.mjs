// Post-build: copy the kernel's fs-read 017 JSON schemas next to EACH dist entry whose bundled
// code resolves them via import.meta.url. The spike showed the schema-assets fs-read lands in
// dist/contracts/index.js AND dist/builder/index.js, so both need a sibling schemas/017 dir.
// Source of truth = the installed pinned kernel release (drift-free; no hand-vendored copies).
//
// The file list comes from the kernel's own SCHEMA_FILES, NOT a literal here. It used to be a
// hardcoded five, which silently desynced the moment the kernel added a schema: our own
// createSchemaRegistry iterates the kernel's SCHEMA_IDS, so it then asked for a file this script
// had never copied and blew up with ENOENT at registry-construction time (sdk 0.13.0 added four).
// Deriving the list means a kernel that grows a schema is picked up by a rebuild, not by a patch.
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sdkRoot = resolve(here, '..'); // packages/sdk

// The kernel's validation entry sits next to its schemas/017 dir (schema-assets.js uses the same).
// Use import.meta.resolve (sync since Node 20.6) to honour the ESM-only exports map.
const kernelValidationEntry = fileURLToPath(import.meta.resolve('@trdlabs/sdk/validation'));
const kernelSchemasDir = join(dirname(kernelValidationEntry), 'schemas', '017');

const { SCHEMA_FILES } = await import('@trdlabs/sdk/validation');
const EXPECTED = Object.values(SCHEMA_FILES);

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
console.log(`copy-schemas: copied ${EXPECTED.length} kernel schemas into ${targets.length} dirs`);
