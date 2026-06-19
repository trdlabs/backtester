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
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  target: 'node22',
});
