// Content-addressed artifact store + manifest builder (022, MVP subset).
//
// Heavy bytes live OUTSIDE the job DB, keyed by `sha256:` of their canonical-JSON encoding. The job
// keeps only the manifest (descriptors + content-hashes). Slice 1 ships a local-filesystem store and
// an in-memory store (tests); an object-store adapter slots in behind the same interface later.

import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  ArtifactDescriptor,
  ArtifactManifest,
  ArtifactReference,
  ContentHash,
} from '@trading/research-contracts';
import { ARTIFACT_CONTRACT_VERSION, CONTRACT_VERSION } from '@trading/research-contracts';
import { canonicalJson } from '../determinism/canonical-json';
import { contentRef } from '../determinism/hash';
import type { BacktestResult } from '../runner/run-backtest';

export interface ArtifactStore {
  write(payload: unknown): Promise<ContentHash>;
  read(ref: ContentHash): Promise<unknown>;
  has(ref: ContentHash): Promise<boolean>;
}

function hexOf(ref: ContentHash): string {
  return ref.slice('sha256:'.length);
}

export class FileArtifactStore implements ArtifactStore {
  constructor(private readonly baseDir: string) {}

  private pathFor(ref: ContentHash): string {
    return resolve(this.baseDir, `${hexOf(ref)}.json`);
  }

  async write(payload: unknown): Promise<ContentHash> {
    const ref = contentRef(payload);
    await mkdir(this.baseDir, { recursive: true });
    await writeFile(this.pathFor(ref), canonicalJson(payload), 'utf8');
    return ref;
  }

  async read(ref: ContentHash): Promise<unknown> {
    return JSON.parse(await readFile(this.pathFor(ref), 'utf8'));
  }

  async has(ref: ContentHash): Promise<boolean> {
    try {
      await access(this.pathFor(ref));
      return true;
    } catch {
      return false;
    }
  }
}

export class InMemoryArtifactStore implements ArtifactStore {
  private readonly blobs = new Map<ContentHash, string>();

  async write(payload: unknown): Promise<ContentHash> {
    const ref = contentRef(payload);
    this.blobs.set(ref, canonicalJson(payload));
    return ref;
  }

  async read(ref: ContentHash): Promise<unknown> {
    const raw = this.blobs.get(ref);
    if (raw === undefined) throw new Error(`artifact not found: ${ref}`);
    return JSON.parse(raw);
  }

  async has(ref: ContentHash): Promise<boolean> {
    return this.blobs.has(ref);
  }
}

export interface PersistedArtifacts {
  readonly manifest: ArtifactManifest;
  readonly artifactRefs: readonly ArtifactReference[];
}

interface ArtifactSpec {
  readonly artifactType: string;
  readonly payload: unknown;
  readonly itemCount?: number;
}

/** Build, write, and describe the per-run artifacts (run-summary, metrics, trades). */
export async function persistRunArtifacts(
  store: ArtifactStore,
  result: BacktestResult,
  datasetFingerprint: string,
): Promise<PersistedArtifacts> {
  const specs: ArtifactSpec[] = [
    {
      artifactType: 'run-summary',
      payload: {
        runId: result.runId,
        status: result.status,
        runKind: result.runKind,
        metrics: result.metrics,
        evidence: { ...result.evidence, datasetFingerprint },
      },
    },
    { artifactType: 'metrics', payload: result.metrics },
    { artifactType: 'trades', payload: result.trades, itemCount: result.trades.length },
  ];

  const descriptors: ArtifactDescriptor[] = [];
  const artifactRefs: ArtifactReference[] = [];
  for (const spec of [...specs].sort((a, b) => a.artifactType.localeCompare(b.artifactType))) {
    const contentHash = await store.write(spec.payload);
    descriptors.push({
      artifactType: spec.artifactType,
      contentHash,
      availability: 'available',
      ...(spec.itemCount !== undefined ? { approxItemCount: spec.itemCount } : {}),
    });
    artifactRefs.push({
      artifactId: contentHash,
      artifactType: spec.artifactType,
      availability: 'available',
      ...(spec.itemCount !== undefined ? { approxItemCount: spec.itemCount } : {}),
    });
  }

  return {
    manifest: {
      runId: result.runId,
      contractVersion: CONTRACT_VERSION,
      artifactContractVersion: ARTIFACT_CONTRACT_VERSION,
      descriptors,
    },
    artifactRefs,
  };
}
