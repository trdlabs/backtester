import { describe, expect, it } from 'vitest';
import type { ModuleBundle } from '@trading/research-contracts';
import { BUNDLE_CONTRACT_VERSION } from '@trading/research-contracts';
import { computeInlineBundleHash } from '@trading-backtester/sdk/builder';
import { bundleHash, validateBundle } from '../src/sandbox/bundle';

const SRC = 'export function signals(c){ return c.map(()=>false); }';

function bundle(over: Partial<ModuleBundle> = {}): ModuleBundle {
  return {
    manifest: { id: 'b', version: '1.0.0', kind: 'strategy', bundleContractVersion: BUNDLE_CONTRACT_VERSION },
    entry: 'module.mjs',
    files: { 'module.mjs': SRC },
    ...over,
  };
}

describe('bundle content-addressing', () => {
  it('hashes deterministically and distinctly', () => {
    expect(bundleHash(bundle())).toBe(bundleHash(bundle()));
    expect(bundleHash(bundle())).toMatch(/^sha256:/);
    const other = bundle({ files: { 'module.mjs': SRC + '\n// changed' } });
    expect(bundleHash(other)).not.toBe(bundleHash(bundle()));
  });

  it('byte-parity: SDK computeInlineBundleHash matches the service registry hash', () => {
    // Proof the moved canonical core changed no bytes: the SDK builder and the service
    // registry must produce the identical content hash for the same bundle.
    expect(computeInlineBundleHash(bundle())).toBe(bundleHash(bundle()));
  });
});

describe('bundle validation', () => {
  it('accepts a well-formed bundle', () => {
    expect(validateBundle(bundle())).toEqual([]);
  });

  it('rejects a non-object', () => {
    expect(validateBundle(null).length).toBeGreaterThan(0);
  });

  it('rejects an entry not present in files', () => {
    const issues = validateBundle(bundle({ entry: 'missing.mjs' }));
    expect(issues.some((i) => i.code === 'bundle_entrypoint_invalid')).toBe(true);
  });

  it('accepts an overlay kind', () => {
    expect(
      validateBundle(bundle({ manifest: { ...bundle().manifest, kind: 'overlay' as never } })),
    ).toEqual([]);
  });

  it('rejects an unsupported kind', () => {
    const issues = validateBundle(
      bundle({ manifest: { ...bundle().manifest, kind: 'other' as never } }),
    );
    expect(issues.some((i) => i.code === 'unsupported_module_kind')).toBe(true);
  });

  it('rejects an unsupported contract version', () => {
    const issues = validateBundle(bundle({ manifest: { ...bundle().manifest, bundleContractVersion: '000.0' } }));
    expect(issues.some((i) => i.code === 'unsupported_contract_version')).toBe(true);
  });

  it('rejects a path-traversal file key', () => {
    const issues = validateBundle(bundle({ entry: '../evil.mjs', files: { '../evil.mjs': SRC } }));
    expect(issues.some((i) => i.code === 'bundle_entrypoint_invalid')).toBe(true);
  });
});
