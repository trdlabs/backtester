import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'contracts/index': 'src/contracts/index.ts',
    'builder/index': 'src/builder/index.ts',
    'client/index': 'src/client/index.ts',
    'artifacts/index': 'src/artifacts/index.ts',
  },
  format: ['esm'],
  // dts is produced by the dedicated dts-bundling step (Task 2), not tsup — tsup/rollup-dts
  // cannot inline @trdlabs/sdk subpath-exported types.
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
  target: 'node22',
  // Bundle the kernel runtime into dist/*.js so the published tarball is hermetic — the
  // consumer never resolves @trdlabs/sdk at runtime (its 017 schemas are copied alongside by
  // copy-schemas.mjs; its types are inlined by the api-extractor dts rollup). The kernel is a
  // devDependency, which esbuild would bundle by default, but naming it here makes the hermetic
  // guarantee explicit and independent of that default. NOTE: the prior /^@trading-platform\/sdk/
  // matched nothing after the package was renamed to @trdlabs/sdk — the bundling only still
  // happened because of the devDependency default; this regex now names the real package.
  noExternal: [/^@trdlabs\/sdk/],
  // Copy the kernel's fs-read 017 schemas next to the dist entries that resolve them.
  onSuccess: 'node scripts/copy-schemas.mjs',
});
