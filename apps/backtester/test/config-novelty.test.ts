import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('novelty config (E5a)', () => {
  it('defaults off with 0.80 / 30', () => {
    const cfg = loadConfig({} as NodeJS.ProcessEnv);
    expect(cfg.novelty).toBe(false);
    expect(cfg.noveltyCorrThreshold).toBe(0.8);
    expect(cfg.noveltyMinOverlapDays).toBe(30);
  });
  it('enables only for exact "true" and parses custom values', () => {
    const cfg = loadConfig({
      BACKTESTER_NOVELTY_ENABLED: 'true',
      BACKTESTER_NOVELTY_CORR_THRESHOLD: '0.7',
      BACKTESTER_NOVELTY_MIN_OVERLAP_DAYS: '50',
    } as NodeJS.ProcessEnv);
    expect(cfg.novelty).toBe(true);
    expect(cfg.noveltyCorrThreshold).toBe(0.7);
    expect(cfg.noveltyMinOverlapDays).toBe(50);
  });
  it('fail-fast when enabled with a bad threshold or overlap', () => {
    expect(() => loadConfig({ BACKTESTER_NOVELTY_ENABLED: 'true', BACKTESTER_NOVELTY_CORR_THRESHOLD: '1.5' } as NodeJS.ProcessEnv)).toThrow(/CORR_THRESHOLD/);
    expect(() => loadConfig({ BACKTESTER_NOVELTY_ENABLED: 'true', BACKTESTER_NOVELTY_CORR_THRESHOLD: '-0.1' } as NodeJS.ProcessEnv)).toThrow(/CORR_THRESHOLD/);
    expect(() => loadConfig({ BACKTESTER_NOVELTY_ENABLED: 'true', BACKTESTER_NOVELTY_MIN_OVERLAP_DAYS: '0' } as NodeJS.ProcessEnv)).toThrow(/MIN_OVERLAP_DAYS/);
    expect(() => loadConfig({ BACKTESTER_NOVELTY_ENABLED: 'true', BACKTESTER_NOVELTY_MIN_OVERLAP_DAYS: '2.5' } as NodeJS.ProcessEnv)).toThrow(/MIN_OVERLAP_DAYS/);
  });
  it('disabled + bad values → no throw AND no NaN (normalized to defaults)', () => {
    const cfg = loadConfig({ BACKTESTER_NOVELTY_CORR_THRESHOLD: 'abc', BACKTESTER_NOVELTY_MIN_OVERLAP_DAYS: 'xyz' } as NodeJS.ProcessEnv);
    expect(cfg.novelty).toBe(false);
    expect(cfg.noveltyCorrThreshold).toBe(0.8);
    expect(cfg.noveltyMinOverlapDays).toBe(30);
  });
});
