// Rollout gate for slice 1b: confirm trading-lab's PINNED @trading-backtester/sdk client does not
// strict-reject a manifest carrying a bumped artifactContractVersion (022.1 -> 022.2). The
// baseline-trades artifact + version bump are additive; lab must tolerate the newer version.
// This inspects lab's actually-vendored SDK, not the backtester source (which is ahead at 0.8.0).
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const LAB_SDK = '/home/alexxxnikolskiy/projects/trdlabs/lab/node_modules/@trading-backtester/sdk';
if (!existsSync(LAB_SDK)) {
  console.error(`FAIL: lab vendored SDK not found at ${LAB_SDK} — run pnpm install in trading-lab first`);
  process.exit(2);
}

// Every occurrence of artifactContractVersion in the vendored SDK. The manifest read path
// (getArtifactManifest / readArtifact) must NOT throw or reject on a version mismatch.
let hits = '';
try {
  hits = execSync(`grep -rn "artifactContractVersion" ${LAB_SDK}/dist ${LAB_SDK}/src 2>/dev/null || true`, { encoding: 'utf8' });
} catch { /* grep exit 1 = no matches */ }

console.log('--- artifactContractVersion occurrences in lab vendored SDK ---');
console.log(hits || '(none)');

// Heuristic gate: fail if any occurrence looks like a strict rejection in a read path
// (a throw/return-error guarded by an artifactContractVersion comparison). A human/agent must
// confirm from the printed occurrences that the manifest getter passes the version through.
const suspicious = hits.split('\n').filter((l) =>
  /artifactContractVersion/.test(l) && /(throw|reject|!==|!=|assert|Unsupported|incompatible)/i.test(l),
);
if (suspicious.length > 0) {
  console.error('\nPOTENTIAL STRICT VERSION CHECK — inspect these before bumping:');
  console.error(suspicious.join('\n'));
  process.exit(1);
}
console.log('\nPASS: no strict artifactContractVersion rejection found in lab vendored SDK read path.');
