import { describe, expect, it } from 'vitest';
import {
  generateSigningKey, signEvidence, verifySignedEvidenceLocal, loadSigningKeyFromPem,
} from '../src/evidence/signing.js';

const BODY = {
  schema: 'backtest-evidence/v1', backtesterRunId: 'r1', bundleHash: 'sha256:ab',
  verdict: 'passed', datasetRef: 'ds', window: { fromMs: 1, toMs: 2 },
  symbols: ['AUSDT'], timeframe: '1m', keyId: 'placeholder',
};

describe('Ed25519 signing', () => {
  it('keyId is deterministic + bt-ed25519- prefixed', () => {
    const k = generateSigningKey();
    expect(k.keyId).toMatch(/^bt-ed25519-[0-9a-f]{16}$/);
    expect(loadSigningKeyFromPem(k.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string).keyId)
      .toBe(k.keyId);
  });
  it('sign → local verify roundtrip succeeds', () => {
    const k = generateSigningKey();
    const body = { ...BODY, keyId: k.keyId };
    const artifact = signEvidence(body, k.privateKey);
    expect(typeof artifact.signature).toBe('string');
    expect(verifySignedEvidenceLocal(artifact, { [k.keyId]: k.publicKeyPem }).ok).toBe(true);
  });
  it('rejects a corrupted body', () => {
    const k = generateSigningKey();
    const artifact = signEvidence({ ...BODY, keyId: k.keyId }, k.privateKey);
    const tampered = { ...artifact, body: { ...artifact.body, verdict: 'failed' } };
    expect(verifySignedEvidenceLocal(tampered, { [k.keyId]: k.publicKeyPem }).ok).toBe(false);
  });
  it('rejects an unknown keyId', () => {
    const k = generateSigningKey();
    const artifact = signEvidence({ ...BODY, keyId: k.keyId }, k.privateKey);
    expect(verifySignedEvidenceLocal(artifact, {}).ok).toBe(false);
  });
});
