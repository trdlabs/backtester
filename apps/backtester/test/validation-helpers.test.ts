// Characterization unit tests for the pure validation helpers — the audit flagged them as reached
// only transitively (no direct test). Behavior-pinning; no source change.

import { describe, expect, it } from 'vitest';
import type { ValidationCode, ValidationIssue } from '@trading/research-contracts/research';
import { assemble, makeIssue } from '../src/engine/validation/assemble';
import { CODE_SEVERITY } from '../src/engine/validation/codes';
import { jsonPointerOf } from '../src/engine/validation/schema-registry';

describe('validation/assemble — makeIssue', () => {
  it('derives severity from CODE_SEVERITY (single source) and passes code/message/path through', () => {
    const code: ValidationCode = 'schema_invalid';
    const issue = makeIssue(code, 'bad shape', '/foo');
    expect(issue).toEqual({ severity: CODE_SEVERITY[code], code, message: 'bad shape', path: '/foo' });
    // severity is NOT hardcoded — it tracks the catalog
    expect(issue.severity).toBe(CODE_SEVERITY['schema_invalid']);
  });
});

describe('validation/assemble — assemble', () => {
  const err = (path: string, code: ValidationCode = 'schema_invalid'): ValidationIssue => ({ severity: 'error', code, message: 'e', path });
  const warn = (path: string, code: ValidationCode = 'schema_invalid'): ValidationIssue => ({ severity: 'warning', code, message: 'w', path });

  it('accepted (no issues) attaches normalized when provided', () => {
    const r = assemble([], { ok: true });
    expect(r.status).toBe('accepted');
    expect(r.issues).toEqual([]);
    expect((r as { normalized?: object }).normalized).toEqual({ ok: true });
  });

  it('accepted (no issues) omits normalized when not provided', () => {
    const r = assemble([]);
    expect(r.status).toBe('accepted');
    expect('normalized' in r).toBe(false);
  });

  it('accepted_with_warnings when only warnings — normalized still attached', () => {
    const r = assemble([warn('/x')], { ok: true });
    expect(r.status).toBe('accepted_with_warnings');
    expect((r as { normalized?: object }).normalized).toEqual({ ok: true });
  });

  it('rejected on any error — NEVER attaches normalized even when provided', () => {
    const r = assemble([err('/x'), warn('/y')], { ok: true });
    expect(r.status).toBe('rejected');
    expect('normalized' in r).toBe(false);
  });

  it('sorts issues stably by (path, then code)', () => {
    const issues = [warn('/b', 'unknown_metric'), warn('/a', 'unknown_metric'), warn('/a', 'incomplete_run_request')];
    const r = assemble(issues);
    expect(r.issues.map((i) => [i.path, i.code])).toEqual([
      ['/a', 'incomplete_run_request'],
      ['/a', 'unknown_metric'],
      ['/b', 'unknown_metric'],
    ]);
  });
});

describe('validation/schema-registry — jsonPointerOf', () => {
  type Err = Parameters<typeof jsonPointerOf>[0];
  it('required + missingProperty → instancePath/missingProperty', () => {
    expect(jsonPointerOf({ keyword: 'required', instancePath: '/run', params: { missingProperty: 'seed' } } as unknown as Err)).toBe('/run/seed');
  });
  it('required at the root → /missingProperty', () => {
    expect(jsonPointerOf({ keyword: 'required', instancePath: '', params: { missingProperty: 'mode' } } as unknown as Err)).toBe('/mode');
  });
  it('non-required keyword → instancePath verbatim', () => {
    expect(jsonPointerOf({ keyword: 'type', instancePath: '/symbols/0', params: {} } as unknown as Err)).toBe('/symbols/0');
  });
  it('required without a missingProperty → instancePath', () => {
    expect(jsonPointerOf({ keyword: 'required', instancePath: '/x', params: {} } as unknown as Err)).toBe('/x');
  });
});
