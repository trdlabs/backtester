import { describe, expect, it } from 'vitest';
import {
  computeInlineBundleHash,
  createModuleBundle,
  createModuleManifest,
  preflightValidateBundle,
} from '../src/builder/index';

const manifest = createModuleManifest({ id: 'overlay-1', version: '1.0.0', kind: 'overlay' });

describe('SDK builder', () => {
  it('hashes semantic file maps independently of insertion order', () => {
    const a = createModuleBundle({
      manifest, entry: 'index.js',
      files: { 'z.js': 'z', 'index.js': 'export default () => ({ apply: () => null })' },
    });
    const b = createModuleBundle({
      manifest, entry: 'index.js',
      files: { 'index.js': 'export default () => ({ apply: () => null })', 'z.js': 'z' },
    });
    expect(computeInlineBundleHash(a)).toBe(computeInlineBundleHash(b));
  });

  it('rejects traversal and missing entry files with authoritative-compatible codes', () => {
    const report = preflightValidateBundle(
      { manifest, entry: 'missing.js', files: { '../escape.js': 'bad' } },
      { engine: 'overlay' },
    );
    expect(report.status).toBe('rejected');
    expect(new Set(report.issues.map((i) => i.code))).toEqual(new Set(['bundle_entrypoint_invalid']));
    const keys = report.issues.map((i) => `${i.path ?? ''} ${i.code}`);
    expect(keys).toEqual([...keys].sort());
  });

  it('rejects absolute, Windows-drive, and dot-segment file paths', () => {
    for (const bad of ['C:/x.js', '/abs.js', './rel.js', 'a/../b.js', 'a\\b.js', 'f\0.js']) {
      const report = preflightValidateBundle(
        { manifest, entry: 'index.js', files: { 'index.js': 'ok', [bad]: 'x' } },
        { engine: 'overlay' },
      );
      expect(report.status, `path ${JSON.stringify(bad)} should be rejected`).toBe('rejected');
      expect(report.issues.some((i) => i.path === bad && i.code === 'bundle_entrypoint_invalid')).toBe(true);
    }
  });

  it('rejects an unsafe entry path', () => {
    const report = preflightValidateBundle(
      { manifest, entry: '../escape.js', files: { '../escape.js': 'bad' } },
      { engine: 'overlay' },
    );
    expect(report.status).toBe('rejected');
    // The entry path itself is flagged, not only its presence in files.
    expect(report.issues.some((i) => i.path === '../escape.js' && i.message.includes('entry'))).toBe(true);
  });
});
