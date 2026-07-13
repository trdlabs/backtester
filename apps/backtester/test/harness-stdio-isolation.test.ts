// P1-4: the untrusted bundle shares the harness process, so it shares process.stdin / process.stdout /
// console. isolateStdio (deny-shims) captures a private write handle for the NDJSON protocol, neuters
// the public stdout write + console.* so the bundle can't inject/​corrupt the stream, and hands the
// bundle a dead stdin so it can't peek the request wire (a batch/bar-major envelope carries FUTURE
// bars → a process.stdin.on('data') listener would be a structural look-ahead). See CODE-REVIEW-2026-07-12.md P1-4.

import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { isolateStdio } from '../sandbox-harness-overlay/deny-shims.mjs';

function fakeStdout() {
  const writes: string[] = [];
  return { writes, write(s: string) { writes.push(s); return true; } };
}

describe('isolateStdio (harness stdio isolation)', () => {
  it('neuters the public stdout write but returns a private handle the harness keeps using', () => {
    const stdout = fakeStdout();
    const proc = { stdout, stdin: new Readable({ read() {} }) } as never;
    const con: Record<string, unknown> = { log() {}, error() {} };
    const { realWrite } = isolateStdio(proc, con) as { realWrite: (s: string) => boolean };

    // bundle path: process.stdout.write is now a no-op — nothing reaches the sink.
    (proc as unknown as { stdout: { write: (s: string) => boolean } }).stdout.write('FORGED\n');
    expect(stdout.writes).toEqual([]);

    // harness path: the captured real handle still reaches the sink.
    realWrite('{"t":"ok","seq":1}\n');
    expect(stdout.writes).toEqual(['{"t":"ok","seq":1}\n']);
  });

  it('routes console.* to a no-op (a logging bundle cannot corrupt the NDJSON stream)', () => {
    const con: Record<string, () => void> = { log() { throw new Error('not neutered'); }, warn() { throw new Error('x'); } };
    isolateStdio({ stdout: fakeStdout(), stdin: new Readable({ read() {} }) } as never, con);
    expect(() => con.log()).not.toThrow();
    expect(() => con.warn()).not.toThrow();
  });

  it('swaps process.stdin for a dead stream so the bundle cannot peek the request wire', () => {
    const realStdin = new Readable({ read() {} });
    const dead = new Readable({ read() {} });
    dead.push(null);
    const proc = { stdout: fakeStdout(), stdin: realStdin } as never;
    isolateStdio(proc, {} as never, { deadStdin: dead });
    // The bundle now sees the dead stream, not the real fd-0 stream the harness reads from.
    expect((proc as unknown as { stdin: Readable }).stdin).toBe(dead);
    expect((proc as unknown as { stdin: Readable }).stdin).not.toBe(realStdin);
  });

  it('is a no-op on stdin when no deadStdin is provided (keeps the real stream)', () => {
    const realStdin = new Readable({ read() {} });
    const proc = { stdout: fakeStdout(), stdin: realStdin } as never;
    isolateStdio(proc, {} as never);
    expect((proc as unknown as { stdin: Readable }).stdin).toBe(realStdin);
  });
});
