import {
  generateKeyPairSync, createPublicKey, createPrivateKey, createHash,
  sign as cryptoSign, verify as cryptoVerify, type KeyObject,
} from 'node:crypto';
import { canonicalizeEvidenceBody } from './canonical.js';

export interface SigningKey {
  readonly keyId: string;
  readonly privateKey: KeyObject;
  readonly publicKeyPem: string;
}

export type TrustedSigners = Readonly<Record<string, string>>;

/** Stable keyId from the SPKI DER of the public key. */
export function deriveKeyId(publicKey: KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return 'bt-ed25519-' + createHash('sha256').update(der).digest('hex').slice(0, 16);
}

export function generateSigningKey(): SigningKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    keyId: deriveKeyId(publicKey),
    privateKey,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) as string,
  };
}

export function loadSigningKeyFromPem(privateKeyPem: string): SigningKey {
  const privateKey = createPrivateKey(privateKeyPem);
  const publicKey = createPublicKey(privateKey);
  return {
    keyId: deriveKeyId(publicKey),
    privateKey,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) as string,
  };
}

/** Detached Ed25519 signature (base64) over canonical(body). */
export function signEvidence<T>(body: T, privateKey: KeyObject): { body: T; signature: string } {
  const signature = cryptoSign(null, Buffer.from(canonicalizeEvidenceBody(body), 'utf8'), privateKey)
    .toString('base64');
  return { body, signature };
}

/** Local mirror of the platform verifier — for fast unit feedback only (NOT the conformance gate). */
export function verifySignedEvidenceLocal(
  artifact: { body: unknown; signature: string },
  trustedSigners: TrustedSigners,
): { ok: boolean } {
  const keyId = (artifact.body as { keyId?: string }).keyId;
  const pem = keyId ? trustedSigners[keyId] : undefined;
  if (!pem) return { ok: false };
  try {
    const ok = cryptoVerify(
      null,
      Buffer.from(canonicalizeEvidenceBody(artifact.body), 'utf8'),
      createPublicKey(pem),
      Buffer.from(artifact.signature, 'base64'),
    );
    return { ok };
  } catch {
    return { ok: false };
  }
}
