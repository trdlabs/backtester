import type { ModuleBundle } from '../../../contracts/module';
import { createModuleBundle } from '../../bundle';
import { createModuleManifest } from '../../manifest';

/**
 * Worked overlay (hypothesis): vetoes the base decision when price is above a ceiling, else passes.
 * Self-contained ESM, no imports, deterministic. Same entry convention as a strategy
 * (default-export a factory), but the module exposes `apply`.
 */
export const OVERLAY_EXAMPLE_SOURCE = `// Self-contained overlay bundle (FR-003): no imports, pre-built ESM, deterministic.
export default function createStrategyModule(params) {
  return {
    apply(ctx) {
      const maxClose = Number(ctx.params.maxClose ?? Infinity);
      if (ctx.bar.close > maxClose) {
        return { kind: 'veto', reasonCode: 'price_above_ceiling', rationale: 'close ' + ctx.bar.close + ' > ' + maxClose };
      }
      return { kind: 'pass' };
    },
  };
}
`;

export const OVERLAY_EXAMPLE_BUNDLE: ModuleBundle = createModuleBundle({
  manifest: createModuleManifest({
    id: 'example_ceiling_veto',
    version: '0.1.0',
    kind: 'overlay',
    name: 'Ceiling veto (worked example)',
    summary: 'Vetoes entries when price is above a configured ceiling.',
    rationale: 'Demonstrates an overlay bundle: single-point apply returning an OverlayDecision.',
    hooks: ['apply'],
    capabilities: { platformSdk: true },
    dataNeeds: { closedCandlesUpToCurrent: true },
    paramsSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { maxClose: { type: 'number' } },
    },
    params: { maxClose: 100000 },
  }),
  entry: 'module/index.js',
  files: { 'module/index.js': OVERLAY_EXAMPLE_SOURCE },
});
