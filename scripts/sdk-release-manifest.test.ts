import { describe, expect, it } from 'vitest';
import { releaseManifest } from './sdk-release-manifest';

describe('SDK release manifest', () => {
  it('records package version, source SHA and asset checksum', () => {
    expect(releaseManifest({
      version: '0.1.0',
      sourceSha: 'abc123',
      asset: 'trdlabs-backtester-sdk-0.1.0.tgz',
      sha256: 'f'.repeat(64),
    })).toEqual({
      package: '@trdlabs/backtester-sdk',
      version: '0.1.0',
      sourceSha: 'abc123',
      asset: 'trdlabs-backtester-sdk-0.1.0.tgz',
      sha256: 'f'.repeat(64),
    });
  });
});
