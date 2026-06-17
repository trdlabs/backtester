import { describe, expect, it } from 'vitest';
import { createSchemaRegistry } from '../src/engine/validation/schema-registry.js';
import { SCHEMA_IDS } from '@trading/research-contracts/research';

describe('lifted 017 validation runtime', () => {
  it('compiles the core schema registry and resolves a decision branch ref', () => {
    const reg = createSchemaRegistry();
    expect(typeof reg.validateRef).toBe('function');
    // A valid minimal idle decision passes the strategy-decision IdleDecision branch
    // (IdleDecision requires only `kind: 'idle'`, additionalProperties:false).
    const okErrs = reg.validateRef(
      `${SCHEMA_IDS['strategy-decision']}#/definitions/IdleDecision`,
      { kind: 'idle' },
    );
    expect(okErrs).toEqual([]);

    // An obviously-invalid payload (wrong const + extra prop) returns errors.
    const badErrs = reg.validateRef(
      `${SCHEMA_IDS['strategy-decision']}#/definitions/IdleDecision`,
      { kind: 'enter', bogus: true },
    );
    expect(badErrs.length).toBeGreaterThan(0);
  });
});
