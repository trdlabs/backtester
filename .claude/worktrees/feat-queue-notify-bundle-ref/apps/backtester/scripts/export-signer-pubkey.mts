import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { exportSignerPublicKey } from '../src/evidence/export-signer-pubkey.js';

export { exportSignerPublicKey };

function main(): void {
  const pem = process.env.BT_EVIDENCE_SIGNING_KEY;
  const { keyId, publicKeyPem } = exportSignerPublicKey(pem);
  const json = JSON.stringify({ keyId, publicKeyPem }, null, 2);
  console.log(json);

  // Optional --output <path>: write the JSON to a file in addition to stdout.
  const outputIdx = process.argv.indexOf('--output');
  if (outputIdx !== -1) {
    const outputPath = process.argv[outputIdx + 1];
    if (!outputPath) {
      console.error('--output requires a path argument');
      process.exit(1);
    }
    writeFileSync(outputPath, json + '\n', 'utf8');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
