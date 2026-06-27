import { describe, expect, it } from 'vitest';
import { serializeArtifact, artifactRef, sha256BundleRef } from '../src/evidence/artifact.js';

const artifact = { body: { b: 1, a: 2 }, signature: 'sig==' };

describe('artifact serialization + refs', () => {
  it('serialization is deterministic (stable across key order)', () => {
    const a = serializeArtifact({ body: { b: 1, a: 2 }, signature: 'sig==' });
    const b = serializeArtifact({ signature: 'sig==', body: { a: 2, b: 1 } });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
  it('artifactRef is sha256:<64hex> and content-addressed', () => {
    const ref = artifactRef(serializeArtifact(artifact));
    expect(ref).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(artifactRef(serializeArtifact(artifact))).toBe(ref); // stable
  });
  it('sha256BundleRef matches the platform bundle-resolver form', () => {
    // sha256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    expect(sha256BundleRef(Buffer.from('abc'))).toBe(
      'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
