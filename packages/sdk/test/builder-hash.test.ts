import { describe, expect, it } from 'vitest';
import { computeBundleHash, computeInlineBundleHash, createModuleBundle, createModuleManifest } from '../src/builder/index';

const manifest = createModuleManifest({
  id: 'h', version: '1.0.0', kind: 'strategy', name: 'n', summary: 's', rationale: 'r',
  hooks: ['onBarClose'], paramsSchema: { type: 'object' }, capabilities: { platformSdk: true },
  dataNeeds: { closedCandlesUpToCurrent: true },
});

describe('builder hashes', () => {
  it('computeBundleHash hashes raw bytes to sha256:<hex>', () => {
    const h = computeBundleHash(Buffer.from('export default () => ({})', 'utf8'));
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('computeBundleHash is byte-stable across Buffer and Uint8Array', () => {
    const bytes = new TextEncoder().encode('payload');
    expect(computeBundleHash(bytes)).toBe(computeBundleHash(Buffer.from('payload', 'utf8')));
  });

  it('computeInlineBundleHash is structural and distinct from the raw-bytes hash', () => {
    const bundle = createModuleBundle({ manifest, entry: 'i.js', files: { 'i.js': 'x' } });
    const structural = computeInlineBundleHash(bundle);
    const raw = computeBundleHash(Buffer.from('x', 'utf8'));
    expect(structural).toMatch(/^sha256:/);
    expect(structural).not.toBe(raw);
  });
});
