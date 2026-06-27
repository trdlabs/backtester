import { pathToFileURL } from 'node:url';
import { exportSignerPublicKey } from '../src/evidence/export-signer-pubkey.js';

export { exportSignerPublicKey };

async function main(): Promise<void> {
  const pem = process.env.BT_EVIDENCE_SIGNING_KEY;
  const { keyId, publicKeyPem } = exportSignerPublicKey(pem);
  console.log(JSON.stringify({ keyId, publicKeyPem }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main();
}
