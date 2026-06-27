import { describe, expect, it } from 'vitest';
import { scaffoldStrategyBundle, STRATEGY_EXAMPLE_SOURCE } from '../src/builder/index';

const input = {
  manifest: {
    id: 'scaffolded', version: '0.1.0', kind: 'strategy' as const,
    name: 'n', summary: 's', rationale: 'r',
    hooks: ['onBarClose', 'onPositionBar'] as const,
    capabilities: { platformSdk: true },
    dataNeeds: { closedCandlesUpToCurrent: true, asOfIndicators: true },
    paramsSchema: { type: 'object' },
  },
  entry: 'module/index.js',
  files: { 'module/index.js': STRATEGY_EXAMPLE_SOURCE },
};

describe('scaffoldStrategyBundle', () => {
  it('builds a bundle and an accepted preflight report', () => {
    const { bundle, report } = scaffoldStrategyBundle(input);
    expect(bundle.manifest.id).toBe('scaffolded');
    expect(bundle.entry).toBe('module/index.js');
    expect(report.status).toBe('accepted');
  });

  it('reports rejection for an entry not in files without throwing', () => {
    const { report } = scaffoldStrategyBundle({ ...input, entry: 'missing.js' });
    expect(report.status).toBe('rejected');
    expect(report.issues.some((i) => i.code === 'bundle_entrypoint_invalid')).toBe(true);
  });
});
