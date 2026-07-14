// Event-driven async NDJSON channel over a container's child streams. Replaces SyncIpcChannel's
// blocking readSync + Atomics.wait poll: receive() awaits the next complete line (or deadline/eof),
// yielding the event loop so concurrent sessions overlap. One round-trip in flight at a time
// (session is strictly sequential), so a single data-waiter is sufficient.

import type { Readable, Writable } from 'node:stream';
import type { ResourceLimits } from '../sandbox-policy.js';
import type { Request, ReceiveOutcome } from './ipc.js';

export class AsyncIpcChannel {
  private stdoutAcc = '';
  // stderr is retained as RAW BYTES (not per-chunk decoded): a multibyte UTF-8 code point split across
  // two data-chunks would decode to U+FFFD if each chunk were toString()'d in isolation. We concat and
  // decode once in stderrText(), so chunk boundaries never mangle a character.
  private readonly stderrChunks: Buffer[] = [];
  private stderrBytes = 0; // total retained bytes (bounded by maxStderrBytes — a BYTE quota, FR-020)
  private stderrTruncated = false;
  private eof = false;
  private errored = false;
  private overflow = false;
  private dataWaiter?: () => void;
  // P3-3: live-buffer high-water. stdout is bounded PER-FRAME (maxDecisionBytes, in receive) and
  // PER-BUFFER (this), NOT cumulatively over the session — each parsed frame releases its bytes when
  // receive() slices it off. Sized to admit one max frame plus slack, so a long legitimate run whose
  // total emitted bytes dwarf maxStdoutBytes never trips the anti-flood overflow.
  private readonly bufferCap: number;

  constructor(
    private readonly stdin: Writable,
    stdout: Readable,
    stderr: Readable,
    private readonly limits: ResourceLimits,
  ) {
    this.bufferCap = Math.max(limits.maxStdoutBytes, limits.maxDecisionBytes * 2);
    // A fire-and-forget send() can race container teardown; without this an EBADF/EPIPE on
    // stdin would surface as an UNCAUGHT 'error' and crash the host. Swallow it (the round-trip
    // fails via receive()'s eof/timeout path, which is the real signal).
    stdin.on('error', () => { /* late write after close — already handled via receive() */ });
    stdout.on('data', (chunk: Buffer) => {
      if (this.overflow) return; // already tripped — stop growing the buffer
      this.stdoutAcc += chunk.toString('utf8');
      // Anti-flood cap on the LIVE unparsed buffer (not a lifetime total): trip ONLY when the buffer
      // exceeds bufferCap AND still has no newline — i.e. an unterminated flood. A completed frame
      // (newline present), however oversized, is left for receive() to classify as `malformed` via
      // the maxDecisionBytes check; a flood is not a frame, so it is `overflow`.
      if (Buffer.byteLength(this.stdoutAcc, 'utf8') > this.bufferCap && this.stdoutAcc.indexOf('\n') < 0) {
        this.overflow = true;
      }
      this.wake();
    });
    stdout.on('end', () => { this.eof = true; this.wake(); });
    stdout.on('error', () => { this.errored = true; this.wake(); });
    stderr.on('data', (chunk: Buffer) => {
      // stderr is a bounded diagnostic TAIL, never an overflow trigger — diagnostics must not fail a
      // run. Retain RAW bytes bounded by maxStderrBytes (a byte quota); decoding to a boundary-safe
      // string is deferred to stderrText(). A byte-cut mid-sequence is fine here — the trailing partial
      // code point is trimmed at decode time.
      if (this.stderrTruncated) return;
      const room = this.limits.maxStderrBytes - this.stderrBytes;
      if (room <= 0) { this.stderrTruncated = true; return; }
      const take = chunk.length <= room ? chunk : chunk.subarray(0, room);
      this.stderrChunks.push(take);
      this.stderrBytes += take.length;
      if (take.length < chunk.length) this.stderrTruncated = true;
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
    // Concat the raw chunks and decode ONCE — a code point split across chunk boundaries is now whole.
    // Then drop a trailing partial code point left by the byte-cap cut, so the decode never yields a
    // U+FFFD replacement and the returned tail stays within the byte quota.
    const buf = Buffer.concat(this.stderrChunks, this.stderrBytes);
    const text = completeUtf8Prefix(buf).toString('utf8');
    return this.stderrTruncated ? `${text}…[truncated]` : text;
  }

  async receive(deadlineEpochMs: number): Promise<ReceiveOutcome> {
    for (;;) {
      // A completed frame is classified FIRST — before the overflow check — so a completed-but-oversized
      // frame (newline present, even if the whole buffer exceeds bufferCap) surfaces as `malformed` via
      // the maxDecisionBytes check, never as `overflow`. Only an UNTERMINATED buffer reaches overflow.
      const nl = this.stdoutAcc.indexOf('\n');
      if (nl >= 0) {
        const line = this.stdoutAcc.slice(0, nl);
        this.stdoutAcc = this.stdoutAcc.slice(nl + 1);
        if (Buffer.byteLength(line, 'utf8') > this.limits.maxDecisionBytes) {
          return { kind: 'malformed', detail: 'response line exceeds maxDecisionBytes' };
        }
        return this.parseLine(line);
      }
      if (this.overflow || Buffer.byteLength(this.stdoutAcc, 'utf8') > this.bufferCap) {
        // Unterminated flood past bufferCap: a flood is not a frame, so it is `overflow`, not `malformed`.
        return { kind: 'overflow' };
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
    return parseResponseLine(line);
  }
}

/** Returns `buf` with a trailing INCOMPLETE UTF-8 code point (if any) dropped, so decoding the result
 *  never emits a U+FFFD replacement at a byte-cap cut. A code point split across chunk boundaries is
 *  already whole here (the chunks were concatenated before this call); only the final byte-capped cut
 *  can leave a partial trailer. */
function completeUtf8Prefix(buf: Buffer): Buffer {
  // Count trailing continuation bytes (0b10xxxxxx), then look at the lead byte before them.
  let cont = 0;
  let i = buf.length - 1;
  while (i >= 0 && (buf[i] & 0xc0) === 0x80) { cont++; i--; }
  if (i < 0) return buf; // all continuation / empty — nothing sensible to trim
  const lead = buf[i];
  let expected: number;
  if ((lead & 0x80) === 0x00) expected = 1; // ASCII
  else if ((lead & 0xe0) === 0xc0) expected = 2;
  else if ((lead & 0xf0) === 0xe0) expected = 3;
  else if ((lead & 0xf8) === 0xf0) expected = 4;
  else return buf; // invalid lead — leave as-is (harness garbage, not our concern to normalize)
  // The final sequence is complete iff it already has all its bytes; otherwise drop the partial trailer.
  return cont + 1 >= expected ? buf : buf.subarray(0, i);
}

/** Parses one NDJSON response line (harness → host) into a `ReceiveOutcome`. Exported (rather than
 *  kept as a private method) so the tagged-envelope parsing — including the strict okBarMajor
 *  per-entry validation below — is directly unit-testable without standing up a channel. */
export function parseResponseLine(line: string): ReceiveOutcome {
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
  if (rec.t === 'okBatch') {
    // 17b — stoppedAt MUST be numeric (it drives host-side bar-bookkeeping rewind); anything else
    // is malformed rather than silently coerced (a garbage stoppedAt would desync the resend
    // boundary between host and harness).
    if (typeof rec.stoppedAt !== 'number') {
      return { kind: 'malformed', detail: 'okBatch response missing numeric stoppedAt' };
    }
    const decisions = Array.isArray(rec.decisions) ? (rec.decisions as unknown[]) : [];
    return {
      kind: 'okBatch',
      seq: typeof rec.seq === 'number' ? rec.seq : undefined,
      stoppedAt: rec.stoppedAt,
      decisions,
    };
  }
  if (rec.t === 'okBarMajor') {
    if (!Array.isArray(rec.results)) {
      return { kind: 'malformed', detail: 'okBarMajor response missing results array' };
    }
    const results: ({ ok: true; decisions: unknown[] } | { ok: false; error: { code: string; detail: string } })[] = [];
    for (const raw of rec.results as unknown[]) {
      if (typeof raw !== 'object' || raw === null) {
        return { kind: 'malformed', detail: 'okBarMajor result entry is not an object' };
      }
      const e = raw as Record<string, unknown>;
      const err = e.error as Record<string, unknown> | undefined;
      if (e.ok === true && Array.isArray(e.decisions)) {
        results.push({ ok: true, decisions: e.decisions as unknown[] });
      } else if (
        e.ok === false && typeof e.error === 'object' && e.error !== null &&
        typeof err!.code === 'string' && typeof err!.detail === 'string'
      ) {
        // STRICT: a false entry is valid ONLY with string code AND string detail — no defaulting, so a
        // harness/protocol bug can't be silently laundered into a normal per-symbol error.
        results.push({ ok: false, error: { code: err!.code as string, detail: err!.detail as string } });
      } else {
        return { kind: 'malformed', detail: 'okBarMajor result entry is not a valid tagged ok/err variant' };
      }
    }
    return { kind: 'okBarMajor', seq: typeof rec.seq === 'number' ? rec.seq : undefined, results };
  }
  if (rec.t === 'err') {
    return {
      kind: 'err',
      seq: typeof rec.seq === 'number' ? rec.seq : undefined,
      hook: typeof rec.hook === 'string' ? rec.hook : undefined,
      code: typeof rec.code === 'string' ? rec.code : 'sandbox_crashed',
      detail: typeof rec.detail === 'string' ? rec.detail : '',
      barOffset: typeof rec.barOffset === 'number' ? rec.barOffset : undefined,
    };
  }
  return { kind: 'malformed', detail: `unknown response envelope t=${String(rec.t)}` };
}
