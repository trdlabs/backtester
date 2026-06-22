// Characterization tests for validatePromotion — the forward-only status-promotion gate (017,
// FR-029/030/031). Coverage flagged it at ~12%. Pure function; pins the FSM (research_only →
// reviewed → promoted, exactly one step) and the evidence + approved-review requirement. No source
// change.

import { describe, expect, it } from 'vitest';
import type { PromotionRequest } from '@trading/research-contracts/research';
import { validatePromotion } from '../src/engine/validation/validate-promotion';

const base: PromotionRequest = {
  moduleRef: { id: 'm', version: '1.0.0' },
  fromStatus: 'research_only',
  toStatus: 'reviewed',
  evidenceRef: 'ev-1',
  reviewDecision: { decision: 'approved' },
};

describe('validation/validate-promotion — validatePromotion', () => {
  it('accepts a one-step forward transition with evidence + approved review (and attaches normalized)', () => {
    const r = validatePromotion({ promotion: base });
    expect(r.status).toBe('accepted');
    expect('normalized' in r).toBe(true);
  });

  it('rejects a non-object promotion at the root path', () => {
    const r = validatePromotion({ promotion: null as unknown as PromotionRequest });
    expect(r.status).toBe('rejected');
    expect(r.issues).toContainEqual(expect.objectContaining({ code: 'schema_invalid', path: '' }));
    expect('normalized' in r).toBe(false);
  });

  it('flags a structurally invalid moduleRef', () => {
    const r = validatePromotion({ promotion: { ...base, moduleRef: { id: '', version: '' } } });
    expect(r.status).toBe('rejected');
    expect(r.issues).toContainEqual(expect.objectContaining({ code: 'schema_invalid', path: '/moduleRef' }));
  });

  it('rejects a transition that skips a step (forward-only, exactly one step)', () => {
    const r = validatePromotion({ promotion: { ...base, fromStatus: 'research_only', toStatus: 'promoted' } });
    expect(r.status).toBe('rejected');
    expect(r.issues).toContainEqual(expect.objectContaining({ code: 'schema_invalid', path: '/toStatus' }));
  });

  it('requires an evidenceRef', () => {
    const r = validatePromotion({ promotion: { ...base, evidenceRef: undefined } });
    expect(r.status).toBe('rejected');
    expect(r.issues).toContainEqual(expect.objectContaining({ code: 'promotion_requires_review', path: '/evidenceRef' }));
  });

  it('requires an explicit approved review', () => {
    const r = validatePromotion({ promotion: { ...base, reviewDecision: { decision: 'rejected' } } });
    expect(r.status).toBe('rejected');
    expect(r.issues).toContainEqual(expect.objectContaining({ code: 'promotion_requires_review', path: '/reviewDecision' }));
  });

  it('flags out-of-set fromStatus and toStatus', () => {
    const r = validatePromotion({
      promotion: { ...base, fromStatus: 'bogus' as never, toStatus: 'nope' as never },
    });
    expect(r.status).toBe('rejected');
    expect(r.issues).toContainEqual(expect.objectContaining({ code: 'schema_invalid', path: '/fromStatus' }));
    expect(r.issues).toContainEqual(expect.objectContaining({ code: 'schema_invalid', path: '/toStatus' }));
  });
});
