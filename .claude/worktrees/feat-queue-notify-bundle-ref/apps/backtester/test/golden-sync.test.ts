/**
 * Golden-sync gate (Initiative #1, Phase C).
 *
 * HARD (always runs, CI-safe): the vendored `platform-golden/MANIFEST.json` must match its committed
 * `.sha256` sidecar — detects tampering of the vendored copy.
 *
 * SOFT (cross-repo, skipped in CI): if the upstream platform golden is reachable (PLATFORM_REPO env
 * or default checkout path), it must be byte-identical to the vendored copy — detects drift. When the
 * platform repo is absent (the normal CI case), the cross-repo check is skipped, never failing.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const VENDORED_PATH = resolve(HERE, 'fixtures/platform-golden/MANIFEST.json');
const VENDORED_SHA_PATH = `${VENDORED_PATH}.sha256`;

const PLATFORM_REPO = process.env.PLATFORM_REPO ?? '/home/alexxxnikolskiy/projects/trading-platform';
const PLATFORM_GOLDEN_PATH = resolve(PLATFORM_REPO, 'test/fixtures/historical-golden/MANIFEST.json');

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

describe('golden-sync: vendored platform golden integrity', () => {
  it('vendored MANIFEST.json sha256 matches its committed .sha256 sidecar (tamper detection)', () => {
    const bytes = readFileSync(VENDORED_PATH);
    const expected = readFileSync(VENDORED_SHA_PATH, 'utf8').trim();
    expect(sha256Hex(bytes)).toBe(expected);
  });

  const platformReachable = existsSync(PLATFORM_GOLDEN_PATH);
  const crossRepo = platformReachable ? it : it.skip;

  crossRepo('vendored copy is byte-identical to upstream platform golden (drift detection)', () => {
    const vendored = readFileSync(VENDORED_PATH);
    const upstream = readFileSync(PLATFORM_GOLDEN_PATH);
    expect(vendored.equals(upstream)).toBe(true);
  });

  if (!platformReachable) {
    // eslint-disable-next-line no-console
    console.log(`[golden-sync] platform repo not reachable at ${PLATFORM_GOLDEN_PATH} — cross-repo drift check skipped (CI-safe).`);
  }
});
