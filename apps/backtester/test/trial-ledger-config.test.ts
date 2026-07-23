// research-validation-hardening R1(a) — BACKTESTER_TRIAL_LEDGER flips from dark-launch (default OFF,
// opt-in 'true') to research-contour default ON, opt-out via an explicit 'false'. Advisory-only (never
// part of resultHash; a ledger fault degrades to no trialContext, never fails the run), so defaulting
// it on is safe — see config.ts's `trialLedger` doc comment.

import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('trial ledger config default (research-validation-hardening R1a)', () => {
  it('defaults to ON when BACKTESTER_TRIAL_LEDGER is unset', () => {
    const c = loadConfig({} as NodeJS.ProcessEnv);
    expect(c.trialLedger).toBe(true);
  });

  it('stays ON when explicitly set to "true"', () => {
    const c = loadConfig({ BACKTESTER_TRIAL_LEDGER: 'true' } as NodeJS.ProcessEnv);
    expect(c.trialLedger).toBe(true);
  });

  it('turns OFF only on an explicit "false"', () => {
    const c = loadConfig({ BACKTESTER_TRIAL_LEDGER: 'false' } as NodeJS.ProcessEnv);
    expect(c.trialLedger).toBe(false);
  });

  it('treats any other value (typo-safe fail-open-to-advisory) as ON', () => {
    const c = loadConfig({ BACKTESTER_TRIAL_LEDGER: 'FALSE' } as NodeJS.ProcessEnv);
    expect(c.trialLedger).toBe(true);
  });
});
