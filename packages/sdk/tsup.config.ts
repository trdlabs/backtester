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
  // cannot inline @trading-platform/sdk subpath-exported types.
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
  target: 'node22',
  // Bundle the kernel runtime into dist/*.js so the published artifact has no exotic URL dep.
  noExternal: [/^@trading-platform\/sdk/],
  // Copy the kernel's fs-read 017 schemas next to the dist entries that resolve them.
  onSuccess: 'node scripts/copy-schemas.mjs',
});
