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
  // Bundle the kernel RUNTIME into dist/*.js — the consumer never resolves @trdlabs/sdk at
  // runtime (its 017 schemas are copied alongside by copy-schemas.mjs). Types are a separate
  // axis and are NOT inlined: the api-extractor rollup imports them from @trdlabs/sdk so the
  // brand identities stay single (see scripts/run-api-extractor.mjs), which is why the kernel is
  // a real `dependency`, not a devDependency. esbuild would bundle a devDependency by default;
  // naming it here keeps the runtime-bundling guarantee independent of dependency group.
  // NOTE: the prior /^@trading-platform\/sdk/ matched nothing after the package was renamed to
  // @trdlabs/sdk — the bundling only still happened because of the devDependency default; this
  // regex now names the real package.
  noExternal: [/^@trdlabs\/sdk/],
  // Copy the kernel's fs-read 017 schemas next to the dist entries that resolve them.
  onSuccess: 'node scripts/copy-schemas.mjs',
});
