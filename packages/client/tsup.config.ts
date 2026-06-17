import { defineConfig } from 'tsup';

// @trading/research-contracts is a devDependency (not in `dependencies`), so tsup bundles both its JS
// and its .d.ts into dist — the published client carries no workspace dependency and installs from
// git/path with no monorepo resolution.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  // Wire types are vendored (src/wire.ts), so there are no external type imports — the bundled .d.ts
  // is self-contained and the consumer needs no workspace resolution.
  dts: true,
  clean: true,
  sourcemap: false,
  treeshake: true,
});
