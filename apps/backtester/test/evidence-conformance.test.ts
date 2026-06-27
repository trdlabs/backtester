// apps/backtester/test/evidence-conformance.test.ts
// Load-bearing: proves our signed artifact verifies under the ACTUAL platform function, not a local mirror.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateSigningKey, signEvidence } from '../src/evidence/signing.js';
import { buildEvidenceBody } from '../src/evidence/body.js';

const PLATFORM_REPO = process.env.PLATFORM_REPO ?? '/home/alexxxnikolskiy/projects/trading-platform';
const VERIFIER = resolve(PLATFORM_REPO, 'src/admissions/verification/evidence-verifier.ts');

async function loadPlatformVerify(): Promise<(a: unknown, s: Record<string, string>) => { kind: string }> {
  const mod = await import(pathToFileURL(VERIFIER).href);
  return mod.verifySignedEvidence;
}

const SCOPE = { datasetRef: 'long_oi-2026-06', window: { fromMs: 1781291247232, toMs: 1781804581980 }, symbols: ['HUSDT', 'NOTUSDT'], timeframe: '1m' };

describe('043 conformance — platform verifySignedEvidence accepts our artifact', () => {
  it.skipIf(!existsSync(VERIFIER))('verdict:ok for a well-formed signed artifact', async () => {
    const verify = await loadPlatformVerify();
    const k = generateSigningKey();
    const body = buildEvidenceBody({ backtesterRunId: 'rt-1', bundleHash: 'sha256:' + 'a'.repeat(64), verdict: 'passed', scope: SCOPE, keyId: k.keyId });
    const artifact = signEvidence(body, k.privateKey);
    const v = verify(artifact, { [k.keyId]: k.publicKeyPem });
    expect(v.kind).toBe('ok');
    expect((v as unknown as { verdict: string }).verdict).toBe('passed');
  });
  it.skipIf(!existsSync(VERIFIER))('signature_invalid on tampered body (empty-array edge case preserved)', async () => {
    const verify = await loadPlatformVerify();
    const k = generateSigningKey();
    const body = buildEvidenceBody({ backtesterRunId: 'rt-2', bundleHash: 'sha256:' + 'b'.repeat(64), verdict: 'failed', scope: { ...SCOPE, symbols: [] }, keyId: k.keyId });
    const artifact = signEvidence(body, k.privateKey);
    const tampered = { ...artifact, body: { ...artifact.body, datasetRef: 'other' } };
    expect(verify(tampered, { [k.keyId]: k.publicKeyPem }).kind).toBe('signature_invalid');
  });
  it.skipIf(!existsSync(VERIFIER))('signature_invalid on unknown keyId', async () => {
    const verify = await loadPlatformVerify();
    const k = generateSigningKey();
    const artifact = signEvidence(buildEvidenceBody({ backtesterRunId: 'rt-3', bundleHash: 'sha256:' + 'c'.repeat(64), verdict: 'passed', scope: SCOPE, keyId: k.keyId }), k.privateKey);
    expect(verify(artifact, {}).kind).toBe('signature_invalid');
  });
});
