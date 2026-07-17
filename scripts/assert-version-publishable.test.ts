// Guards the fail-closed publishability classifier: only a confirmed E404 is
// "publishable"; an existing version or ANY indeterminate registry/network/auth
// outcome must NOT be treated as publishable.
import { describe, expect, it } from 'vitest';

import { classifyNpmView } from './assert-version-publishable';

describe('assert-version-publishable classifier', () => {
  it('confirmed E404 (missing version) is publishable', () => {
    expect(
      classifyNpmView({
        status: 1,
        stdout: '',
        stderr: 'npm error code E404\nnpm error 404 No match found for version 0.8.0',
      }),
    ).toBe('publishable');
  });

  it('existing version (clean success with output) is already-published', () => {
    expect(classifyNpmView({ status: 0, stdout: '0.8.0\n', stderr: '' })).toBe('already-published');
  });

  it('network error (ENOTFOUND) is indeterminate, not publishable', () => {
    expect(
      classifyNpmView({
        status: 1,
        stdout: '',
        stderr: 'npm error code ENOTFOUND\nnpm error request to https://registry.npmjs.org failed',
      }),
    ).toBe('indeterminate');
  });

  it('auth error (E401) is indeterminate, not publishable', () => {
    expect(
      classifyNpmView({ status: 1, stdout: '', stderr: 'npm error code E401\nnpm error Unable to authenticate' }),
    ).toBe('indeterminate');
  });

  it('registry 5xx is indeterminate, not publishable', () => {
    expect(
      classifyNpmView({ status: 1, stdout: '', stderr: 'npm error code E500\nnpm error 500 Internal Server Error' }),
    ).toBe('indeterminate');
  });

  it('status 0 but empty output is indeterminate (not a false publishable)', () => {
    expect(classifyNpmView({ status: 0, stdout: '\n', stderr: '' })).toBe('indeterminate');
  });
});
