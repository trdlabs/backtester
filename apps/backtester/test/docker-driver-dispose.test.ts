import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

const spawnCalls: string[][] = [];
const children: EventEmitter[] = [];
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    spawn: vi.fn((cmd: string, args: string[]) => {
      spawnCalls.push([cmd, ...args]);
      const child = new EventEmitter() as EventEmitter & { unref: () => void };
      child.unref = () => {};
      children.push(child);
      return child;
    }),
  };
});

const { DockerDriver } = await import('../src/engine/sandbox/docker-driver.js');

describe('DockerDriver.dispose', () => {
  beforeEach(() => { spawnCalls.length = 0; children.length = 0; });

  it('spawns kill first and rm only after kill closes (ordering preserved)', async () => {
    const driver = new DockerDriver();
    driver.dispose('bt-x');
    expect(spawnCalls).toEqual([['docker', 'kill', '-s', 'KILL', 'bt-x']]);
    children[0]!.emit('close', 0);
    await new Promise((r) => setImmediate(r));
    expect(spawnCalls[1]).toEqual(['docker', 'rm', '-f', 'bt-x']);
  });

  it('spawns rm when kill errors WITHOUT a close event (spawn failure path)', async () => {
    const driver = new DockerDriver();
    driver.dispose('bt-y');
    children[0]!.emit('error', new Error('spawn ENOENT')); // no 'close' follows
    await new Promise((r) => setImmediate(r));
    expect(spawnCalls[1]).toEqual(['docker', 'rm', '-f', 'bt-y']);
  });

  it('runs rm exactly once when kill emits both error and close (double-run guard)', async () => {
    const driver = new DockerDriver();
    driver.dispose('bt-z');
    children[0]!.emit('error', new Error('boom'));
    children[0]!.emit('close', 1);
    await new Promise((r) => setImmediate(r));
    const rmCalls = spawnCalls.filter((c) => c[1] === 'rm');
    expect(rmCalls).toHaveLength(1);
  });
});
