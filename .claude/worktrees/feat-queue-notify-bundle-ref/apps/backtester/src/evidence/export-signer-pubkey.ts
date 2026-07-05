import {
  generateSigningKey,
  loadSigningKeyFromPem,
} from './signing.js';

/**
 * Derive `{ keyId, publicKeyPem }` from an existing Ed25519 private-key PEM,
 * or generate a fresh ephemeral key if none is supplied.
 *
 * Pass the returned `{ keyId, publicKeyPem }` to the platform operator so they
 * can add this signer to their `trustedSigners[keyId]` allowlist.
 */
export function exportSignerPublicKey(pem?: string): { keyId: string; publicKeyPem: string } {
  const key = pem ? loadSigningKeyFromPem(pem) : generateSigningKey();
  return { keyId: key.keyId, publicKeyPem: key.publicKeyPem };
}
