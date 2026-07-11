import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getAuthoringDoc } from '../src/builder/index';

// Drift-guard: the authoring doc is the LLM builder's authoritative contract. If a field name,
// enum value, or decision `kind` exists in the 017 JSON schemas but is NOT documented, the LLM
// is forced to guess its shape — exactly the failure mode (schema_invalid /
// unsupported_market_data_kind) this guard exists to prevent. These tests read the SAME schemas the
// kernel validates against (resolved like scripts/copy-schemas.mjs) and assert every documentable
// token appears in the rendered doc. A new schema field fails this test until the doc catches up.

// Resolve the kernel's pinned 017 schema dir from its installed location. The package's exports map
// only exposes the `import`/`types` conditions, so require.resolve / import.meta.resolve cannot reach
// it under vitest — walk up node_modules instead (transparently follows the pnpm symlink). Same dir
// scripts/copy-schemas.mjs copies from, so the test validates against the exact shipped schemas.
function findKernelSchemaDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, 'node_modules', '@trdlabs', 'sdk', 'dist', 'validation', 'schemas', '017');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('kernel 017 schema dir not found under any ancestor node_modules');
}
const SCHEMA_DIR = findKernelSchemaDir();

function loadSchema(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(SCHEMA_DIR, file), 'utf8')) as Record<string, unknown>;
}

/** Walk a JSON-schema node, collecting every property name and every const/enum string value. */
function collectTokens(node: unknown, props: Set<string>, values: Set<string>): void {
  if (!node || typeof node !== 'object') return;
  const n = node as Record<string, unknown>;
  if (n.properties && typeof n.properties === 'object') {
    for (const [key, child] of Object.entries(n.properties as Record<string, unknown>)) {
      props.add(key);
      collectTokens(child, props, values);
    }
  }
  if (typeof n.const === 'string') values.add(n.const);
  if (Array.isArray(n.enum)) for (const e of n.enum) if (typeof e === 'string') values.add(e);
  if (n.definitions && typeof n.definitions === 'object') {
    for (const def of Object.values(n.definitions as Record<string, unknown>)) {
      collectTokens(def, props, values);
    }
  }
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (Array.isArray(n[key])) for (const v of n[key] as unknown[]) collectTokens(v, props, values);
  }
  if (n.items) collectTokens(n.items, props, values);
}

function collect(file: string): { props: string[]; values: string[] } {
  const props = new Set<string>();
  const values = new Set<string>();
  collectTokens(loadSchema(file), props, values);
  return { props: [...props], values: [...values] };
}

describe('authoring doc drift-guard (vs 017 schemas)', () => {
  const strategyDoc = getAuthoringDoc('strategy');
  const overlayDoc = getAuthoringDoc('overlay');

  it('strategy doc documents every StrategyDecision field and kind/enum', () => {
    const { props, values } = collect('strategy-decision.schema.json');
    expect(props.length).toBeGreaterThan(0);
    expect(values).toContain('enter'); // sanity: the walker actually found the consts
    for (const p of props) expect(strategyDoc, `missing decision field "${p}"`).toContain(p);
    for (const v of values) expect(strategyDoc, `missing decision kind/enum "${v}"`).toContain(v);
  });

  it('overlay doc documents every OverlayDecision field and kind', () => {
    const { props, values } = collect('overlay-decision.schema.json');
    expect(values).toContain('veto');
    for (const p of props) expect(overlayDoc, `missing overlay field "${p}"`).toContain(p);
    for (const v of values) expect(overlayDoc, `missing overlay kind "${v}"`).toContain(v);
  });

  it('strategy doc documents every DataNeedsDeclaration flag (closed catalog)', () => {
    const manifest = loadSchema('module-manifest.schema.json');
    const defs = manifest.definitions as Record<string, Record<string, unknown>>;
    const dataNeeds = defs.DataNeedsDeclaration;
    const flags = Object.keys((dataNeeds?.properties ?? {}) as Record<string, unknown>);
    // The kernel ships all 13 flags (6 market/structural + 5 lookahead + 2 nondeterminism).
    expect(flags.length).toBeGreaterThanOrEqual(13);
    for (const flag of flags) {
      expect(strategyDoc, `dataNeeds flag "${flag}" not documented`).toContain(flag);
    }
  });

  it('strategy doc states the unsupported_market_data_kind rule for unknown flags', () => {
    expect(strategyDoc).toContain('unsupported_market_data_kind');
    expect(strategyDoc).toContain('lookahead_violation');
    expect(strategyDoc).toContain('nondeterminism_violation');
  });
});
