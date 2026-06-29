import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface PackageJson {
  name: string;
  version: string;
  private?: boolean;
  license?: string;
  exports: Record<string, unknown>;
  files: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as PackageJson;

describe('@trading-backtester/sdk package shape', () => {
  it('is public, licensed and exposes only the approved entrypoints', () => {
    expect(pkg.name).toBe('@trading-backtester/sdk');
    expect(pkg.version).toBe('0.5.0');
    expect(pkg.private).not.toBe(true);
    expect(pkg.license).toBe('Apache-2.0');
    expect(Object.keys(pkg.exports).sort()).toEqual([
      '.',
      './artifacts',
      './builder',
      './client',
      './contracts',
    ]);
    expect(pkg.files.sort()).toEqual(['LICENSE', 'README.md', 'dist']);
  });

  it('has no workspace/sibling/private dependency in any group (standalone manifest)', () => {
    const groups = [
      pkg.dependencies,
      pkg.devDependencies,
      pkg.peerDependencies,
      pkg.optionalDependencies,
    ];
    for (const group of groups) {
      for (const [name, spec] of Object.entries(group ?? {})) {
        expect(name, `dependency ${name} references the private package`).not.toBe(
          '@trading/research-contracts',
        );
        for (const forbidden of ['workspace:', 'file:', 'link:', '../']) {
          expect(spec.includes(forbidden), `${name} uses forbidden specifier ${spec}`).toBe(false);
        }
      }
    }
  });

  it('documents the migration boundary honestly', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    expect(readme).toContain('GitHub Release');
    expect(readme).toContain('authoritative validation');
    expect(readme).not.toContain('live order');
  });
});
