// Env-driven store factory. Default 'filesystem' → host-local File*Store (dev/CI byte-identical).
// 's3' → S3-compatible adapter. `injected` is the test seam (production passes nothing and the
// factory builds a real client via createS3ObjectClient).

import type { AppConfig } from '../config';
import { FileArtifactStore, type ArtifactStore } from '../artifacts/store';
import { FileBundleStore, type BundleStore } from '../sandbox/bundle-store';
import { S3ArtifactStore } from '../artifacts/s3-store';
import { S3BundleStore } from '../sandbox/s3-bundle-store';
import { createS3ObjectClient, type S3ObjectClient } from './s3-client';

async function s3ClientFor(config: AppConfig, injected?: S3ObjectClient): Promise<S3ObjectClient> {
  if (injected) return injected;
  if (!config.s3) throw new Error("store backend 's3' selected but s3 settings are missing");
  return createS3ObjectClient(config.s3);
}

export async function createArtifactStore(
  config: AppConfig,
  injected?: S3ObjectClient,
): Promise<ArtifactStore> {
  if (config.storeBackend === 's3') return new S3ArtifactStore(await s3ClientFor(config, injected));
  return new FileArtifactStore(config.artifactsDir);
}

export async function createBundleStore(
  config: AppConfig,
  injected?: S3ObjectClient,
): Promise<BundleStore> {
  if (config.storeBackend === 's3') return new S3BundleStore(await s3ClientFor(config, injected));
  return new FileBundleStore(config.bundlesDir);
}
