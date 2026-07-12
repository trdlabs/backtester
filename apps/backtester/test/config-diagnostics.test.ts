import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('run-diagnostics config (E1b)', () => {
  it('defaults off with 30/80 thresholds', () => {
    const cfg = loadConfig({} as NodeJS.ProcessEnv);
    expect(cfg.runDiagnostics).toBe(false);
    expect(cfg.diagMinTrades).toBe(30);
    expect(cfg.diagConcentrationPct).toBe(80);
  });
  it('enables only for exact "true"', () => {
    expect(loadConfig({ BACKTESTER_RUN_DIAGNOSTICS: 'true' } as NodeJS.ProcessEnv).runDiagnostics).toBe(true);
    expect(loadConfig({ BACKTESTER_RUN_DIAGNOSTICS: '1' } as NodeJS.ProcessEnv).runDiagnostics).toBe(false);
  });
  it('reads custom thresholds', () => {
    const cfg = loadConfig({
      BACKTESTER_DIAG_MIN_TRADES: '50',
      BACKTESTER_DIAG_CONCENTRATION_PCT: '90',
    } as NodeJS.ProcessEnv);
    expect(cfg.diagMinTrades).toBe(50);
    expect(cfg.diagConcentrationPct).toBe(90);
  });
  it('preserves an explicit 0 (operator policy: disable underpowered / max concentration sensitivity)', () => {
    const cfg = loadConfig({
      BACKTESTER_DIAG_MIN_TRADES: '0',
      BACKTESTER_DIAG_CONCENTRATION_PCT: '0',
    } as NodeJS.ProcessEnv);
    expect(cfg.diagMinTrades).toBe(0);
    expect(cfg.diagConcentrationPct).toBe(0);
  });
  it('falls back to defaults on garbage / blank (only undefined/NaN, not a valid 0)', () => {
    const cfg = loadConfig({
      BACKTESTER_DIAG_MIN_TRADES: 'abc',
      BACKTESTER_DIAG_CONCENTRATION_PCT: '  ',
    } as NodeJS.ProcessEnv);
    expect(cfg.diagMinTrades).toBe(30);
    expect(cfg.diagConcentrationPct).toBe(80);
  });
  it('clamps negatives up to 0', () => {
    const cfg = loadConfig({
      BACKTESTER_DIAG_MIN_TRADES: '-5',
      BACKTESTER_DIAG_CONCENTRATION_PCT: '-1',
    } as NodeJS.ProcessEnv);
    expect(cfg.diagMinTrades).toBe(0);
    expect(cfg.diagConcentrationPct).toBe(0);
  });
});
