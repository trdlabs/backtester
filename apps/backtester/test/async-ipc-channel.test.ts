import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { AsyncIpcChannel } from '../src/engine/sandbox/async-ipc-channel.js';
import type { ResourceLimits } from '../src/engine/sandbox-policy.js';

const LIMITS = {
  maxDecisionBytes: 64,
  maxStdoutBytes: 4096,
  maxStderrBytes: 256,
} as unknown as ResourceLimits;

function mk() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const ch = new AsyncIpcChannel(stdin, stdout, stderr, LIMITS);
  return { ch, stdin, stdout, stderr };
}

describe('AsyncIpcChannel', () => {
  it('resolves an ok line and yields the event loop while waiting', async () => {
    const { ch, stdout } = mk();
    const p = ch.receive(Date.now() + 1000);
    let resolvedBeforeWrite = false;
    void p.then(() => { resolvedBeforeWrite = true; });
    // microtask checkpoint: receive must still be pending (proves it yielded, did not block)
    await Promise.resolve();
    expect(resolvedBeforeWrite).toBe(false);
    stdout.write('{"t":"ok","seq":1,"decisions":[]}\n');
    const out = await p;
    expect(out).toEqual({ kind: 'ok', seq: 1, decisions: [] });
  });

  it('times out when no line arrives by the deadline', async () => {
    const { ch } = mk();
    const out = await ch.receive(Date.now() - 1);
    expect(out.kind).toBe('timeout');
  });

  it('returns malformed for non-JSON', async () => {
    const { ch, stdout } = mk();
    const p = ch.receive(Date.now() + 1000);
    stdout.write('not json\n');
    expect((await p).kind).toBe('malformed');
  });

  it('returns malformed for a line over maxDecisionBytes', async () => {
    const { ch, stdout } = mk();
    const p = ch.receive(Date.now() + 1000);
    stdout.write(`${'x'.repeat(200)}\n`);
    expect((await p).kind).toBe('malformed');
  });

  it('returns eof when stdout ends before a line', async () => {
    const { ch, stdout } = mk();
    const p = ch.receive(Date.now() + 1000);
    stdout.end();
    expect((await p).kind).toBe('eof');
  });

  it('accumulates stderr into a bounded buffer', async () => {
    const { ch, stderr, stdout } = mk();
    stderr.write('boom');
    const p = ch.receive(Date.now() + 200);
    stdout.write('{"t":"ok","decisions":[]}\n');
    await p;
    expect(ch.stderrText()).toContain('boom');
  });

  it('truncates stderr beyond maxStderrBytes', async () => {
    const { ch, stderr, stdout } = mk();
    stderr.write('z'.repeat(400));
    const p = ch.receive(Date.now() + 200);
    stdout.write('{"t":"ok","decisions":[]}\n');
    await p;
    expect(ch.stderrText()).toContain('…[truncated]');
    expect(ch.stderrText().length).toBeLessThanOrEqual('z'.repeat(256).length + '…[truncated]'.length);
  });

  it('returns overflow when stderr floods beyond maxStderrBytes * 4', async () => {
    // maxStderrBytes = 256; flood threshold = 256 * 4 = 1024; write 1025 bytes → overflow
    const { ch, stderr } = mk();
    const p = ch.receive(Date.now() + 2000);
    stderr.write('e'.repeat(1025));
    const out = await p;
    expect(out.kind).toBe('overflow');
  });
});
