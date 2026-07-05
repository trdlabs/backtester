import type { ContentHash } from '../internal/shared-types';

export type { ContentHash };

export type ArtifactAvailability = 'available' | 'unavailable' | 'not_applicable';

export interface ArtifactReference {
  readonly artifactId: ContentHash;
  readonly artifactType: string;
  readonly availability: ArtifactAvailability;
  readonly approxItemCount?: number;
}

export interface ArtifactDescriptor {
  readonly artifactType: string;
  readonly contentHash: ContentHash;
  readonly availability: ArtifactAvailability;
  readonly approxItemCount?: number;
}

export interface ArtifactManifest {
  readonly runId: string;
  readonly contractVersion: string;
  readonly artifactContractVersion: string;
  readonly descriptors: readonly ArtifactDescriptor[];
}

export interface ArtifactPage {
  readonly artifactId: ContentHash;
  readonly artifactType: string;
  readonly page: readonly unknown[];
  readonly total: number;
  readonly offset: number;
  readonly nextCursor?: string;
}
