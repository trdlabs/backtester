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

  it('overlay doc documents apply + OverlayDecision', () => {
    expect(OVERLAY_AUTHORING_DOC).toContain('apply');
    expect(OVERLAY_AUTHORING_DOC).toContain('veto');
  });

  it('getAuthoringDoc dispatches by kind', () => {
    expect(getAuthoringDoc('strategy')).toBe(STRATEGY_AUTHORING_DOC);
    expect(getAuthoringDoc('overlay')).toBe(OVERLAY_AUTHORING_DOC);
  });
});
