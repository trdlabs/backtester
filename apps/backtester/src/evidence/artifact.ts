import { createHash } from 'node:crypto';
import { canonicalizeEvidenceBody } from './canonical.js';

/** Deterministic on-disk bytes for the artifact (canonical, so the content-hash ref is stable). */
export function serializeArtifact(artifact: { body: unknown; signature: string }): Uint8Array {
  return Buffer.from(canonicalizeEvidenceBody(artifact), 'utf8');
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Content-hash locator for the evidence artifact (entry in evidence.artifactRefs). */
export function artifactRef(bytes: Uint8Array): string {
  return `sha256:${sha256Hex(bytes)}`;
}

/** sha256 of raw bundle bytes — same form the platform ExternalArtifactSource re-hashes (triple-hash). */
export function sha256BundleRef(bytes: Uint8Array): string {
  return `sha256:${sha256Hex(bytes)}`;
}
