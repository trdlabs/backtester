import { describe, expect, it } from 'vitest';
import {
  computeInlineBundleHash,
  createModuleBundle,
  createModuleManifest,
  preflightValidateBundle,
} from '../src/builder/index';
import { BUNDLE_CONTRACT_VERSION, API_CONTRACT_VERSION } from '../src/internal/versions';

const manifestInput = {
  id: 'overlay-1',
  version: '1.0.0',
  kind: 'overlay' as const,
  name: 'Overlay one',
  summary: 's',
  rationale: 'r',
  hooks: ['apply'] as const,
  paramsSchema: { type: 'object' },
  capabilities: { platformSdk: true },
  dataNeeds: { closedCandlesUpToCurrent: true },
};

describe('SDK builder', () => {
  it('createModuleManifest pins versions and defaults author/status', () => {
    const m = createModuleManifest(manifestInput);
    expect(m.bundleContractVersion).toBe(BUNDLE_CONTRACT_VERSION);
    expect(m.contractVersion).toBe(API_CONTRACT_VERSION);
    expect(m.author).toBe('agent');
    expect(m.status).toBe('research_only');
    expect(Object.isFrozen(m)).toBe(true);
  });

  it('createModuleBundle is deterministic and order-independent', () => {
    const manifest = createModuleManifest(manifestInput);
    const a = createModuleBundle({ manifest, entry: 'i.js', files: { 'i.js': 'x', 'a.js': 'y' } });
    const b = createModuleBundle({ manifest, entry: 'i.js', files: { 'a.js': 'y', 'i.js': 'x' } });
    expect(computeInlineBundleHash(a)).toBe(computeInlineBundleHash(b));
  });

  it('preflight accepts a well-formed overlay bundle for the overlay engine', () => {
    const manifest = createModuleManifest(manifestInput);
    const bundle = createModuleBundle({ manifest, entry: 'i.js', files: { 'i.js': 'export default () => ({ apply: () => null })' } });
    const report = preflightValidateBundle(bundle, { engine: 'overlay' });
    expect(report.status).toBe('accepted');
  });

  it('engine "strategy" accepts only kind:"strategy"', () => {
    const strategyInput = {
      id: 'strategy-1',
      version: '1.0.0',
      kind: 'strategy' as const,
      name: 'Strategy one',
      summary: 's',
      rationale: 'r',
      hooks: [] as const,
      paramsSchema: { type: 'object' },
      capabilities: { platformSdk: true },
      dataNeeds: { closedCandlesUpToCurrent: true },
    };
    const manifest = createModuleManifest(strategyInput);
    const bundle = createModuleBundle({ manifest, entry: 'i.js', files: { 'i.js': 'export default () => ({})' } });
    const report = preflightValidateBundle(bundle, { engine: 'strategy' });
    expect(report.status).toBe('accepted');

    // Reject when engine doesn't match kind
    const rejectReport = preflightValidateBundle(bundle, { engine: 'overlay' });
    expect(rejectReport.status).toBe('rejected');
    expect(rejectReport.issues.some((i) => i.code === 'unsupported_module_kind')).toBe(true);
  });

  it('preflight rejects an entry not in files', () => {
    const manifest = createModuleManifest(manifestInput);
    const bundle = createModuleBundle({ manifest, entry: 'missing.js', files: { 'i.js': 'x' } });
    const report = preflightValidateBundle(bundle, { engine: 'overlay' });
    expect(report.status).toBe('rejected');
    expect(report.issues.some((i) => i.code === 'bundle_entrypoint_invalid')).toBe(true);
  });

  it.each([
    '/abs.js',
    './rel.js',
    'a/../b.js',
    'a\\b.js',
    'f\0.js',
    '../escape.js',
  ])('preflight rejects unsafe path %j', (unsafe) => {
    const manifest = createModuleManifest(manifestInput);
    const bundle = createModuleBundle({ manifest, entry: unsafe, files: { [unsafe]: 'x' } });
    const report = preflightValidateBundle(bundle, { engine: 'overlay' });
    expect(report.status).toBe('rejected');
    expect(report.issues.some((i) => i.code === 'bundle_entrypoint_invalid')).toBe(true);
  });
});
