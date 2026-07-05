// Docker-gated pin for the container-leak regression: dispose() must ACTUALLY remove the named
// container (the fire-and-forget JS-chain version silently never ran `docker rm` when the parent
// process exited early — 48 leaked containers on the dev box). No child_process mock here on
// purpose (mocks are file-scoped; this file needs the real thing).
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { DockerDriver } from '../src/engine/sandbox/docker-driver.js';
import { SANDBOX_IMAGE } from '../src/engine/sandbox-policy.js';
import { DOCKER_AVAILABLE } from './store-factories.js';

const NAME = `sbx-dispose-leak-pin-${process.pid}`;

function containerExists(name: string): boolean {
  const r = spawnSync('docker', ['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}'], {
    encoding: 'utf8',
  });
  return r.stdout.trim() === name;
}

describe.skipIf(!DOCKER_AVAILABLE)('DockerDriver.dispose removes the container (Docker)', () => {
  it('a disposed container disappears from docker ps -a', async () => {
    // Use the pinned sandbox image (guaranteed present on machines that run Docker suites).
    const run = spawnSync(
      'docker',
      ['run', '-d', '--name', NAME, SANDBOX_IMAGE, 'sleep', '30'],
      { encoding: 'utf8' },
    );
    expect(run.status, run.stderr).toBe(0);
    expect(containerExists(NAME)).toBe(true);

    new DockerDriver().dispose(NAME);

    // Detached shell needs a moment; poll up to 15s.
    const deadline = Date.now() + 15_000;
    while (containerExists(NAME) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(containerExists(NAME)).toBe(false);
  }, 30_000);
});
