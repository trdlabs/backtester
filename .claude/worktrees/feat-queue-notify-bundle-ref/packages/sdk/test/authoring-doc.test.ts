import { describe, expect, it } from 'vitest';
import { AUTHORING_DOC_VERSION, getAuthoringDoc, OVERLAY_AUTHORING_DOC, STRATEGY_AUTHORING_DOC } from '../src/builder/index';

describe('authoring docs', () => {
  it('exposes a version', () => {
    expect(AUTHORING_DOC_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('strategy doc documents the entry convention and both phases', () => {
    expect(STRATEGY_AUTHORING_DOC).toContain('export default function createStrategyModule');
    expect(STRATEGY_AUTHORING_DOC).toContain('onBarClose');
    expect(STRATEGY_AUTHORING_DOC).toContain('onPositionBar');
    expect(STRATEGY_AUTHORING_DOC).toContain('bundleContractVersion');
  });

  it('strategy doc documents the runtime market-tape API (methods, not fields)', () => {
    // the four core methods + reading types
    expect(STRATEGY_AUTHORING_DOC).toContain('oiAsOf');
    expect(STRATEGY_AUTHORING_DOC).toContain('oiWindow');
    expect(STRATEGY_AUTHORING_DOC).toContain('liqAsOf');
    expect(STRATEGY_AUTHORING_DOC).toContain('liqWindow');
    expect(STRATEGY_AUTHORING_DOC).toContain('FundingReading');
    expect(STRATEGY_AUTHORING_DOC).toContain('TakerReading');
    // point shapes
    expect(STRATEGY_AUTHORING_DOC).toContain('oiTotalUsd');
    // gap semantics: undefined vs covered-zero must be called out
    expect(STRATEGY_AUTHORING_DOC).toContain('covered-no-events');
    // before/after anti-pattern: the nonexistent field the LLM guessed
    expect(STRATEGY_AUTHORING_DOC).toContain('ctx.market.openInterest');
  });

  it('renders without template-literal escaping artifacts (no literal backslash-backtick)', () => {
    // toContain checks above use substrings and would NOT catch a mis-escaped backtick.
    // The rendered doc an LLM sees must contain real backticks, never the literal sequence backslash-backtick.
    expect(getAuthoringDoc('strategy')).not.toContain('\\`');
    expect(getAuthoringDoc('overlay')).not.toContain('\\`');
  });

  it('documents that sizingHint is a number, not an object', () => {
    expect(STRATEGY_AUTHORING_DOC).toContain('sizingHint');
    expect(STRATEGY_AUTHORING_DOC).toContain('a **number**');
    // the exact anti-pattern an LLM emitted (object form) must be called out
    expect(STRATEGY_AUTHORING_DOC).toContain('sizingHint: { multiplier: 1.5 }');
  });

  it('bumps the authoring doc version (dataNeeds catalog + decision-union completeness)', () => {
    expect(AUTHORING_DOC_VERSION).toBe('1.3.0');
  });

  it('overlay doc documents apply + OverlayDecision', () => {
    expect(OVERLAY_AUTHORING_DOC).toContain('apply');
    expect(OVERLAY_AUTHORING_DOC).toContain('veto');
  });

  it('getAuthoringDoc dispatches by kind', () => {
    expect(getAuthoringDoc('strategy')).toBe(STRATEGY_AUTHORING_DOC);
    expect(getAuthoringDoc('overlay')).toBe(OVERLAY_AUTHORING_DOC);
  });
});
