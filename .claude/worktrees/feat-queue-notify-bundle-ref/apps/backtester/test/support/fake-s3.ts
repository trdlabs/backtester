import type { S3ObjectClient } from '../../src/storage/s3-client';

/** In-memory S3ObjectClient double — the adapters' contract, no AWS/MinIO required. */
export function createFakeS3Client(store: Map<string, string> = new Map()): S3ObjectClient {
  return {
    async put(key, body) {
      store.set(key, body);
    },
    async get(key) {
      return store.get(key);
    },
    async head(key) {
      return store.has(key);
    },
  };
}
