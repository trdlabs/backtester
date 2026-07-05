// DockerDriver.dispose — detached-shell teardown. Regression context: the previous JS-callback
// chain (kill.on('close') → spawn rm) lost the rm when the parent process exited right after
// close() (vitest workers do exactly that), leaking deterministically-named containers; the next
// spawn of the same name then failed with "Conflict: name already in use". One detached `sh -c`
// preserves kill→rm ordering inside the shell and survives parent exit.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

const spawnCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
const children: Array<EventEmitter & { unref: () => void }> = [];
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    spawn: vi.fn((cmd: string, args: string[], opts: Record<string, unknown>) => {
      spawnCalls.push({ cmd, args, opts });
      const child = new EventEmitter() as EventEmitter & { unref: () => void };
      child.unref = () => {};
      children.push(child);
      return child;
    }),
  };
});

const { DockerDriver } = await import('../src/engine/sandbox/docker-driver.js');

describe('DockerDriver.dispose (detached shell teardown)', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    children.length = 0;
  });

  it('spawns ONE detached sh -c chaining kill before rm (survives parent exit)', () => {
    new DockerDriver().dispose('bt-x');
    expect(spawnCalls).toHaveLength(1);
    const { cmd, args, opts } = spawnCalls[0]!;
    expect(cmd).toBe('sh');
    expect(args[0]).toBe('-c');
    const script = args[1]!;
    const killIdx = script.indexOf("docker kill -s KILL 'bt-x'");
    const rmIdx = script.indexOf("docker rm -f 'bt-x'");
    expect(killIdx).toBeGreaterThanOrEqual(0);
    expect(rmIdx).toBeGreaterThan(killIdx); // kill → rm ordering lives inside the shell
    expect(opts).toMatchObject({ detached: true, stdio: 'ignore' });
  });

  it('single-quotes the container name (shell-hostile input stays inert)', () => {
    new DockerDriver().dispose("bt-a'; touch /tmp/pwned; '");
    const script = spawnCalls[0]!.args[1]!;
    // The embedded single quotes are escaped as '\'' — the payload never leaves quoted context.
    expect(script).toContain(`'bt-a'\\''; touch /tmp/pwned; '\\'''`);
  });

  it('swallows spawn errors (best-effort teardown, never throws into close())', () => {
    new DockerDriver().dispose('bt-y');
    expect(() => children[0]!.emit('error', new Error('spawn ENOENT'))).not.toThrow();
  });
});
