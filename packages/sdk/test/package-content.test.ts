import { describe, expect, it } from 'vitest';
import { checkPackedPackage } from '../../../scripts/verify-sdk-package';

describe('SDK packed package policy', () => {
  it('rejects workspace dependencies and forbidden files', () => {
    expect(checkPackedPackage({
      packageJson: { dependencies: { bad: 'workspace:*' } },
      files: ['package/src/internal.ts'],
    })).toEqual([
      'dependency bad uses forbidden specifier workspace:*',
      'forbidden packed path package/src/internal.ts',
    ]);
  });

  it('rejects file:/link:/sibling specifiers across all dependency groups', () => {
    expect(checkPackedPackage({
      packageJson: {
        devDependencies: { a: 'file:../a' },
        peerDependencies: { b: 'link:../b' },
        optionalDependencies: { c: '../c' },
      },
      files: [],
    })).toEqual([
      'dependency a uses forbidden specifier file:../a',
      'dependency b uses forbidden specifier link:../b',
      'dependency c uses forbidden specifier ../c',
    ]);
  });

  it('allows the declared decimal.js registry dependency and a clean file set', () => {
    expect(checkPackedPackage({
      packageJson: {
        name: '@trdlabs/backtester-sdk', version: '0.1.0', license: 'Apache-2.0',
        dependencies: { 'decimal.js': '^10.4.3' },
        exports: {
          '.': { import: './dist/index.js', types: './dist/index.d.ts' },
          './contracts': { import: './dist/contracts/index.js', types: './dist/contracts/index.d.ts' },
          './builder': { import: './dist/builder/index.js', types: './dist/builder/index.d.ts' },
          './client': { import: './dist/client/index.js', types: './dist/client/index.d.ts' },
          './artifacts': { import: './dist/artifacts/index.js', types: './dist/artifacts/index.d.ts' },
        },
      },
      files: [
        'package/package.json', 'package/README.md', 'package/LICENSE',
        'package/dist/index.js', 'package/dist/index.d.ts',
        'package/dist/contracts/index.js', 'package/dist/contracts/index.d.ts',
        'package/dist/builder/index.js', 'package/dist/builder/index.d.ts',
        'package/dist/client/index.js', 'package/dist/client/index.d.ts',
        'package/dist/artifacts/index.js', 'package/dist/artifacts/index.d.ts',
      ],
    })).toEqual([]);
  });
});
