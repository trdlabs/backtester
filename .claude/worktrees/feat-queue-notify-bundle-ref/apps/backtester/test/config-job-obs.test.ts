import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('BACKTESTER_JOB_OBS config', () => {
  it('defaults to false', () => {
    expect(loadConfig({ ...process.env, BACKTESTER_JOB_OBS: undefined } as NodeJS.ProcessEnv).jobObs).toBe(false);
  });
  it('is true only for the exact string "true"', () => {
    expect(loadConfig({ ...process.env, BACKTESTER_JOB_OBS: 'true' } as NodeJS.ProcessEnv).jobObs).toBe(true);
    expect(loadConfig({ ...process.env, BACKTESTER_JOB_OBS: '1' } as NodeJS.ProcessEnv).jobObs).toBe(false);
  });
});
