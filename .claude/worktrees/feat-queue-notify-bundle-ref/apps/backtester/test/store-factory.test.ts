import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { createArtifactStore, createBundleStore } from '../src/storage/stores';
import { FileArtifactStore } from '../src/artifacts/store';
import { FileBundleStore } from '../src/sandbox/bundle-store';
import { S3ArtifactStore } from '../src/artifacts/s3-store';
import { S3BundleStore } from '../src/sandbox/s3-bundle-store';
import { createFakeS3Client } from './support/fake-s3';

describe('store factory', () => {
  it('returns filesystem stores by default', async () => {
    const cfg = loadConfig({});
    expect(await createArtifactStore(cfg)).toBeInstanceOf(FileArtifactStore);
    expect(await createBundleStore(cfg)).toBeInstanceOf(FileBundleStore);
  });

  it('returns S3 stores when backend=s3, using the injected client', async () => {
    const cfg = loadConfig({
      BACKTESTER_STORE_BACKEND: 's3',
      BACKTESTER_S3_ENDPOINT: 'http://minio:9000',
      BACKTESTER_S3_BUCKET: 'b',
      BACKTESTER_S3_ACCESS_KEY: 'ak',
      BACKTESTER_S3_SECRET_KEY: 'sk',
    });
    const client = createFakeS3Client();
    expect(await createArtifactStore(cfg, client)).toBeInstanceOf(S3ArtifactStore);
    expect(await createBundleStore(cfg, client)).toBeInstanceOf(S3BundleStore);
  });
});
