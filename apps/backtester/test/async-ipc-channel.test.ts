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

  // P3-3: stderr is a bounded diagnostic tail, NOT an overflow trigger. A stderr flood must be
  // truncated to the tail and MUST NOT fail the run (was: overflow at maxStderrBytes * 4).
  it('P3-3: stderr flood is bounded to the tail, not fatal (no overflow)', async () => {
    const { ch, stderr, stdout } = mk();
    const p = ch.receive(Date.now() + 2000);
    stderr.write('e'.repeat(4096)); // far beyond maxStderrBytes and the old *4 threshold
    stdout.write('{"t":"ok","seq":7,"decisions":[]}\n'); // a valid reply still arrives
    const out = await p;
    expect(out.kind).toBe('ok'); // the flood did not poison the round-trip
    expect(ch.stderrText().length).toBeLessThanOrEqual(256 + '…[truncated]'.length);
  });

  // P3-3: a long legitimate run emits many small frames whose CUMULATIVE bytes far exceed
  // maxStdoutBytes. Each frame is released after parsing, so the run must never overflow.
  it('P3-3: a long run whose cumulative stdout exceeds maxStdoutBytes never overflows', async () => {
    const { ch, stdout } = mk();
    let total = 0;
    // 200 frames × ~34 B ≈ 6.8 KiB > maxStdoutBytes (4096); each frame ≤ maxDecisionBytes (64)
    for (let seq = 0; seq < 200; seq++) {
      const p = ch.receive(Date.now() + 1000);
      const frame = `{"t":"ok","seq":${seq},"decisions":[]}\n`;
      total += Buffer.byteLength(frame, 'utf8');
      stdout.write(frame);
      const out = await p;
      expect(out.kind).toBe('ok');
    }
    expect(total).toBeGreaterThan(4096); // proves we sailed past the OLD cumulative cap
  });

  // P3-3: an unterminated stream (no newline) past the live-buffer cap is bounded → overflow.
  it('P3-3: an unterminated stream past the buffer cap returns overflow', async () => {
    const { ch, stdout } = mk();
    const p = ch.receive(Date.now() + 2000);
    stdout.write('x'.repeat(5000)); // > bufferCap (max(4096, 64*2)=4096), no newline
    const out = await p;
    expect(out.kind).toBe('overflow');
  });
});