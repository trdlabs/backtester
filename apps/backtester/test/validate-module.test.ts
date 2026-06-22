// Characterization tests for validateModule — the structural manifest gate (017, FR-020/022).
// Coverage flagged it at ~48%; the contract-version, submit-status, no-lookahead/determinism,
// market-data-kind, capability-boundary, separation and overlay (multi_hook / unknown_strategy_ref)
// branches were unexercised. Driven through the real createSchemaRegistry() + platformContractContext()
// and the example manifests as valid baselines. No source change.

import { describe, expect, it } from 'vitest';
import type { ModuleManifest } from '@trading/research-contracts/research';
import { platformContractContext } from '@trading/research-contracts/research';
import { validateModule } from '../src/engine/validation/validate-module';
import { createSchemaRegistry } from '../src/engine/validation/schema-registry';
import { shortAfterPump } from '../src/engine/examples/short-after-pump.strategy';
import { earlyExitShortAfterPump } from '../src/engine/examples/early-exit-short-after-pump.overlay';

const registry = createSchemaRegistry();
const ctx = platformContractContext([]);
const ctxKnowing = (ref: string) => platformContractContext([ref]);

const strat = (overrides: Partial<ModuleManifest> = {}): ModuleManifest =>
  ({ ...shortAfterPump.manifest, ...overrides }) as ModuleManifest;
const overlay = (overrides: Partial<ModuleManifest> = {}): ModuleManifest =>
  ({ ...earlyExitShortAfterPump.manifest, ...overrides }) as ModuleManifest;

describe('validation/validate-module — valid baselines', () => {
  it('accepts the example strategy manifest and attaches normalized', () => {
    const r = validateModule({ manifest: strat() }, ctx, registry);
    expect(r.status).toBe('accepted');
    expect('normalized' in r).toBe(true);
  });

  it('accepts the example overlay manifest when its targetStrategyRef is known', () => {
    const r = validateModule({ manifest: overlay() }, ctxKnowing('short_after_pump'), registry);
    expect(r.status).toBe('accepted');
  });
});

describe('validation/validate-module — strategy gates', () => {
  it('requires onBarClose for a strategy module', () => {
    const r = validateModule({ manifest: strat({ hooks: ['init'] }) }, ctx, registry);
    expect(r.issues).toContainEqual(expect.objectContaining({ code: 'schema_invalid', path: '/hooks' }));
    expect(r.status).toBe('rejected');
  });

  it('rejects a submit status other than research_only (FR-030)', () => {
    const r = validateModule({ manifest: strat({ status: 'promoted' }) }, ctx, registry);
    expect(r.issues).toContainEqual(expect.objectContaining({ code: 'schema_invalid', path: '/status' }));
  });

  it('rejects an unsupported contractVersion', () => {
    const r = validateModule({ manifest: strat({ contractVersion: '9.9.9' }) }, ctx, registry);
    expect(r.issues).toContainEqual(expect.objectContaining({ code: 'unsupported_contract_version', path: '/contractVersion' }));
  });
});

describe('validation/validate-module — dataNeeds gates', () => {
  it('flags a declared lookahead need', () => {
    const r = validateModule({ manifest: strat({ dataNeeds: { ...shortAfterPump.manifest.dataNeeds, forwardBars: true } }) }, ctx, registry);
    expect(r.issues).toContainEqual(expect.objectContaining({ code: 'lookahead_violation', path: '/dataNeeds/forwardBars' }));
  });

  it('flags a declared nondeterminism need', () => {
    const r = validateModule({ manifest: strat({ dataNeeds: { ...shortAfterPump.manifest.dataNeeds, wallClock: true } }) }, ctx, registry);
    expect(r.issues).toContainEqual(expect.objectContaining({ code: 'nondeterminism_violation', path: '/dataNeeds/wallClock' }));
  });

  it('flags an unrecognized market-data need (fail-closed)', () => {
    // `bogusKind` is intentionally outside DataNeedsDeclaration — the gate is fail-closed on unknown
    // declared needs, so the test pins exactly that (cast past the typed shape to declare it).
    const dataNeeds = { ...shortAfterPump.manifest.dataNeeds, bogusKind: true } as ModuleManifest['dataNeeds'];
    const r = validateModule({ manifest: strat({ dataNeeds }) }, ctx, registry);
    expect(r.issues).toContainEqual(expect.objectContaining({ code: 'unsupported_market_data_kind', path: '/dataNeeds/bogusKind' }));
  });
});

describe('validation/validate-module — capability + separation', () => {
  it('flags a declared forbidden capability', () => {
    const cap = ctx.forbiddenCapabilities[0];
    expect(typeof cap).toBe('string'); // catalog declares at least one
    const r = validateModule({ manifest: strat({ capabilities: { platformSdk: true, [cap as string]: true } }) }, ctx, registry);
    expect(r.issues).toContainEqual(expect.objectContaining({ code: 'forbidden_capability', path: `/capabilities/${cap}` }));
  });

  it('flags a risk/execution-zone field on a sample decision (separation violation)', () => {
    const r = validateModule({ manifest: strat(), sampleDecisions: [{ kind: 'enter', side: 'short', leverage: 5 }] }, ctx, registry);
    expect(r.issues).toContainEqual(expect.objectContaining({ code: 'separation_violation', path: '/sampleDecisions/0/leverage' }));
  });

  it('flags a sample decision with an unknown kind', () => {
    const r = validateModule({ manifest: strat(), sampleDecisions: [{ kind: 'bogus' }] }, ctx, registry);
    expect(r.issues).toContainEqual(expect.objectContaining({ code: 'decision_schema_invalid', path: '/sampleDecisions/0/kind' }));
  });
});

describe('validation/validate-module — overlay gates', () => {
  it('flags an overlay declaring more than one interception hook', () => {
    const r = validateModule({ manifest: overlay({ hooks: ['apply', 'init'] }) }, ctxKnowing('short_after_pump'), registry);
    expect(r.issues).toContainEqual(expect.objectContaining({ code: 'multi_hook_overlay', path: '/hooks' }));
  });

  it('flags an overlay whose targetStrategyRef is unknown to the catalog', () => {
    const r = validateModule({ manifest: overlay() }, ctx, registry); // ctx knows no strategies
    expect(r.issues).toContainEqual(expect.objectContaining({ code: 'unknown_strategy_ref', path: '/targetStrategyRef' }));
  });
});
