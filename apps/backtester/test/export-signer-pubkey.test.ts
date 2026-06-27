import { describe, expect, it } from 'vitest';
import { generateSigningKey } from '../src/evidence/signing.js';
import { exportSignerPublicKey } from '../src/evidence/export-signer-pubkey.js';

describe('exportSignerPublicKey', () => {
  it('returns correct keyId and publicKeyPem for a given private PEM', () => {
    const key = generateSigningKey();
    const pem = key.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const result = exportSignerPublicKey(pem);
    // keyId must match the key we generated (same derivation path)
    expect(result.keyId).toBe(key.keyId);
    expect(result.keyId).toMatch(/^bt-ed25519-[0-9a-f]{16}$/);
    expect(result.publicKeyPem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
  });

  it('is deterministic — same PEM produces identical output twice', () => {
    const key = generateSigningKey();
    const pem = key.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const first = exportSignerPublicKey(pem);
    const second = exportSignerPublicKey(pem);
    expect(first.keyId).toBe(second.keyId);
    expect(first.publicKeyPem).toBe(second.publicKeyPem);
  });

  it('generates a fresh well-formed key pair when called with no PEM (undefined)', () => {
    const result = exportSignerPublicKey(undefined);
    expect(result.keyId).toMatch(/^bt-ed25519-[0-9a-f]{16}$/);
    expect(result.publicKeyPem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
  });
});
