// P1-4: the untrusted bundle shares the harness process, so it shares process.stdin / process.stdout /
// console. isolateStdio (deny-shims) captures a PRIVATE write handle for the NDJSON protocol, then
// REPLACES + LOCKS process.stdout with a discard sink and process.stdin with a dead stream — so the
// bundle can neither inject/​corrupt the protocol stream (even via delete / prototype-chain tricks) nor
// peek the request wire (batch/bar-major look-ahead). See CODE-REVIEW-2026-07-12.md P1-4 (+ review).

import { describe, expect, it } from 'vitest';
import { Readable, Writable } from 'node:stream';
import { isolateStdio } from '../sandbox-harness-overlay/deny-shims.mjs';

/** Plain recorder standing in for the REAL fd-1 stream (what realWrite must target). */
function recorder(): { writes: string[]; write(s: string): boolean } {
  return { writes: [], write(s: string) { this.writes.push(s); return true; } };
}
const discardSink = (): Writable => new Writable({ write(_c, _e, cb) { cb(); } });
const deadStdin = (): Readable => { const r = new Readable({ read() {} }); r.push(null); return r; };

describe('isolateStdio (harness stdio isolation)', () => {
  it('replaces + LOCKS process.stdout so the bundle cannot reach fd 1, even via delete / prototype', () => {
    const realOut = recorder();
    const sink = discardSink();
    const proc = { stdout: realOut, stdin: deadStdin() } as never;
    const { realWrite } = isolateStdio(proc, { log() {} }, { sink, deadStdin: deadStdin() }) as {
      realWrite: (s: string) => boolean;
    };

    const p = proc as unknown as { stdout: Writable };
    // The public stdout is now the sink (a DIFFERENT object than the real fd-1 stream) and is locked.
    expect(p.stdout).toBe(sink);
    expect(p.stdout).not.toBe(realOut as unknown as Writable);
    const desc = Object.getOwnPropertyDescriptor(proc, 'stdout')!;
    expect(desc.writable).toBe(false);
    expect(desc.configurable).toBe(false);

    // Bundle attacks all land on the sink, never on the real fd-1 recorder:
    p.stdout.write('FORGED_direct\n');
    delete (p.stdout as { write?: unknown }).write; // write is inherited → delete is a no-op
    p.stdout.write?.('FORGED_afterdelete\n');
    (Writable.prototype.write as (this: unknown, s: string) => unknown).call(p.stdout, 'FORGED_proto\n'); // direct prototype-method call

    // The harness's private handle still reaches the real fd; nothing forged got through.
    realWrite('{"t":"ok","seq":1}\n');
    expect(realOut.writes).toEqual(['{"t":"ok","seq":1}\n']);
  });

  it('routes console.* to a no-op (a logging bundle cannot inject into fd 1 via console)', () => {
    const con: Record<string, () => void> = { log() { throw new Error('not neutered'); }, warn() { throw new Error('x'); } };
    isolateStdio({ stdout: recorder(), stdin: deadStdin() } as never, con, { sink: discardSink(), deadStdin: deadStdin() });
    expect(() => con.log()).not.toThrow();
    expect(() => con.warn()).not.toThrow();
  });

  it('replaces + LOCKS process.stdin with the dead stream so the bundle cannot peek the request wire', () => {
    const realStdin = new Readable({ read() {} });
    const dead = deadStdin();
    const proc = { stdout: recorder(), stdin: realStdin } as never;
    isolateStdio(proc, {} as never, { sink: discardSink(), deadStdin: dead });
    const p = proc as unknown as { stdin: Readable };
    expect(p.stdin).toBe(dead);
    expect(p.stdin).not.toBe(realStdin);
    const desc = Object.getOwnPropertyDescriptor(proc, 'stdin')!;
    expect(desc.writable).toBe(false);
    expect(desc.configurable).toBe(false);
  });

  it('throws (so the harness fails closed) if process.stdout cannot be locked', () => {
    const proc = { stdout: recorder(), stdin: deadStdin() } as never;
    // Pre-lock stdout non-configurable so the swap defineProperty must throw.
    Object.defineProperty(proc, 'stdout', { value: (proc as { stdout: unknown }).stdout, writable: false, configurable: false });
    expect(() => isolateStdio(proc, {} as never, { sink: discardSink(), deadStdin: deadStdin() })).toThrow();
  });
});
