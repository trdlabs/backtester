// P1-5: the server's validateBundle and the SDK's preflightValidateBundle MUST agree on which bundle
// file paths are safe. They drifted: the server used a substring `key.includes('..')` (wrongly rejects
// `a..b.js`, wrongly ACCEPTS backslash/colon/NUL), the SDK used a stricter segment-exact predicate.
// After the fix both call the SAME shared `isUnsafeBundlePath`. See CODE-REVIEW-2026-07-12.md P1-5.

import { describe, expect, it } from 'vitest';
import type { ModuleBundle } from '@trading/research-contracts';
import { createModuleManifest, preflightValidateBundle } from '@trading-backtester/sdk/builder';
import { validateBundle } from '../src/sandbox/bundle.js';

const ENTRY = 'module.mjs';

function bundleWithFile(key: string): ModuleBundle {
  return {
    manifest: createModuleManifest({
      id: 'pp',
      version: '1.0.0',
      kind: 'strategy',
      name: 'path-parity',
      summary: 'Structurally valid stub for path-parity tests.',
      rationale: 'Exercises the shared unsafe-path predicate.',
      hooks: ['onBarClose'],
      paramsSchema: { type: 'object' },
      capabilities: { platformSdk: true },
      dataNeeds: { closedCandlesUpToCurrent: true },
    }),
    entry: ENTRY,
    files: { [ENTRY]: 'export function init(){return {}} export function computeSignals(){return []}', [key]: 'x' },
  } as ModuleBundle;
}

/** The server flags a file path via code bundle_entrypoint_invalid + `invalid file path: <key>`. */
function serverRejectsPath(key: string): boolean {
  return validateBundle(bundleWithFile(key)).some(
    (i) => i.code === 'bundle_entrypoint_invalid' && i.message.includes(`invalid file path: ${key}`),
  );
}

/** The SDK flags a file path via code bundle_entrypoint_invalid with path === key. */
function sdkRejectsPath(key: string): boolean {
  return preflightValidateBundle(bundleWithFile(key), { engine: 'strategy' }).issues.some(
    (i) => i.code === 'bundle_entrypoint_invalid' && i.path === key,
  );
}

// [path, expectedRejected]
const CASES: Array<[string, boolean]> = [
  ['sub/ok.js', false], // plain nested path — safe
  ['a..b.js', false], // dots inside a segment — SAFE (the substring check wrongly rejected this)
  ['a.b.c.js', false],
  ['..', true], // parent-dir segment
  ['../x.js', true],
  ['lib/../y.js', true], // traversal mid-path
  ['./x.js', true], // current-dir segment
  ['/abs.js', true], // absolute
  ['a\\b.js', true], // backslash (Windows separator) — server substring check MISSED this
  ['C:x.js', true], // drive-letter colon — server MISSED this
  ['a\0b.js', true], // NUL byte — server MISSED this
];

describe('bundle file-path validation parity (server ⇔ SDK)', () => {
  for (const [key, expectRejected] of CASES) {
    const label = JSON.stringify(key);
    it(`server matches SDK and expectation for ${label}`, () => {
      const server = serverRejectsPath(key);
      const sdk = sdkRejectsPath(key);
      expect(server, `server vs SDK disagree on ${label}`).toBe(sdk);
      expect(server, `server verdict for ${label}`).toBe(expectRejected);
    });
  }
});

describe('server validates the entry path (parity with SDK)', () => {
  it('rejects an unsafe entry path', () => {
    const bundle = {
      manifest: createModuleManifest({
        id: 'pp',
        version: '1.0.0',
        kind: 'strategy',
        name: 'path-parity',
        summary: 'stub',
        rationale: 'stub',
        hooks: ['onBarClose'],
        paramsSchema: { type: 'object' },
        capabilities: { platformSdk: true },
        dataNeeds: { closedCandlesUpToCurrent: true },
      }),
      entry: '../evil.mjs',
      files: { '../evil.mjs': 'x' },
    } as ModuleBundle;
    expect(validateBundle(bundle).some((i) => i.code === 'bundle_entrypoint_invalid')).toBe(true);
  });
});
