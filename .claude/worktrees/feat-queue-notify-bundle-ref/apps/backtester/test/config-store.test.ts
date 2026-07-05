import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

describe('store backend config', () => {
  it('defaults to filesystem when unset', () => {
    expect(loadConfig({}).storeBackend).toBe('filesystem');
    expect(loadConfig({}).s3).toBeUndefined();
  });

  it('parses a complete s3 config (MinIO defaults: forcePathStyle=true)', () => {
    const cfg = loadConfig({
      BACKTESTER_STORE_BACKEND: 's3',
      BACKTESTER_S3_ENDPOINT: 'http://minio:9000',
      BACKTESTER_S3_BUCKET: 'backtester',
      BACKTESTER_S3_ACCESS_KEY: 'ak',
      BACKTESTER_S3_SECRET_KEY: 'sk',
    });
    expect(cfg.storeBackend).toBe('s3');
    expect(cfg.s3).toEqual({
      endpoint: 'http://minio:9000',
      bucket: 'backtester',
      accessKeyId: 'ak',
      secretAccessKey: 'sk',
      forcePathStyle: true,
    });
  });

  it('honors forcePathStyle=false (AWS variant) and optional region', () => {
    const cfg = loadConfig({
      BACKTESTER_STORE_BACKEND: 's3',
      BACKTESTER_S3_ENDPOINT: 'https://s3.us-east-1.amazonaws.com',
      BACKTESTER_S3_BUCKET: 'b',
      BACKTESTER_S3_ACCESS_KEY: 'ak',
      BACKTESTER_S3_SECRET_KEY: 'sk',
      BACKTESTER_S3_REGION: 'us-east-1',
      BACKTESTER_S3_FORCE_PATH_STYLE: 'false',
    });
    expect(cfg.s3?.forcePathStyle).toBe(false);
    expect(cfg.s3?.region).toBe('us-east-1');
  });

  it('fail-fast when s3 selected but required settings are missing', () => {
    expect(() =>
      loadConfig({ BACKTESTER_STORE_BACKEND: 's3', BACKTESTER_S3_ENDPOINT: 'http://minio:9000' }),
    ).toThrow(/BACKTESTER_S3_BUCKET/);
  });

  it('rejects an unrecognized store backend value', () => {
    expect(() => loadConfig({ BACKTESTER_STORE_BACKEND: 'minio' })).toThrow(
      /invalid BACKTESTER_STORE_BACKEND/,
    );
  });

  it('accepts an explicit filesystem backend', () => {
    expect(loadConfig({ BACKTESTER_STORE_BACKEND: 'filesystem' }).storeBackend).toBe('filesystem');
  });
});
