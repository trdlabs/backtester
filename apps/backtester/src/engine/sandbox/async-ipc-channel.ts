// Event-driven async NDJSON channel over a container's child streams. Replaces SyncIpcChannel's
// blocking readSync + Atomics.wait poll: receive() awaits the next complete line (or deadline/eof),
// yielding the event loop so concurrent sessions overlap. One round-trip in flight at a time
// (session is strictly sequential), so a single data-waiter is sufficient.

import type { Readable, Writable } from 'node:stream';
import type { ResourceLimits } from '../sandbox-policy.js';
import type { Request, ReceiveOutcome } from './ipc.js';

export class AsyncIpcChannel {
  private stdoutAcc = '';
  private stdoutTotal = 0;
  private stderrBuf = '';
  private stderrTotal = 0;
  private eof = false;
  private errored = false;
  private overflow = false;
  private dataWaiter?: () => void;

  constructor(
    private readonly stdin: Writable,
    stdout: Readable,
    stderr: Readable,
    private readonly limits: ResourceLimits,
  ) {
    // A fire-and-forget send() can race container teardown; without this an EBADF/EPIPE on
    // stdin would surface as an UNCAUGHT 'error' and crash the host. Swallow it (the round-trip
    // fails via receive()'s eof/timeout path, which is the real signal).
    stdin.on('error', () => { /* late write after close — already handled via receive() */ });
    stdout.on('data', (chunk: Buffer) => {
      this.stdoutTotal += chunk.length;
      if (this.stdoutTotal > this.limits.maxStdoutBytes) {
        this.overflow = true;
        this.wake();
        return;
      }
      this.stdoutAcc += chunk.toString('utf8');
      this.wake();
    });
    stdout.on('end', () => { this.eof = true; this.wake(); });
    stdout.on('error', () => { this.errored = true; this.wake(); });
    stderr.on('data', (chunk: Buffer) => {
      this.stderrTotal += chunk.length;
      if (this.stderrBuf.length < this.limits.maxStderrBytes) {
        this.stderrBuf += chunk.toString('utf8');
        if (this.stderrBuf.length > this.limits.maxStderrBytes) {
          this.stderrBuf = `${this.stderrBuf.slice(0, this.limits.maxStderrBytes)}…[truncated]`;
        }
      }
      if (this.stderrTotal > this.limits.maxStderrBytes * 4) {
        this.overflow = true;
        this.wake();
      }
    });
  }

  private wake(): void {
    const w = this.dataWaiter;
    this.dataWaiter = undefined;
    w?.();
  }

  send(req: Request): void {
    this.stdin.write(`${JSON.stringify(req)}\n`);
  }

  stderrText(): string {
    return this.stderrBuf;
  }

  async receive(deadlineEpochMs: number): Promise<ReceiveOutcome> {
    for (;;) {
      if (this.overflow) return { kind: 'overflow' };
      const nl = this.stdoutAcc.indexOf('\n');
      if (nl >= 0) {
        const line = this.stdoutAcc.slice(0, nl);
        this.stdoutAcc = this.stdoutAcc.slice(nl + 1);
        if (Buffer.byteLength(line, 'utf8') > this.limits.maxDecisionBytes) {
          return { kind: 'malformed', detail: 'response line exceeds maxDecisionBytes' };
        }
        return this.parseLine(line);
      }
      if (this.stdoutAcc.length > this.limits.maxDecisionBytes * 2) {
        return { kind: 'malformed', detail: 'unterminated oversized response' };
      }
      if (this.eof || this.errored) return { kind: 'eof' };
      const remaining = deadlineEpochMs - Date.now();
      if (remaining <= 0) return { kind: 'timeout' };
      // No await between the buffer check above and registering the waiter → single-threaded,
      // no stream event can fire in between → no lost wakeup.
      const woke = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => { this.dataWaiter = undefined; resolve(false); }, remaining);
        this.dataWaiter = () => { clearTimeout(timer); resolve(true); };
      });
      if (!woke) return { kind: 'timeout' };
    }
  }

  private parseLine(line: string): ReceiveOutcome {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      return { kind: 'malformed', detail: 'response is not valid JSON' };
    }
    if (typeof obj !== 'object' || obj === null) {
      return { kind: 'malformed', detail: 'response is not an object' };
    }
    const rec = obj as Record<string, unknown>;
    if (rec.t === 'ok') {
      const decisions = Array.isArray(rec.decisions) ? (rec.decisions as unknown[]) : [];
      return { kind: 'ok', seq: typeof rec.seq === 'number' ? rec.seq : undefined, decisions };
    }
    if (rec.t === 'err') {
      return {
        kind: 'err',
        seq: typeof rec.seq === 'number' ? rec.seq : undefined,
        hook: typeof rec.hook === 'string' ? rec.hook : undefined,
        code: typeof rec.code === 'string' ? rec.code : 'sandbox_crashed',
        detail: typeof rec.detail === 'string' ? rec.detail : '',
      };
    }
    return { kind: 'malformed', detail: `unknown response envelope t=${String(rec.t)}` };
  }
}
