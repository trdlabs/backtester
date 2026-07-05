import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { produceEvidence } from '../scripts/produce-evidence.mjs';
import { verifySignedEvidenceLocal } from '../src/evidence/signing.js';

const PLATFORM_REPO = process.env.PLATFORM_REPO ?? '/home/alexxxnikolskiy/projects/trading-platform';
const VERIFIER = resolve(PLATFORM_REPO, 'src/admissions/verification/evidence-verifier.ts');

describe('produceEvidence harness (real long_oi fixture, in-process engine)', () => {
  it('produces a locally-verifiable signed artifact with a verdict from real metrics', async () => {
    const out = await produceEvidence({}); // uses generated dev key + default fixture
    expect(out.artifact.body.bundleHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(['passed', 'failed']).toContain(out.verdict);
    expect(out.artifactRef).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(verifySignedEvidenceLocal(out.artifact, { [out.keyId]: out.publicKeyPem }).ok).toBe(true);
  });

  it.skipIf(!existsSync(VERIFIER))('harness artifact verifies under the real platform verifySignedEvidence', async () => {
    const out = await produceEvidence({});
    const verify = (await import(pathToFileURL(VERIFIER).href)).verifySignedEvidence as
      (a: unknown, s: Record<string, string>) => { kind: string };
    const v = verify(out.artifact, { [out.keyId]: out.publicKeyPem });
    expect(v.kind).toBe('ok');
  });
});
